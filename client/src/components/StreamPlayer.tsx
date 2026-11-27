import { useEffect, useRef, useCallback, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Copy, Check, AlertTriangle, Loader2, Circle, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { startRecord as apiStartRecord } from '@/lib/api'
import { loadPlayers } from '@/lib/players'
import type { CheckResult, StreamData } from '@/lib/types'
import { ChatPanel } from './ChatPanel'
import { VideoPlayerBox } from './VideoPlayerBox'
import { toast } from 'sonner'


interface Props {
  data: CheckResult
  onRecordStarted?: () => void
}

export function StreamPlayer({ data, onRecordStarted }: Props) {
  const { t } = useI18n()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoColRef = useRef<HTMLDivElement>(null)
  const playersRef = useRef<{ destroy: () => void }[]>([])
  const [playerQuality, setPlayerQuality] = useState('auto')
  const [recordQuality, setRecordQuality] = useState('auto')
  const [recordAudioBitrate, setRecordAudioBitrate] = useState('default')
  const [playerInfo, setPlayerInfo] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordMsg, setRecordMsg] = useState('')
  const [showUrls, setShowUrls] = useState(false)
  const [chatHeight, setChatHeight] = useState<number | undefined>(undefined)
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 768px)')
    const fn = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  const s = data.streams!

  const tearDown = useCallback(() => {
    for (const p of playersRef.current) {
      try { p.destroy() } catch { /* ignore */ }
    }
    playersRef.current = []
    const video = videoRef.current
    if (video) {
      video.onerror = null
      try { video.pause() } catch { /* ignore */ }
      video.removeAttribute('src')
      try { video.load() } catch { /* ignore */ }
    }
  }, [])

  const playStream = useCallback((streams: StreamData, quality: string) => {
    const video = videoRef.current
    if (!video) return
    tearDown()

    let codec = 'h264', key: string | null = null
    if (quality !== 'auto') {
      const [c, k] = quality.split(':')
      codec = c; key = k
    }

    const isAo = (u: string) => u && /only_audio=1/.test(u)
    let flvUrl: string | undefined, hlsUrl: string | undefined, cmafUrl: string | undefined

    if (quality === 'auto') {
      const flvMap = streams.flv || {}
      const hlsMap = streams.hlsByQuality || {}
      const cmafMap = streams.cmaf || {}
      flvUrl = flvMap.hd || flvMap.origin || flvMap.uhd || flvMap.sd || flvMap.ld ||
        Object.values(flvMap).find((u) => u && !isAo(u))
      hlsUrl = streams.hls || hlsMap.hd || hlsMap.origin || hlsMap.uhd || hlsMap.sd || hlsMap.ld ||
        Object.values(hlsMap).find((u) => u && !isAo(u))
      cmafUrl = cmafMap.hd || cmafMap.origin || cmafMap.uhd || cmafMap.sd || cmafMap.ld ||
        Object.values(cmafMap).find((u) => u && !isAo(u))
      if (!flvUrl && !hlsUrl && !cmafUrl) {
        const hevcFlv = streams.hevc?.flv || {}
        const hevcHls = streams.hevc?.hls || {}
        const hFlv = hevcFlv.hd || hevcFlv.origin || hevcFlv.uhd || hevcFlv.sd || hevcFlv.ld ||
          Object.values(hevcFlv).find((u) => u && !isAo(u))
        const hHls = hevcHls.hd || hevcHls.origin || hevcHls.uhd || hevcHls.sd || hevcHls.ld ||
          Object.values(hevcHls).find((u) => u && !isAo(u))
        if (hFlv || hHls) {
          codec = 'hevc'
          flvUrl = hFlv
          hlsUrl = hHls
        }
      }
    } else if (codec === 'hevc') {
      flvUrl = streams.hevc?.flv?.[key!]
      hlsUrl = streams.hevc?.hls?.[key!]
    } else {
      flvUrl = streams.flv?.[key!]
      hlsUrl = streams.hlsByQuality?.[key!] || (!streams.flv?.[key!] && !streams.cmaf?.[key!] ? streams.hls : undefined)
      cmafUrl = streams.cmaf?.[key!]
    }

    const label = quality === 'auto' ? (codec === 'hevc' ? 'HEVC:auto' : 'auto') : `${codec.toUpperCase()}:${key}`

    const MAX_RETRIES = 3
    let retries = 0
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let nativeMetaHandler: (() => void) | null = null

    const onPlaying = () => {
      retries = 0
    }
    video.addEventListener('playing', onPlaying)

    const scheduleRetry = (fn: () => void, giveUpMsg: string, onGiveUp?: () => void) => {
      if (cancelled || retryTimer !== null) return
      if (retries >= MAX_RETRIES) {
        setPlayerInfo(giveUpMsg)
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

    const attachFlvErrorHandler = (p: FlvPlayer) => {
      const flvLib = window.flvjs
      if (!flvLib) return
      p.on(flvLib.Events.ERROR, () => {
        scheduleRetry(
          () => { try { p.unload(); p.load(); p.play().catch(() => { /* ignore */ }) } catch { /* ignore */ } },
          `${tRef.current('playerStreamError')} (gave up after retries)`,
          () => {
            try { p.destroy() } catch { /* ignore */ }
            playersRef.current = playersRef.current.filter((x) => x !== p)
          },
        )
      })
    }
    const attachHlsErrorHandler = (h: HlsInstance) => {
      const hlsLib = window.Hls
      if (!hlsLib) return
      h.on(hlsLib.Events.ERROR, (...args: unknown[]) => {
        const errData = args[1] as { fatal?: boolean; type?: string; details?: string } | undefined
        if (!errData?.fatal || cancelled) return
        scheduleRetry(
          () => {
            try {
              if (errData.type === hlsLib.ErrorTypes.NETWORK_ERROR) {
                h.startLoad()
              } else {
                h.recoverMediaError()
              }
            } catch { /* ignore */ }
          },
          `${tRef.current('playerStreamError')} (${errData.details || errData.type || 'gave up after retries'})`,
          () => {
            try { h.destroy() } catch { /* ignore */ }
            playersRef.current = playersRef.current.filter((x) => x !== h)
          },
        )
      })
    }

    const flvConfig = {
      enableStashBuffer: true,
      stashInitialSize: 512,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 20,
      autoCleanupMinBackwardDuration: 10,
      fixAudioTimestampGap: true,
      lazyLoad: false,
    }

    const flvLib = window.flvjs
    const hlsLib = window.Hls

    const attachTranscode = (candidates: string[], errPrefix: string, infoText: string) => {
      if (candidates.length === 0) {
        video.removeEventListener('playing', onPlaying)
        setPlayerInfo(tRef.current('playerNoPlayable'))
        return
      }
      if (!flvLib || !flvLib.isSupported()) {
        video.removeEventListener('playing', onPlaying)
        setPlayerInfo(`flv.js required for ${errPrefix} transcoding`)
        return
      }

      const abortAndTearDown = () => {
        cancelled = true
        if (retryTimer !== null) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        tearDown()
      }

      let candidateIdx = 0
      const start = (idx: number) => {
        if (cancelled) return
        const srcUrl = candidates[idx]
        const transcodeUrl = '/api/transcode?url=' + encodeURIComponent(srcUrl)
        const p = flvLib.createPlayer({
          type: 'flv',
          url: transcodeUrl,
          isLive: true,
          cors: true,
          hasAudio: true,
          hasVideo: true,
        }, flvConfig)
        p.attachMediaElement(video)
        p.load()
        p.play().catch(() => {})
        p.on(flvLib.Events.ERROR, (_errType: unknown, _errDetail: unknown, info: unknown) => {
          if (cancelled || retryTimer !== null) return
          const code = (info as { code?: number } | undefined)?.code
          if (code === 503) {
            setPlayerInfo(`${errPrefix} transcode unavailable: ffmpeg is not installed on the server`)
            toast.error(tRef.current('ffmpegRequiredTitle'), { description: tRef.current('ffmpegRequiredDesc') })
            abortAndTearDown()
            return
          }
          if (candidateIdx + 1 < candidates.length) {
            candidateIdx++
            try { p.destroy() } catch { /* ignore */ }
            playersRef.current = playersRef.current.filter((x) => x !== p)
            start(candidateIdx)
            return
          }
          if (retries >= MAX_RETRIES) {
            setPlayerInfo(`${errPrefix} transcode failed (check server logs / ffmpeg)`)
            abortAndTearDown()
            return
          }
          scheduleRetry(
            () => { try { p.unload(); p.load(); p.play().catch(() => { /* ignore */ }) } catch { /* ignore */ } },
            `${errPrefix} transcode failed (check server logs / ffmpeg)`,
            abortAndTearDown,
          )
        })
        playersRef.current.push(p)
      }

      start(0)
      setPlayerInfo(infoText)
    }

    if (codec === 'hevc') {
      // Prefer continuous FLV stream first (avoids 2-6s HLS segment pauses);
      // fall back to HLS if FLV is unavailable or fails.
      const candidates = [flvUrl, hlsUrl].filter((u): u is string => !!u)
      attachTranscode(candidates, 'HEVC', `Transcode H.264 ← ${label} · ⚠ CPU intensive`)
    } else if (flvUrl && flvLib && flvLib.isSupported()) {
      const proxied = '/api/proxy?url=' + encodeURIComponent(flvUrl)
      const p = flvLib.createPlayer({ type: 'flv', url: proxied, isLive: true, cors: true }, flvConfig)
      p.attachMediaElement(video); p.load(); p.play().catch(() => {})
      attachFlvErrorHandler(p)
      playersRef.current.push(p)
      setPlayerInfo(`FLV (flv.js) · ${label} · via local proxy`)
    } else if (hlsUrl && hlsLib && hlsLib.isSupported()) {
      const proxied = '/api/proxy?url=' + encodeURIComponent(hlsUrl)
      const h = new hlsLib({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 })
      h.loadSource(proxied); h.attachMedia(video)
      h.on(hlsLib.Events.MANIFEST_PARSED, () => {
        if (!cancelled) video.play().catch(() => {})
      })
      attachHlsErrorHandler(h)
      playersRef.current.push(h)
      setPlayerInfo(`HLS (hls.js) · ${label} · via local proxy`)
    } else if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = '/api/proxy?url=' + encodeURIComponent(hlsUrl)
      nativeMetaHandler = () => {
        if (!cancelled) video.play().catch(() => {})
      }
      video.addEventListener('loadedmetadata', nativeMetaHandler)
      video.play().catch(() => {})
      video.onerror = () => {
        scheduleRetry(
          () => { try { video.load(); video.play().catch(() => { /* ignore */ }) } catch { /* ignore */ } },
          `${tRef.current('playerStreamError')} (gave up after retries)`,
          () => {
            video.onerror = null
            if (nativeMetaHandler) video.removeEventListener('loadedmetadata', nativeMetaHandler)
            try { video.pause() } catch { /* ignore */ }
            video.removeAttribute('src')
            try { video.load() } catch { /* ignore */ }
          },
        )
      }
      setPlayerInfo(`HLS (native) · ${label} · via local proxy`)
    } else if (cmafUrl) {
      attachTranscode([cmafUrl], 'DASH', `Transcode DASH → FLV · ${label}`)
    } else {
      setPlayerInfo(tRef.current('playerNoPlayable'))
    }

    return () => {
      cancelled = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      video.removeEventListener('playing', onPlaying)
      if (nativeMetaHandler) {
        video.removeEventListener('loadedmetadata', nativeMetaHandler)
      }
    }
  }, [tearDown])

  useEffect(() => {
    let cancelled = false
    let cleanupStream: (() => void) | undefined
    // Lazy-load hls.js and flv.js from CDN before constructing the player.
    loadPlayers().then(() => {
      if (cancelled) return
      cleanupStream = playStream(s, playerQuality)
    }).catch((e) => {
      console.error('player libs failed to load:', e)
      setPlayerInfo('Player library failed to load')
    })
    return () => { cancelled = true; cleanupStream?.(); tearDown() }
  }, [s, playerQuality, playStream, tearDown])

  // Sync chat panel height with video column
  useEffect(() => {
    const el = videoColRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setChatHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Build player quality options
  const isAudioOnly = (key: string, urlMap?: Record<string, string>) => {
    if (key === 'ao') return true
    const url = urlMap?.[key] || ''
    return /only_audio=1/i.test(url)
  }
  const h264Keys = [...new Set([
    ...Object.keys(s.flv || {}),
    ...Object.keys(s.hlsByQuality || {}),
    ...Object.keys(s.cmaf || {}),
  ])].filter(k => !isAudioOnly(k, s.flv) && !isAudioOnly(k, s.hlsByQuality) && !isAudioOnly(k, s.cmaf))

  const hevcKeys = [...new Set([
    ...Object.keys(s.hevc?.flv || {}),
    ...Object.keys(s.hevc?.hls || {}),
  ])].filter(k => !isAudioOnly(k, s.hevc?.flv) && !isAudioOnly(k, s.hevc?.hls))

  // Build record quality options
  const recordQualities: { value: string; label: string }[] = []
  const qs = s.qualities?.length
    ? s.qualities
    : (Object.keys(s.flv || {}).length
        ? Object.keys(s.flv || {})
        : Object.keys(s.hlsByQuality || {}).length
          ? Object.keys(s.hlsByQuality || {})
          : Object.keys(s.cmaf || {}))
        .map(k => ({ name: k, sdkKey: k }))
  for (const q of qs) {
    if (q.sdkKey === 'ao') continue
    recordQualities.push({ value: q.sdkKey, label: `${q.name} (${q.sdkKey})` })
  }
  const hevcQs = (s.hevcQualities || []).slice().sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
  for (const q of hevcQs) {
    if (q.sdkKey === 'ao') continue
    recordQualities.push({ value: `hevc:${q.sdkKey}`, label: `${q.name} (${q.sdkKey}) · HEVC` })
  }
  if (s.flv?.ao || s.cmaf?.ao || s.hlsByQuality?.ao) {
    recordQualities.push({ value: 'ao', label: 'Audio Only (ao)' })
  } else {
    recordQualities.push({ value: 'ao', label: t('audioOnlyForce') })
  }

  const playerQualityItems: Record<string, string> = {
    auto: t('playerQualityAutoH264'),
  }
  for (const q of h264Keys) {
    const m = s.qualities?.find(x => x.sdkKey === q)
    playerQualityItems[`h264:${q}`] = m?.name ? `${m.name} (${q})` : q
  }
  for (const q of hevcKeys) {
    const m = s.hevcQualities?.find(x => x.sdkKey === q)
    playerQualityItems[`hevc:${q}`] = m?.name ? `${m.name} (${q})` : q
  }

  const recordQualityItems: Record<string, string> = { auto: t('qAuto') }
  for (const q of recordQualities) recordQualityItems[q.value] = q.label

  const audioBitrateItems = {
    default: `${t('audioBitrateLabel')}: Auto`,
    copy: t('audioBitrateCopy'),
    '64k': '64 kbps',
    '96k': '96 kbps',
    '128k': '128 kbps',
    '192k': '192 kbps',
  }

  const handleRecord = async () => {
    setRecording(true)
    setRecordMsg('')
    try {
      const q = recordQuality && recordQuality !== 'auto' ? recordQuality : undefined
      const abr = recordAudioBitrate !== 'default' ? (recordAudioBitrate === 'copy' ? null : recordAudioBitrate) : undefined
      const result = await apiStartRecord(data.username, q, {
        audioOnly: recordQuality === 'ao',
        audioBitrate: abr,
        platform: data.platform,
      })
      toast.success(result.reused ? t('playerAlreadyRecording') : `${t('playerRecordingStarted')} @${data.username}`, {
        description: result.file,
      })
      setRecordMsg(`→ ${result.file}`)
      onRecordStarted?.()
    } catch (e: unknown) {
      toast.error(t('playerRecordFailed'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setRecording(false)
    }
  }

  // Stream URL rows
  const urlRows: { label: string; url: string }[] = []
  if (s.hls) urlRows.push({ label: 'hls/master', url: s.hls })
  for (const [q, u] of Object.entries(s.hlsByQuality || {})) urlRows.push({ label: `h264 hls/${q}`, url: u })
  for (const [q, u] of Object.entries(s.flv || {})) urlRows.push({ label: `h264 flv/${q}`, url: u })
  for (const [q, u] of Object.entries(s.cmaf || {})) urlRows.push({ label: `h264 mpd/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.hls || {})) urlRows.push({ label: `hevc hls/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.flv || {})) urlRows.push({ label: `hevc flv/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.cmaf || {})) urlRows.push({ label: `hevc mpd/${q}`, url: u })

  return (
    <Card className="border-border/80">
      <CardContent className="pt-5 space-y-4">
        {/* Player + Chat */}
        <div className="grid md:grid-cols-3 gap-4 items-start">
          <div ref={videoColRef} className="md:col-span-2 flex flex-col">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap shrink-0">
              <h2 className="font-semibold text-foreground">{t('previewTitle')}</h2>
              <Select items={playerQualityItems} value={playerQuality} onValueChange={(v) => v && setPlayerQuality(v)}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('playerQualityAutoH264')}</SelectItem>
                  {h264Keys.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('playerCodecH264')}</SelectLabel>
                      {h264Keys.map(q => {
                        const m = s.qualities?.find(x => x.sdkKey === q)
                        return <SelectItem key={q} value={`h264:${q}`}>{m?.name ? `${m.name} (${q})` : q}</SelectItem>
                      })}
                    </SelectGroup>
                  )}
                  {hevcKeys.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('playerCodecHevc')}</SelectLabel>
                      {hevcKeys.map(q => {
                        const m = s.hevcQualities?.find(x => x.sdkKey === q)
                        return <SelectItem key={q} value={`hevc:${q}`}>{m?.name ? `${m.name} (${q})` : q}</SelectItem>
                      })}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
            <VideoPlayerBox videoRef={videoRef} muted />
            <p className="text-xs text-muted-foreground mt-1">{playerInfo}</p>
          </div>
          <div className="overflow-hidden" style={isDesktop && chatHeight ? { height: chatHeight } : undefined}>
            <ChatPanel key={`${data.platform || 'tiktok'}:${data.username}`} username={data.username} platform={data.platform} />
          </div>
        </div>

        <Separator />

        {/* Record controls (directly accessible below preview) */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t('recordTitle')}</h2>
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3" /> {t('chatRecHint')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('recQualityLabel')}</span>
            <Select items={recordQualityItems} value={recordQuality} onValueChange={(v) => v !== null && setRecordQuality(v)}>
              <SelectTrigger className="w-[200px] h-8 text-xs">
                <SelectValue placeholder={t('qAuto')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('qAuto')}</SelectItem>
                {recordQualities.map(q => (
                  <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select items={audioBitrateItems} value={recordAudioBitrate} onValueChange={(v) => v !== null && setRecordAudioBitrate(v)}>
              <SelectTrigger className="w-[150px] h-8 text-xs">
                <SelectValue placeholder={t('audioBitrateLabel')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('audioBitrateLabel')}: Auto</SelectItem>
                <SelectItem value="copy">{t('audioBitrateCopy')}</SelectItem>
                <SelectItem value="64k">64 kbps</SelectItem>
                <SelectItem value="96k">96 kbps</SelectItem>
                <SelectItem value="128k">128 kbps</SelectItem>
                <SelectItem value="192k">192 kbps</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={handleRecord}
              disabled={recording}
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
            >
              {recording ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Circle className="w-3 h-3 mr-1.5 fill-current" />}
              {t('btnStartRec')}
            </Button>
            {recordMsg && (
              <span className="text-xs font-mono text-emerald-400 truncate max-w-xs">{recordMsg}</span>
            )}
          </div>
        </div>

        {/* Collapsible direct stream URLs */}
        {urlRows.length > 0 && (
          <div className="pt-1 border-t border-border/60">
            <button
              type="button"
              onClick={() => setShowUrls((v) => !v)}
              aria-expanded={showUrls}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1 cursor-pointer"
            >
              {showUrls ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <span>{showUrls ? t('streamUrlsHide') : t('streamUrlsShow')}</span>
              <Badge variant="secondary" className="text-[10px] font-mono tabular-nums px-1.5 py-0">
                {urlRows.length}
              </Badge>
            </button>
            {showUrls && (
              <div className="space-y-1.5 mt-2">
                {urlRows.map((row) => (
                  <UrlRow key={row.label} label={row.label} url={row.url} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function BlockedStreams({ data }: { data: CheckResult }) {
  const { t } = useI18n()
  const isTikTok = (data.platform || 'tiktok') === 'tiktok'
  return (
    <Card className="border-amber-700/50">
      <CardContent className="pt-5">
        <div className="p-4 bg-amber-900/20 border border-amber-700/40 rounded-lg">
          <h2 className="font-semibold text-amber-300 mb-1 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {t('noStreamsTitle')}
          </h2>
          <p className="text-sm text-amber-100/80">
            {t('noStreamsDesc')} <code className="bg-secondary px-1.5 rounded text-xs">@{data.username}</code>
            {data.liveRoomMode && <> (mode: <code className="bg-secondary px-1.5 rounded text-xs">{data.liveRoomMode}</code>)</>}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {isTikTok ? t('noStreamsFix') : (data.streamsBlockedReason || '')}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function UrlRow({ label, url }: { label: string; url: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        throw new Error('clipboard unavailable')
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        if (!ok) throw new Error('execCommand failed')
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      } catch {
        toast.error(t('copyFailed'))
      }
    }
  }

  return (
    <div className="flex items-center gap-2 bg-secondary rounded-lg px-2 py-1">
      <Badge variant="secondary" className="font-mono text-[10px] w-32 justify-center shrink-0">{label}</Badge>
      <Input readOnly value={url} className="flex-1 bg-transparent text-xs font-mono border-0 shadow-none h-7 focus-visible:ring-0" />
      <Button variant="ghost" size="icon-xs" onClick={copy}>
        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      </Button>
    </div>
  )
}
