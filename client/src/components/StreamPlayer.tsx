import { useEffect, useRef, useCallback, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Copy, Check, AlertTriangle, Loader2, Circle, MessageSquare, PictureInPicture2 } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { startRecord as apiStartRecord } from '@/lib/api'
import { loadPlayers } from '@/lib/players'
import type { CheckResult, StreamData } from '@/lib/types'
import { ChatPanel } from './ChatPanel'
import { toast } from 'sonner'


interface Props {
  data: CheckResult
  onRecordStarted?: () => void
}

export function StreamPlayer({ data, onRecordStarted }: Props) {
  const { t } = useI18n()
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoColRef = useRef<HTMLDivElement>(null)
  const playersRef = useRef<{ destroy: () => void }[]>([])
  const [playerQuality, setPlayerQuality] = useState('auto')
  const [recordQuality, setRecordQuality] = useState('')
  const [playerInfo, setPlayerInfo] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordMsg, setRecordMsg] = useState('')
  const [chatHeight, setChatHeight] = useState<number | undefined>(undefined)

  const s = data.streams!

  const tearDown = useCallback(() => {
    for (const p of playersRef.current) {
      try { p.destroy() } catch { /* ignore */ }
    }
    playersRef.current = []
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
    let flvUrl: string | undefined, hlsUrl: string | undefined

    if (quality === 'auto') {
      const flvMap = streams.flv || {}
      flvUrl = flvMap.hd || flvMap.origin || flvMap.uhd || flvMap.sd || flvMap.ld ||
        Object.values(flvMap).find((u) => u && !isAo(u))
      hlsUrl = streams.hls
    } else if (codec === 'hevc') {
      flvUrl = streams.hevc?.flv?.[key!]
      hlsUrl = streams.hevc?.hls?.[key!]
    } else {
      flvUrl = streams.flv?.[key!]
      hlsUrl = streams.hlsByQuality?.[key!] || streams.hls
    }

    const label = quality === 'auto' ? 'auto' : `${codec.toUpperCase()}:${key}`

    const MAX_RETRIES = 3
    let retries = 0
    const attachFlvErrorHandler = (p: FlvPlayer) => {
      p.on(flvjs!.Events.ERROR, () => {
        if (retries++ >= MAX_RETRIES) { setPlayerInfo('Stream error (gave up after retries)'); return }
        setTimeout(() => {
          try { p.unload(); p.load(); p.play().catch(() => {}) } catch {}
        }, 3000)
      })
    }
    const attachHlsErrorHandler = (h: HlsInstance) => {
      h.on(Hls!.Events.ERROR, (...args: unknown[]) => {
        const data = args[1] as { fatal?: boolean } | undefined
        if (!data?.fatal) return
        if (retries++ >= MAX_RETRIES) { setPlayerInfo('Stream error (gave up after retries)'); return }
        setTimeout(() => { try { h.recoverMediaError() } catch {} }, 3000)
      })
    }

    if (codec === 'hevc') {
      const srcUrl = flvUrl || hlsUrl
      if (!srcUrl) { setPlayerInfo('No HEVC stream URL available'); return }
      if (!flvjs || !flvjs.isSupported()) {
        setPlayerInfo('flv.js required for HEVC transcoding'); return
      }
      const transcodeUrl = '/api/transcode?url=' + encodeURIComponent(srcUrl)
      const p = flvjs.createPlayer({ type: 'flv', url: transcodeUrl, isLive: true, cors: true })
      p.attachMediaElement(video); p.load(); p.play().catch(() => {})
      attachFlvErrorHandler(p)
      playersRef.current.push(p)
      setPlayerInfo(`Transcode H.264 ← ${label} · ⚠ CPU intensive`)
      return
    }

    if (flvUrl && flvjs && flvjs.isSupported()) {
      const proxied = '/api/proxy?url=' + encodeURIComponent(flvUrl)
      const p = flvjs.createPlayer({ type: 'flv', url: proxied, isLive: true, cors: true })
      p.attachMediaElement(video); p.load(); p.play().catch(() => {})
      attachFlvErrorHandler(p)
      playersRef.current.push(p)
      setPlayerInfo(`FLV (flv.js) · ${label} · via local proxy`)
    } else if (hlsUrl && Hls && Hls.isSupported()) {
      const proxied = '/api/proxy?url=' + encodeURIComponent(hlsUrl)
      const h = new Hls()
      h.loadSource(proxied); h.attachMedia(video)
      attachHlsErrorHandler(h)
      playersRef.current.push(h)
      setPlayerInfo(`HLS (hls.js) · ${label} · via local proxy`)
    } else if (hlsUrl && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = '/api/proxy?url=' + encodeURIComponent(hlsUrl)
      video.onerror = () => {
        if (retries++ >= MAX_RETRIES) { setPlayerInfo('Stream error (gave up after retries)'); return }
        setTimeout(() => { try { video.load(); video.play().catch(() => {}) } catch {} }, 3000)
      }
      setPlayerInfo(`HLS (native) · ${label} · via local proxy`)
    } else {
      setPlayerInfo('No playable stream in this browser')
    }
  }, [tearDown])

  useEffect(() => {
    let cancelled = false
    // Lazy-load hls.js and flv.js from CDN before constructing the player.
    loadPlayers().then(() => {
      if (cancelled) return
      playStream(s, playerQuality)
    }).catch((e) => {
      console.error('player libs failed to load:', e)
      setPlayerInfo('Player library failed to load')
    })
    return () => { cancelled = true; tearDown() }
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
  ])].filter(k => !isAudioOnly(k, s.flv) && !isAudioOnly(k, s.hlsByQuality))

  const hevcKeys = [...new Set([
    ...Object.keys(s.hevc?.flv || {}),
    ...Object.keys(s.hevc?.hls || {}),
  ])].filter(k => !isAudioOnly(k, s.hevc?.flv) && !isAudioOnly(k, s.hevc?.hls))

  // Build record quality options
  const recordQualities: { value: string; label: string }[] = []
  const qs = s.qualities?.length ? s.qualities : Object.keys(s.flv || {}).map(k => ({ name: k, sdkKey: k }))
  for (const q of qs) {
    if (q.sdkKey === 'ao') continue
    recordQualities.push({ value: q.sdkKey, label: `${q.name} (${q.sdkKey})` })
  }
  const hevcQs = (s.hevcQualities || []).slice().sort((a, b) => (b.level ?? 0) - (a.level ?? 0))
  for (const q of hevcQs) {
    if (q.sdkKey === 'ao') continue
    recordQualities.push({ value: `hevc:${q.sdkKey}`, label: `${q.name} (${q.sdkKey}) · HEVC` })
  }

  const handleRecord = async () => {
    setRecording(true)
    setRecordMsg('')
    try {
      const result = await apiStartRecord(data.username, recordQuality || undefined)
      toast.success(result.reused ? 'Already recording' : `Recording @${data.username}`, {
        description: result.file,
      })
      setRecordMsg(`→ ${result.file}`)
      onRecordStarted?.()
    } catch (e: unknown) {
      toast.error('Record failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setRecording(false)
    }
  }

  // Stream URL rows
  const urlRows: { label: string; url: string }[] = []
  for (const [q, u] of Object.entries(s.hlsByQuality || {})) urlRows.push({ label: `h264 hls/${q}`, url: u })
  for (const [q, u] of Object.entries(s.flv || {})) urlRows.push({ label: `h264 flv/${q}`, url: u })
  for (const [q, u] of Object.entries(s.cmaf || {})) urlRows.push({ label: `h264 mpd/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.hls || {})) urlRows.push({ label: `hevc hls/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.flv || {})) urlRows.push({ label: `hevc flv/${q}`, url: u })
  for (const [q, u] of Object.entries(s.hevc?.cmaf || {})) urlRows.push({ label: `hevc mpd/${q}`, url: u })

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <CardContent className="pt-5 space-y-4">
        {/* Player + Chat */}
        <div className="grid md:grid-cols-3 gap-4 items-start">
          <div ref={videoColRef} className="md:col-span-2 flex flex-col">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap shrink-0">
              <h2 className="font-semibold text-foreground">{t('previewTitle')}</h2>
              <Select value={playerQuality} onValueChange={(v) => v && setPlayerQuality(v)}>
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (highest H.264)</SelectItem>
                  {h264Keys.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>H.264 (compatible)</SelectLabel>
                      {h264Keys.map(q => {
                        const m = s.qualities?.find(x => x.sdkKey === q)
                        return <SelectItem key={q} value={`h264:${q}`}>{m?.name ? `${m.name} (${q})` : q}</SelectItem>
                      })}
                    </SelectGroup>
                  )}
                  {hevcKeys.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>HEVC / H.265</SelectLabel>
                      {hevcKeys.map(q => {
                        const m = s.hevcQualities?.find(x => x.sdkKey === q)
                        return <SelectItem key={q} value={`hevc:${q}`}>{m?.name ? `${m.name} (${q})` : q}</SelectItem>
                      })}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="relative">
              <video ref={videoRef} controls muted playsInline className="w-full aspect-video bg-black rounded-lg" />
              <Button
                variant="secondary"
                size="xs"
                className="absolute top-2 right-2 opacity-70 hover:opacity-100 transition-opacity gap-1"
                onClick={() => {
                  const v = videoRef.current
                  if (!v) return
                  if (document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(() => {})
                  } else {
                    v.requestPictureInPicture().catch(() =>
                      toast.error('PiP not supported in this browser')
                    )
                  }
                }}
                title={t('pip')}
              >
                <PictureInPicture2 className="w-3 h-3" /> {t('pip')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">{playerInfo}</p>
          </div>
          <div className="overflow-hidden" style={chatHeight ? { height: chatHeight } : undefined}>
            <ChatPanel key={data.username} username={data.username} />
          </div>
        </div>

        <Separator />

        {/* Stream URLs */}
        <div>
          <h2 className="font-semibold mb-2 text-foreground">{t('streamUrlsTitle')}</h2>
          <div className="space-y-1.5">
            {urlRows.map((row) => (
              <UrlRow key={row.label} label={row.label} url={row.url} />
            ))}
          </div>
        </div>

        <Separator />

        {/* Record */}
        <div>
          <h2 className="font-semibold mb-2 text-foreground">{t('recordTitle')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('qualityLabel')}</span>
            <Select value={recordQuality} onValueChange={(v) => v !== null && setRecordQuality(v)}>
              <SelectTrigger className="w-[200px] h-8 text-xs">
                <SelectValue placeholder={t('qAuto')} />
              </SelectTrigger>
              <SelectContent>
                {recordQualities.map(q => (
                  <SelectItem key={q.value} value={q.value}>{q.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleRecord}
              disabled={recording}
              className="bg-emerald-600 hover:bg-emerald-500 text-white border-0"
            >
              {recording ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Circle className="w-3 h-3 mr-1.5 fill-current" />}
              {t('btnStartRec')}
            </Button>
            {recordMsg && <span className="text-xs text-muted-foreground">{recordMsg}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
            <MessageSquare className="w-3 h-3" /> {t('chatRecHint')}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

export function BlockedStreams({ data }: { data: CheckResult }) {
  const { t } = useI18n()
  return (
    <Card className="border-amber-700/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <CardContent className="pt-5">
        <div className="p-4 bg-amber-900/20 border border-amber-700/40 rounded-lg">
          <h2 className="font-semibold text-amber-300 mb-1 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {t('noStreamsTitle')}
          </h2>
          <p className="text-sm text-amber-100/80">
            {t('noStreamsDesc')} <code className="bg-secondary px-1.5 rounded text-xs">@{data.username}</code>
            {data.liveRoomMode && <> (mode: <code className="bg-secondary px-1.5 rounded text-xs">{data.liveRoomMode}</code>)</>}
          </p>
          <p className="text-xs text-muted-foreground mt-2">{t('noStreamsFix')}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function UrlRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
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
