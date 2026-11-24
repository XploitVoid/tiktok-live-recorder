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
  kind: 'flv' | 'hls'
  quality: string
}

function pickStream(entry: CheckResult, qPref: string, preferHls = false): PickedStream | null {
  if (preferHls && entry.streams?.hls) {
    return { url: entry.streams.hls, kind: 'hls', quality: 'auto' }
  }
  const f = entry.streams?.flv || {}
  const order = qPref === 'hd' ? ['hd', 'ld', 'origin', 'uhd', 'sd'] : ['ld', 'sd', 'hd', 'origin', 'uhd']
  for (const q of order) if (f[q]) return { url: f[q], kind: 'flv', quality: q }
  if (entry.streams?.hls) return { url: entry.streams.hls, kind: 'hls', quality: 'auto' }
  return null
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

  // Compute the picked stream once and use its URL as the effect dependency,
  // so we only recreate the player when the URL or quality actually changes
  // (not on every refresh that creates a new streams object reference).
  const pick = pickStream(entry, quality, preferHls)
  const pickedUrl = pick?.url ?? ''
  const pickedKind = pick?.kind ?? ''
  const pickedQ = pick?.quality ?? ''

  useEffect(() => {
    const video = videoRef.current
    if (!video || !pickedUrl) return

    const players: { destroy: () => void }[] = []
    const timers: ReturnType<typeof setTimeout>[] = []
    const MAX_RETRIES = 3
    let retries = 0
    let cancelled = false

    const onNativeMeta = () => {
      video.play().catch(() => {})
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
      if (typeof window.flvjs !== 'undefined' && flvjs!.isSupported() && pickedKind === 'flv') {
        const proxied = '/api/proxy?url=' + encodeURIComponent(pickedUrl)
        const p = flvjs!.createPlayer({ type: 'flv', url: proxied, isLive: true, cors: true })
        p.attachMediaElement(video); p.load(); p.play().catch(() => {})
        p.on(flvjs!.Events.ERROR, () => {
          if (cancelled || retries++ >= MAX_RETRIES) return
          const id = setTimeout(() => {
            if (cancelled) return
            try { p.unload(); p.load(); p.play().catch(() => {}) } catch { /* give up */ }
          }, 3000)
          timers.push(id)
        })
        players.push(p)
      } else if (typeof window.Hls !== 'undefined' && Hls!.isSupported() && pickedKind === 'hls') {
        const p = new Hls!()
        p.loadSource('/api/proxy?url=' + encodeURIComponent(pickedUrl))
        p.attachMedia(video)
        p.on(Hls!.Events.MANIFEST_PARSED, () => {
          if (!cancelled) video.play().catch(() => {})
        })
        p.on(Hls!.Events.ERROR, (...args: unknown[]) => {
          const data = args[1] as { fatal?: boolean; type?: string } | undefined
          if (!data?.fatal) return
          if (cancelled || retries++ >= MAX_RETRIES) return
          const id = setTimeout(() => {
            if (cancelled) return
            try {
              if (data.type === Hls!.ErrorTypes.NETWORK_ERROR) {
                p.startLoad()
              } else {
                p.recoverMediaError()
              }
            } catch { /* give up */ }
          }, 3000)
          timers.push(id)
        })
        players.push(p)
      } else {
        video.src = '/api/proxy?url=' + encodeURIComponent(pickedUrl)
        video.addEventListener('loadedmetadata', onNativeMeta)
        video.play().catch(() => {})
        video.onerror = () => {
          if (cancelled || retries++ >= MAX_RETRIES) return
          const id = setTimeout(() => {
            if (cancelled) return
            try { video.load(); video.play().catch(() => { /* ignore */ }) } catch { /* ignore */ }
          }, 3000)
          timers.push(id)
        }
      }
    }

    return () => {
      cancelled = true
      for (const id of timers) clearTimeout(id)
      video.onerror = null
      video.removeEventListener('loadedmetadata', onNativeMeta)
      for (const p of players) { try { p.destroy() } catch { /* ignore */ } }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
    }
  }, [pickedUrl, pickedKind, pickedQ])

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
