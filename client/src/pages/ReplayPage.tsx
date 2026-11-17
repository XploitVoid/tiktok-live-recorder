import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { MessageSquare, Play, AlertTriangle, ArrowLeft } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/Header'
import { HighlightsPanel } from '@/components/HighlightsPanel'
import { LeaderboardPanel } from '@/components/LeaderboardPanel'
import { GiftEconomyPanel } from '@/components/GiftEconomyPanel'
import { WordCloudPanel } from '@/components/WordCloudPanel'
import { BookmarksPanel } from '@/components/BookmarksPanel'
import { ChatEventRow } from '@/components/ChatEventRow'
import { VideoPlayerBox } from '@/components/VideoPlayerBox'
import { useI18n } from '@/lib/i18n'
import { getReplayData } from '@/lib/api'
import { fmtTimeSec } from '@/lib/format'
import type { ChatEvent } from '@/lib/types'
import { getKeywords } from '@/lib/chatHighlight'

type ReplayEvent = ChatEvent & { t?: number }

export function ReplayPage() {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const file = searchParams.get('file')

  const [events, setEvents] = useState<ReplayEvent[]>([])
  const [shown, setShown] = useState<ReplayEvent[]>([])
  const [filter, setFilter] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [info, setInfo] = useState({ start: '', events: '', size: '' })
  const [hasEvents, setHasEvents] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [durationSec, setDurationSec] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)

  const [keywords] = useState(() => getKeywords())
  const videoRef = useRef<HTMLVideoElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const videoCardRef = useRef<HTMLDivElement>(null)
  const [chatHeight, setChatHeight] = useState<number | null>(null)
  const pointerRef = useRef(0)
  const shownIdsRef = useRef(new Set<number>())
  const lastTimeRef = useRef(0)
  const filterRef = useRef(filter)

  useEffect(() => {
    filterRef.current = filter
  }, [filter])

  const passesFilter = useCallback((ev: ReplayEvent, activeFilter: string) => {
    if (activeFilter === 'all') return true
    if (activeFilter === 'chat') return ev.type === 'chat'
    if (activeFilter === 'gift') return ev.type === 'gift'
    if (activeFilter === 'like') return ev.type === 'like'
    if (activeFilter === 'member') return ev.type === 'member' || ev.type === 'follow' || ev.type === 'social'
    // PK events always show in 'all', never in specific filters (they're system events)
    return false
  }, [])

  const syncToTime = useCallback((time: number, overrideFilter?: string) => {
    const activeFilter = overrideFilter ?? filterRef.current
    if (time + 0.5 < lastTimeRef.current) {
      pointerRef.current = 0
      shownIdsRef.current.clear()
      setShown([])
    }

    const newItems: ReplayEvent[] = []
    while (pointerRef.current < events.length && (events[pointerRef.current].t == null || events[pointerRef.current].t! <= time)) {
      const ev = events[pointerRef.current++]
      if (ev.t == null || ev.t < 0) continue
      if (shownIdsRef.current.has(ev.id)) continue
      shownIdsRef.current.add(ev.id)
      if (passesFilter(ev, activeFilter)) newItems.push(ev)
    }

    if (newItems.length > 0) {
      setShown(prev => [...prev, ...newItems].slice(-600))
    }
    lastTimeRef.current = time
  }, [events, passesFilter])

  useEffect(() => {
    if (!file) return
    const load = async () => {
      try {
        const data = await getReplayData(file)
        setLoadError(null)
        setInfo({
          start: data.startMs ? new Date(data.startMs).toLocaleString() : '',
          events: data.eventsExists ? `${data.eventCount} events` : 'No chat sidecar',
          size: data.sizeBytes ? `${(data.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '',
        })
        setHasEvents(!!data.eventsExists)
        const sorted = (data.events || [])
          .filter(e => e.t == null || e.t >= 0)
          .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
        setEvents(sorted)
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : '__load_fail__')
      }
    }
    load()
  }, [file])

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [shown, autoScroll])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handler = () => {
      syncToTime(video.currentTime)
      setCurrentTime(video.currentTime)
    }
    const meta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDurationSec(video.duration)
      }
    }
    video.addEventListener('timeupdate', handler)
    video.addEventListener('seeked', handler)
    video.addEventListener('seeking', handler)
    video.addEventListener('loadedmetadata', meta)
    video.addEventListener('durationchange', meta)
    return () => {
      video.removeEventListener('timeupdate', handler)
      video.removeEventListener('seeked', handler)
      video.removeEventListener('seeking', handler)
      video.removeEventListener('loadedmetadata', meta)
      video.removeEventListener('durationchange', meta)
    }
  }, [syncToTime])

  const jumpTo = useCallback((sec: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, sec)
    video.play().catch(() => {})
  }, [])

  // Track the video card's actual rendered height so the chat card can match
  // it on desktop (md and above). On mobile we let chat use its natural
  // height because the cards stack vertically.
  useEffect(() => {
    const el = videoCardRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const h = el.getBoundingClientRect().height
      if (h > 0) setChatHeight(Math.round(h))
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    // Also re-measure when the video element loads metadata (its aspect-ratio
    // height is known only after that).
    const v = videoRef.current
    v?.addEventListener('loadedmetadata', update)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      v?.removeEventListener('loadedmetadata', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  // Detect desktop breakpoint so we only constrain chat height when cards are
  // side-by-side. On mobile the cards stack and chat should use natural height.
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

  const handleFilterChange = (value: string) => {
    filterRef.current = value
    setFilter(value)
    pointerRef.current = 0
    shownIdsRef.current.clear()
    lastTimeRef.current = 0
    setShown([])
    if (videoRef.current) {
      syncToTime(videoRef.current.currentTime, value)
    }
  }

  if (!file || loadError) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
        <Header />
        <Card className="border-border/80">
          <CardContent className="pt-6 pb-6 flex flex-col items-start gap-3">
            <div className="flex items-center gap-2 text-destructive font-medium text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{loadError === '__load_fail__' ? t('replayLoadFail') : (loadError || t('replayNotFound'))}</span>
            </div>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-secondary hover:bg-muted border border-border transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{t('replayBackHome')}</span>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
      <Header />
      <p className="text-xs text-muted-foreground truncate">{file}</p>

      <div className="grid md:grid-cols-3 gap-4 md:items-stretch">
        {/* Video */}
        <Card ref={videoCardRef} className="md:col-span-2">
          <CardContent className="pt-4">
            <VideoPlayerBox
              videoRef={videoRef}
              src={`/files/${encodeURIComponent(file)}`}
            />
            <div className="text-xs text-muted-foreground mt-2 px-1 flex flex-wrap gap-x-4 gap-y-1">
              <span>{info.start}</span>
              <span>{info.events}</span>
              <span>{info.size}</span>
            </div>
          </CardContent>
        </Card>

        {/* Chat — matches video card height on md+ via ResizeObserver */}
        <Card
          className="relative flex flex-col overflow-hidden"
          style={isDesktop && chatHeight ? { height: `${chatHeight}px` } : undefined}
        >
          <CardContent className="pt-4 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h2 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                <MessageSquare className="w-4 h-4 text-muted-foreground" />
                <span>{t('chatSync')}</span>
              </h2>
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox checked={autoScroll} onCheckedChange={(v) => setAutoScroll(!!v)} className="w-3.5 h-3.5" />
                  <span className="text-muted-foreground">{t('autoScroll')}</span>
                </label>
                <Select value={filter} onValueChange={(v) => v && handleFilterChange(v)}>
                  <SelectTrigger className="w-[100px] h-6 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('fAll')}</SelectItem>
                    <SelectItem value="chat">{t('fChat')}</SelectItem>
                    <SelectItem value="gift">{t('fGift')}</SelectItem>
                    <SelectItem value="like">{t('fLike')}</SelectItem>
                    <SelectItem value="member">{t('fMember')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div ref={feedRef} className="flex-1 min-h-0 bg-secondary/50 border border-border rounded-lg p-2 overflow-y-auto text-xs space-y-1">
              {shown.length === 0 ? (
                <p className="text-muted-foreground inline-flex items-center gap-1.5">
                  <Play className="w-3 h-3" /> Press play to sync chat
                </p>
              ) : (
                shown.map((ev) => (
                  <ChatEventRow
                    key={ev.id}
                    event={ev}
                    timeText={fmtTimeSec(ev.t ?? 0)}
                    keywords={keywords}
                  />
                ))
              )}
            </div>

            <div className="text-xs text-muted-foreground mt-2 px-1 flex justify-between items-center">
              <span className="font-mono">{shown.length} / {events.length}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight }}
              >
                {t('btnJump')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <HighlightsPanel
        recording={file}
        hasEvents={hasEvents}
        durationSec={durationSec}
        onJump={jumpTo}
      />

      <LeaderboardPanel recording={file} hasEvents={hasEvents} />

      <GiftEconomyPanel recording={file} hasEvents={hasEvents} onJump={jumpTo} />

      <WordCloudPanel recording={file} hasEvents={hasEvents} />

      <BookmarksPanel recording={file} currentTime={currentTime} onJump={jumpTo} />

      <footer className="text-center text-xs text-muted-foreground pt-4 border-t border-border/50">
        {t('footerText')}
      </footer>
    </div>
  )
}
