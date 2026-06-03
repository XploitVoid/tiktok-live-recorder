import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
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
import { useI18n } from '@/lib/i18n'
import { getReplayData } from '@/lib/api'
import { fmtTimeSec } from '@/lib/format'
import type { ChatEvent } from '@/lib/types'
import { getKeywords } from '@/lib/chatHighlight'
import { HighlightText } from '@/components/HighlightText'
import { Avatar } from '@/components/Avatar'

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

  const passesFilter = useCallback((ev: ReplayEvent) => {
    if (filter === 'all') return true
    if (filter === 'chat') return ev.type === 'chat'
    if (filter === 'gift') return ev.type === 'gift'
    if (filter === 'like') return ev.type === 'like'
    if (filter === 'member') return ev.type === 'member' || ev.type === 'follow' || ev.type === 'social'
    // PK events always show in 'all', never in specific filters (they're system events)
    return true
  }, [filter])

  const syncToTime = useCallback((time: number) => {
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
      if (passesFilter(ev)) newItems.push(ev)
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
        setInfo({
          start: data.startMs ? `▶ started ${new Date(data.startMs).toLocaleString()}` : '',
          events: data.eventsExists ? `💬 ${data.eventCount} events` : '⚠ no chat sidecar',
          size: data.sizeBytes ? `${(data.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '',
        })
        setHasEvents(!!data.eventsExists)
        const sorted = (data.events || [])
          .filter(e => e.t == null || e.t >= 0)
          .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
        setEvents(sorted)
      } catch (e) {
        console.error(e)
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
    setFilter(value)
    pointerRef.current = 0
    shownIdsRef.current.clear()
    lastTimeRef.current = 0
    setShown([])
    if (videoRef.current) {
      syncToTime(videoRef.current.currentTime)
    }
  }

  if (!file) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
        <Header />
        <Card>
          <CardContent className="pt-5">
            <p className="text-destructive">missing ?file=...</p>
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
            <video
              ref={videoRef}
              controls
              playsInline
              className="w-full aspect-video bg-black rounded-lg"
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
              <h2 className="font-semibold flex items-center gap-2 text-foreground">
                <span className="text-pink-400">💬</span> {t('chatSync')}
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
                <p className="text-muted-foreground">▶ press play on the video</p>
              ) : (
                shown.map((ev) => <ReplayLine key={ev.id} event={ev} keywords={keywords} />)
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

      <footer className="text-center text-xs text-muted-foreground pt-4">
        แชทจะแสดงตามเวลาของวิดีโอโดยเทียบ <code className="bg-secondary px-1 rounded">video.currentTime</code> กับ <code className="bg-secondary px-1 rounded">event.t</code>
      </footer>
    </div>
  )
}

function ReplayLine({ event: ev, keywords }: { event: ReplayEvent; keywords: string[] }) {
  const time = <span className="text-muted-foreground font-mono">{fmtTimeSec(ev.t ?? 0)}</span>
  const u = ev.user?.nickname || ev.user?.uniqueId || '?'
  const avatar = (
    <Avatar url={ev.user?.profilePictureUrl} name={u} size={24} className="mt-0.5" />
  )

  switch (ev.type) {
    case 'chat':
      return <div className="flex items-start gap-1.5 py-0.5">{avatar}<span className="flex-1 min-w-0 leading-snug break-words">{time} <strong className="text-sky-400">{u}</strong>: <HighlightText text={ev.comment || ''} keywords={keywords} className="text-foreground/90" /></span></div>
    case 'gift':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} 🎁 <strong className="text-amber-400">{u}</strong> sent <em className="not-italic text-amber-300">{ev.giftName}</em> ×{ev.repeatCount || 1} <span className="text-amber-200">({ev.diamondCount || 0}💎)</span></span></div>
    case 'like':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ❤️ <strong className="text-rose-400">{u}</strong> liked ×{ev.likeCount || 1}</span></div>
    case 'member':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words text-foreground/70">{time} 👋 {u} joined</span></div>
    case 'social': case 'follow':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ➕ <strong className="text-emerald-400">{u}</strong> <span className="text-foreground/70">{ev.label || 'followed'}</span></span></div>
    case 'share':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ↗ <strong className="text-cyan-400">{u}</strong> shared</span></div>
    case 'connected':
      return <div>{time} <span className="text-emerald-500">✓ connected room {ev.roomId || ''}</span></div>
    case 'pkStart': {
      const opps = (ev.battleUsers || [])
        .map((u) => u.nickname || u.uniqueId)
        .filter(Boolean)
        .join(' vs ')
      return <div>{time} <span className="text-fuchsia-400">⚔ PK started{opps ? ` — ${opps}` : ''}</span></div>
    }
    case 'pkUpdate': {
      const score = (ev.teams || []).map((tm) => tm.score).join(' : ')
      return <div className="text-fuchsia-300/70 text-[11px]">{time} <span>⚔ {score}{ev.totalDiamondCount ? ` · ${ev.totalDiamondCount} 💎` : ''}</span></div>
    }
    case 'pkEnd': {
      const score = (ev.teams || []).map((tm) => tm.score).join(' : ')
      return <div>{time} <span className="text-fuchsia-400">🏁 PK ended{score ? ` — ${score}` : ''}</span></div>
    }
    case 'subscribe':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ⭐ <strong className="text-yellow-400">{u}</strong> subscribed!</span></div>
    case 'envelope':
      return <div>{time} <span className="text-red-400">🧧 Treasure box / Red envelope!</span></div>
    case 'question':
      return <div className="flex items-start gap-1.5 py-0.5">{avatar}<span className="flex-1 min-w-0 leading-snug break-words">{time} ❓ <strong className="text-violet-400">{u}</strong>: <span className="text-foreground/90 italic">{ev.comment || ''}</span></span></div>
    case 'liveIntro':
      return <div>{time} <span className="text-indigo-400">📢 {ev.introText || 'Live intro'}</span></div>
    case 'emote': {
      const emoteImgs = (ev.emotes || []).map((em, i) => (
        em.imageUrl
          ? <img key={i} src={em.imageUrl} alt="emote" className="inline-block w-6 h-6 mx-0.5" loading="lazy" referrerPolicy="no-referrer" />
          : <span key={i} className="text-muted-foreground">[emote]</span>
      ))
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} <strong className="text-purple-400">{u}</strong> {emoteImgs}</span></div>
    }
    case 'caption':
      return <div className="py-0.5 text-foreground/60 italic">{time} <span className="text-cyan-400/70">🎙</span> {ev.text}</div>
    case 'roomPin':
      if (ev.action === 'unpin') return <div className="text-muted-foreground">{time} 📌 unpinned</div>
      return <div>{time} <span className="text-indigo-400">📌 pinned: <strong>{ev.pinnedUser?.nickname || '?'}</strong>: {ev.pinnedText || ''}</span></div>
    case 'rankUpdate':
      return <div className="text-amber-400/70">{time} 🏆 {(ev.updates || []).map((u) => `rank ${u.ownerRank}`).join(', ')}</div>
    case 'streamEnd':
      return <div>{time} <span className="text-amber-500">⏹ stream ended</span></div>
    case 'error':
      return <div>{time} <span className="text-destructive">! {ev.error}</span></div>
    case 'roomUser':
      return null
    default:
      return <div>{time} <span className="text-muted-foreground">{ev.type}</span></div>
  }
}
