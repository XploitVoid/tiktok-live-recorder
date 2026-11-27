import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users, VolumeX, Volume2, ArrowUpRight } from 'lucide-react'
import { fmtViewers } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { loadPlayers } from '@/lib/players'
import { normalizePlatform, safeImageUrl } from '@/lib/utils'
import { PlatformBadge } from '@/components/PlatformBadge'
import type { CheckResult } from '@/lib/types'

interface GridTileProps {
  entry: CheckResult
  quality: string
  muted: boolean
  preferHls?: boolean
}

interface PickedStream {
  url: string
  kind: 'flv' | 'hls' | 'dash'
  quality: string
}

function pickStream(entry: CheckResult, qPref: string, preferHls = false): PickedStream | null {
  const hlsMap = entry.streams?.hlsByQuality || {}
  const hlsOrder = qPref === 'hd'
    ? ['hd_60', 'hd', 'sd', 'ld', 'origin', 'uhd_60', 'uhd']
    : ['ld', 'sd', 'hd', 'hd_60', 'origin', 'uhd']
  if (preferHls) {
    for (const q of hlsOrder) if (hlsMap[q]) return { url: hlsMap[q], kind: 'hls', quality: q }
    if (entry.streams?.hls) return { url: entry.streams.hls, kind: 'hls', quality: 'auto' }
  }
  const f = entry.streams?.flv || {}
  const order = qPref === 'hd' ? ['hd', 'origin', 'uhd', 'sd', 'ld'] : ['ld', 'sd', 'hd', 'origin', 'uhd']
  for (const q of order) if (f[q]) return { url: f[q], kind: 'flv', quality: q }
  for (const q of hlsOrder) if (hlsMap[q]) return { url: hlsMap[q], kind: 'hls', quality: q }
  if (entry.streams?.hls) return { url: entry.streams.hls, kind: 'hls', quality: 'auto' }
  const cmaf = entry.streams?.cmaf || {}
  for (const q of order) if (cmaf[q]) return { url: cmaf[q], kind: 'dash', quality: q }
  const firstCmaf = Object.entries(cmaf).find(([, u]) => !!u)
  if (firstCmaf) return { url: firstCmaf[1], kind: 'dash', quality: firstCmaf[0] }
  return null
}

// eslint-disable-next-line react-refresh/only-export-components
export function hasPlayableGridStream(entry: CheckResult, quality: string, preferHls = false): boolean {
  return pickStream(entry, quality, preferHls) !== null
}

const GRID_FLV_CONFIG = {
  enableWorker: false,
  enableStashBuffer: true,
  stashInitialSize: 128,
  lazyLoad: false,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 20,
  autoCleanupMinBackwardDuration: 10,
  fixAudioTimestampGap: true,
}

export function GridTile({ entry, quality, muted, preferHls = false }: GridTileProps) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [mutedOverride, setMutedOverride] = useState<{ prop: boolean; val: boolean } | null>(null)
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null)
  const localMuted = mutedOverride && mutedOverride.prop === muted ? mutedOverride.val : muted

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = localMuted
  }, [localMuted])

  const pick = pickStream(entry, quality, preferHls)
  const pickedUrl = pick?.url ?? ''
  const pickedKind = pick?.kind ?? ''
  const pickedQ = pick?.quality ?? ''
  const platform = normalizePlatform(entry.platform)
  // Keep latest entry/url in refs so Twitch rotating Usher session tokens on
  // 60s refreshes don't tear down and re-buffer an actively playing tile.
  const latestUrlRef = useRef(pickedUrl)
  const latestEntryRef = useRef(entry)
  useEffect(() => {
    latestUrlRef.current = pickedUrl
    latestEntryRef.current = entry
  }, [pickedUrl, entry])

  const streamKey = pick
    ? `${platform}:${entry.username}:${pickedKind}:${pickedQ}:${platform === 'twitch' ? 'live' : pickedUrl}`
    : ''

  useEffect(() => {
    const video = videoRef.current
    if (!video || !streamKey) return

    const players: { destroy: () => void }[] = []
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const MAX_RETRIES = 3
    let retries = 0
    let cancelled = false

    const onPlaying = () => {
      retries = 0
    }
    video.addEventListener('playing', onPlaying)

    const onNativeMeta = () => {
      if (!cancelled) video.play().catch(() => {})
    }

    const clearNativeVideo = () => {
      video.onerror = null
      video.removeEventListener('loadedmetadata', onNativeMeta)
      try { video.pause() } catch { /* ignore */ }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
    }

    const scheduleRetry = (fn: () => void, onGiveUp?: () => void) => {
      if (cancelled || retryTimer !== null) return
      if (retries >= MAX_RETRIES) {
        onGiveUp?.()
        return
      }
      retries++
      const delay = Math.min(10_000, 1500 * Math.pow(2, retries - 1))
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (!cancelled) fn()
      }, delay)
    }

    // Load player libs lazily so the Grid page no longer pays the full
    // hls.js + flv.js download cost on initial render of the empty grid.
    loadPlayers().then(() => {
      if (cancelled) return
      attachPlayer()
    }).catch((e) => {
      console.error('player libs failed to load:', e)
    })

    function attachPlayer() {
      if (!video) return
      const flvLib = window.flvjs
      const hlsLib = window.Hls
      let activeUrl = latestUrlRef.current
      let activeKind = pickedKind

      // If FLV was chosen but flv.js CDN failed to load, try HLS fallback
      if (activeKind === 'flv' && (!flvLib || !flvLib.isSupported())) {
        const hlsFallback = pickStream(latestEntryRef.current, quality, true)
        if (hlsFallback?.kind === 'hls') {
          activeUrl = hlsFallback.url
          activeKind = 'hls'
        }
      }
      if (!activeUrl) return

      const getFreshUrl = (kind: string) => {
        if (kind === 'hls' && pickedKind !== 'hls') {
          return pickStream(latestEntryRef.current, quality, true)?.url || activeUrl
        }
        return latestUrlRef.current || activeUrl
      }

      if (flvLib && flvLib.isSupported() && (activeKind === 'flv' || activeKind === 'dash')) {
        const mediaSource = activeKind === 'dash'
          ? {
              type: 'flv',
              url: '/api/transcode?url=' + encodeURIComponent(activeUrl),
              isLive: true,
              cors: true,
              hasAudio: true,
              hasVideo: true,
            }
          : {
              type: 'flv',
              url: '/api/proxy?url=' + encodeURIComponent(activeUrl),
              isLive: true,
              cors: true,
            }
        const p = flvLib.createPlayer(mediaSource, GRID_FLV_CONFIG)
        p.attachMediaElement(video); p.load(); p.play().catch(() => {})
        p.on(flvLib.Events.ERROR, () => {
          scheduleRetry(
            () => {
              try { p.unload(); p.load(); p.play().catch(() => {}) } catch { /* give up */ }
            },
            () => {
              try { p.destroy() } catch { /* ignore */ }
              const idx = players.indexOf(p)
              if (idx !== -1) players.splice(idx, 1)
            },
          )
        })
        players.push(p)
      } else if (hlsLib && hlsLib.isSupported() && activeKind === 'hls') {
        const p = new hlsLib({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 })
        p.loadSource('/api/proxy?url=' + encodeURIComponent(activeUrl))
        p.attachMedia(video)
        p.on(hlsLib.Events.MANIFEST_PARSED, () => {
          if (!cancelled) video.play().catch(() => {})
        })
        p.on(hlsLib.Events.ERROR, (...args: unknown[]) => {
          const data = args[1] as { fatal?: boolean; type?: string } | undefined
          if (!data?.fatal) return
          scheduleRetry(
            () => {
              try {
                if (data.type === hlsLib.ErrorTypes.NETWORK_ERROR) {
                  const freshUrl = getFreshUrl('hls')
                  if (freshUrl) {
                    p.loadSource('/api/proxy?url=' + encodeURIComponent(freshUrl))
                  } else {
                    p.startLoad()
                  }
                } else {
                  p.recoverMediaError()
                }
              } catch { /* give up */ }
            },
            () => {
              try { p.destroy() } catch { /* ignore */ }
              const idx = players.indexOf(p)
              if (idx !== -1) players.splice(idx, 1)
            },
          )
        })
        players.push(p)
      } else if (activeKind === 'hls' && Boolean(video.canPlayType('application/vnd.apple.mpegurl'))) {
        video.src = '/api/proxy?url=' + encodeURIComponent(activeUrl)
        video.addEventListener('loadedmetadata', onNativeMeta)
        video.play().catch(() => {})
        video.onerror = () => {
          scheduleRetry(
            () => {
              try {
                const freshUrl = getFreshUrl('hls')
                if (freshUrl) {
                  video.src = '/api/proxy?url=' + encodeURIComponent(freshUrl)
                }
                video.load()
                video.play().catch(() => { /* ignore */ })
              } catch { /* ignore */ }
            },
            clearNativeVideo,
          )
        }
      }
    }

    return () => {
      cancelled = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      video.onerror = null
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('loadedmetadata', onNativeMeta)
      for (const p of players) { try { p.destroy() } catch { /* ignore */ } }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
    }
  }, [streamKey, pickedKind, quality])

  const toggleMute = () => {
    setMutedOverride({ prop: muted, val: !localMuted })
  }

  // Match original behavior: hide tile entirely if no playable stream exists.
  if (!pick) return null

  const avatarUrl = safeImageUrl(entry.owner?.avatarThumb || entry.coverUrl) || ''
  const showAvatar = !!avatarUrl && failedAvatarUrl !== avatarUrl

  return (
    <div className="bg-card rounded-xl overflow-hidden flex flex-col border border-border h-full">
      <div className="relative bg-black w-full aspect-video cursor-pointer group shrink-0">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          autoPlay
          playsInline
          muted={localMuted}
        />
        <div className="absolute top-2 left-2 flex items-center gap-1.5 z-10">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600/90 backdrop-blur-sm shadow-lg shadow-red-600/30 text-white">
            <span className="w-1.5 h-1.5 rounded-full bg-white inline-block" /> LIVE
          </span>
          {pickedQ && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-black/50 backdrop-blur-sm text-slate-300">
              {pickedQ}
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2 z-10">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono tabular-nums bg-black/65 backdrop-blur-sm text-zinc-200 border border-white/10">
            <Users className="w-2.5 h-2.5" /> {fmtViewers(entry.viewerCount)}
          </span>
        </div>
        <div className="absolute inset-0 flex items-end p-2.5 z-10 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity bg-gradient-to-t from-black/70 via-transparent to-transparent">
          <div className="flex items-center gap-2 w-full">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleMute() }}
              className="w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 border border-white/15 backdrop-blur flex items-center justify-center transition-colors text-white cursor-pointer"
              aria-label="Toggle mute"
            >
              {localMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            </button>
            <div className="flex-1" />
            <Link
              to={`/?u=${encodeURIComponent(entry.username)}${normalizePlatform(entry.platform) !== 'tiktok' ? `&platform=${normalizePlatform(entry.platform)}` : ''}`}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary hover:bg-primary/90 text-[11px] font-medium transition-colors text-primary-foreground"
            >
              <span>{t('dashLink')}</span>
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        </div>
      </div>
      <div className="p-3 flex items-center gap-2.5">
        {showAvatar ? (
          <img
            src={avatarUrl}
            alt={entry.username}
            referrerPolicy="no-referrer"
            onError={() => setFailedAvatarUrl(avatarUrl)}
            className="w-6 h-6 rounded-full object-cover flex-shrink-0 ring-1 ring-pink-500/30"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-[10px] font-bold flex-shrink-0 text-white">
            {(entry.username[0] || '?').toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-sm text-foreground truncate">@{entry.username}</span>
            {normalizePlatform(entry.platform) !== 'tiktok' && (
              <PlatformBadge platform={normalizePlatform(entry.platform)} />
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">{entry.title || t('noTitle')}</div>
        </div>
      </div>
    </div>
  )
}
