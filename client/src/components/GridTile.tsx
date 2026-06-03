import { useEffect, useRef, useState } from 'react'
import { fmtViewers } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { loadPlayers } from '@/lib/players'
import type { CheckResult } from '@/lib/types'

interface GridTileProps {
  entry: CheckResult
  quality: string
  muted: boolean
}

interface PickedStream {
  url: string
  kind: 'flv' | 'hls'
  quality: string
}

function pickStream(entry: CheckResult, qPref: string): PickedStream | null {
  const f = entry.streams?.flv || {}
  const order = qPref === 'hd' ? ['hd', 'ld', 'origin', 'uhd', 'sd'] : ['ld', 'sd', 'hd', 'origin', 'uhd']
  for (const q of order) if (f[q]) return { url: f[q], kind: 'flv', quality: q }
  if (entry.streams?.hls) return { url: entry.streams.hls, kind: 'hls', quality: 'auto' }
  return null
}

export function GridTile({ entry, quality, muted }: GridTileProps) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [localMuted, setLocalMuted] = useState(muted)
  const [avatarFailed, setAvatarFailed] = useState(false)

  // Mute sync — runs separately so toggling mute doesn't recreate the player.
  useEffect(() => {
    setLocalMuted(muted)
  }, [muted])

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = localMuted
  }, [localMuted])

  // Compute the picked stream once and use its URL as the effect dependency,
  // so we only recreate the player when the URL or quality actually changes
  // (not on every refresh that creates a new streams object reference).
  const pick = pickStream(entry, quality)
  const pickedUrl = pick?.url ?? ''
  const pickedKind = pick?.kind ?? ''
  const pickedQ = pick?.quality ?? ''

  useEffect(() => {
    const video = videoRef.current
    if (!video || !pickedUrl) return

    const players: { destroy: () => void }[] = []
    const MAX_RETRIES = 3
    let retries = 0
    let cancelled = false

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
          setTimeout(() => {
            if (cancelled) return
            try { p.unload(); p.load(); p.play().catch(() => {}) } catch { /* give up */ }
          }, 3000)
        })
        players.push(p)
      } else if (typeof window.Hls !== 'undefined' && Hls!.isSupported() && pickedKind === 'hls') {
        const p = new Hls!()
        p.loadSource('/api/proxy?url=' + encodeURIComponent(pickedUrl))
        p.attachMedia(video)
        p.on(Hls!.Events.ERROR, (...args: unknown[]) => {
          const data = args[1] as { fatal?: boolean } | undefined
          if (!data?.fatal) return
          if (cancelled || retries++ >= MAX_RETRIES) return
          setTimeout(() => {
            if (cancelled) return
            try { p.recoverMediaError() } catch { /* give up */ }
          }, 3000)
        })
        players.push(p)
      } else {
        video.src = '/api/proxy?url=' + encodeURIComponent(pickedUrl)
        video.onerror = () => {
          if (cancelled || retries++ >= MAX_RETRIES) return
          setTimeout(() => {
            if (cancelled) return
            try { video.load(); video.play().catch(() => {}) } catch {}
          }, 3000)
        }
      }
    }

    return () => {
      cancelled = true
      for (const p of players) { try { p.destroy() } catch { /* */ } }
      try { video.removeAttribute('src'); video.load() } catch {}
    }
  }, [pickedUrl, pickedKind, pickedQ])

  const toggleMute = () => {
    setLocalMuted((value) => !value)
  }

  // Match original behavior: hide tile entirely if no playable stream exists.
  if (!pick) return null

  const avatarUrl = entry.owner?.avatarThumb || entry.coverUrl || ''
  const showAvatar = avatarUrl && !avatarFailed

  return (
    <div className="bg-card rounded-xl overflow-hidden flex flex-col border border-border h-full">
      <div className="relative bg-black w-full aspect-video cursor-pointer group shrink-0">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
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
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-black/50 backdrop-blur-sm text-slate-300">
            👁 {fmtViewers(entry.viewerCount)}
          </span>
        </div>
        <div className="absolute inset-0 flex items-end p-3 z-10 opacity-0 hover:opacity-100 transition-opacity bg-gradient-to-t from-black/60 to-transparent">
          <div className="flex items-center gap-2 w-full">
            <button
              onClick={(e) => { e.stopPropagation(); toggleMute() }}
              className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur flex items-center justify-center text-sm transition-colors text-white"
              aria-label="Toggle mute"
            >
              {localMuted ? '🔇' : '🔊'}
            </button>
            <div className="flex-1" />
            <a
              href={`/?u=${encodeURIComponent(entry.username)}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1 rounded-full bg-pink-600/80 hover:bg-pink-500 backdrop-blur text-[11px] font-semibold transition-colors text-white"
            >
              Open →
            </a>
          </div>
        </div>
      </div>
      <div className="p-3 flex items-center gap-2.5">
        {showAvatar ? (
          <img
            src={avatarUrl}
            alt={entry.username}
            onError={() => setAvatarFailed(true)}
            className="w-6 h-6 rounded-full object-cover flex-shrink-0 ring-1 ring-pink-500/30"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-[10px] font-bold flex-shrink-0 text-white">
            {(entry.username[0] || '?').toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm text-foreground truncate">@{entry.username}</div>
          <div className="text-[11px] text-muted-foreground truncate">{entry.title || t('noTitle')}</div>
        </div>
      </div>
    </div>
  )
}
