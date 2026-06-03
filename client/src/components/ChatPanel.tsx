import { useState, useRef, useEffect, useCallback } from 'react'
import { Sparkles, X, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18n } from '@/lib/i18n'
import { startChat, stopChat, getChatEvents } from '@/lib/api'
import { fmtTime } from '@/lib/format'
import { getKeywords, addKeyword, removeKeyword } from '@/lib/chatHighlight'
import { HighlightText } from '@/components/HighlightText'
import { Avatar } from '@/components/Avatar'
import type { ChatEvent } from '@/lib/types'

// Simple client-side spam heuristic (mirrors lib/analytics.js spamScore)
function isSpam(comment: string | undefined): boolean {
  if (!comment) return false
  let score = 0
  const len = comment.length
  if (len <= 3 && /^(.)\1+$/.test(comment)) score += 40
  const emojiMatches = comment.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []
  const emojiRatio = emojiMatches.length / Math.max(1, [...comment].length)
  if (emojiRatio > 0.7 && len > 4) score += 30
  if (/(.)\1{5,}/.test(comment)) score += 25
  if (/https?:\/\//i.test(comment)) score += 50
  const words = comment.split(/\s+/)
  if (words.length >= 4) {
    const unique = new Set(words.map((w) => w.toLowerCase()))
    if (unique.size <= 2) score += 35
  }
  return score >= 40
}

interface Props {
  username: string
}

export function ChatPanel({ username }: Props) {
  const { t } = useI18n()
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [state, setState] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [eventCount, setEventCount] = useState(0)
  const [keywords, setKeywords] = useState<string[]>(getKeywords())
  const [kwInput, setKwInput] = useState('')
  const [hideSpam, setHideSpam] = useState(false)
  const [pinnedMessage, setPinnedMessage] = useState<{ text: string; user: string } | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const lastIdRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const usernameRef = useRef(username)

  usernameRef.current = username

  const refreshKeywords = useCallback(() => setKeywords(getKeywords()), [])

  const handleAddKeyword = () => {
    const w = kwInput.trim()
    if (!w) return
    addKeyword(w)
    setKwInput('')
    refreshKeywords()
  }

  const handleRemoveKeyword = (w: string) => {
    removeKeyword(w)
    refreshKeywords()
  }

  const poll = useCallback(async () => {
    try {
      const result = await getChatEvents(usernameRef.current, lastIdRef.current)
      setState(result.state + (result.viewerCount != null ? ` · 👁 ${result.viewerCount}` : ''))
      if (result.events?.length) {
        for (const ev of result.events) {
          lastIdRef.current = Math.max(lastIdRef.current, ev.id)
        }
        setEvents(prev => {
          const next = [...prev, ...result.events!].slice(-300)
          return next
        })
        setEventCount(prev => prev + result.events!.length)
        // Track pinned message
        for (const ev of result.events!) {
          if (ev.type === 'roomPin') {
            if (ev.action === 'unpin') {
              setPinnedMessage(null)
            } else if (ev.pinnedText) {
              setPinnedMessage({
                text: ev.pinnedText,
                user: ev.pinnedUser?.nickname || ev.pinnedUser?.uniqueId || '?',
              })
            }
          }
        }
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [events, autoScroll])

  const handleStart = async () => {
    lastIdRef.current = 0
    setEventCount(0)
    setEvents([])
    setState('connecting...')
    try {
      await startChat(username)
      poll()
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(() => {
        // Skip while the tab is hidden — events queue server-side and we
        // catch up from `lastIdRef` once the user comes back.
        if (document.hidden) return
        poll()
      }, 1500)
    } catch (e: unknown) {
      setState('error: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const handleStop = async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setState('stopping...')
    try { await stopChat(username) } catch { /* ignore */ }
    setState('stopped')
  }

  // Reset all chat state when the target username changes (e.g. user searches
  // for a different streamer). Without this, the old user's events remain in
  // view and lastIdRef holds stale ids that cause the new user's first events
  // to be filtered out as "already seen".
  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    lastIdRef.current = 0
    setEvents([])
    setEventCount(0)
    setState('')
  }, [username])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // When the tab regains focus, do an immediate catch-up poll so the user
  // sees fresh events right away rather than waiting up to 1.5s.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden && timerRef.current) {
        poll()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [poll])

  return (
    <div className="flex flex-col h-full min-h-[300px] overflow-hidden">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-foreground flex items-center gap-2">
          💬 Chat
          <span className="text-xs text-muted-foreground font-normal">{state && ` · ${state}`}</span>
        </h2>
        <div className="flex gap-1">
          <Button size="xs" onClick={handleStart} className="bg-pink-600 hover:bg-pink-500 text-white border-0">
            {t('chatStart')}
          </Button>
          <Button size="xs" variant="secondary" onClick={handleStop}>
            {t('chatStop')}
          </Button>
        </div>
      </div>

      {/* Keyword highlight bar */}
      <div className="flex items-center gap-1 flex-wrap mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold flex items-center gap-0.5">
          <Sparkles className="w-3 h-3" /> {t('chatHighlight')}
        </span>
        {keywords.map((kw) => (
          <span key={kw} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/20">
            {kw}
            <button onClick={() => handleRemoveKeyword(kw)} className="hover:text-red-400"><X className="w-2.5 h-2.5" /></button>
          </span>
        ))}
        <input
          value={kwInput}
          onChange={(e) => setKwInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
          placeholder={t('chatFilterPlaceholder')}
          className="h-5 px-1.5 text-[10px] bg-transparent border border-zinc-700 rounded-full outline-none focus:border-amber-500/50 text-zinc-300 placeholder:text-zinc-600 w-28"
        />
      </div>

      {/* Pinned message sticky bar */}
      {pinnedMessage && (
        <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-500/10 border border-indigo-500/30 rounded-lg text-xs mb-1">
          <span className="text-indigo-400 font-semibold shrink-0">📌</span>
          <span className="flex-1 min-w-0 truncate text-foreground/90">
            <strong className="text-indigo-300">{pinnedMessage.user}</strong>: {pinnedMessage.text}
          </span>
          <button onClick={() => setPinnedMessage(null)} className="text-muted-foreground hover:text-foreground text-[10px]">✕</button>
        </div>
      )}

      <div ref={feedRef} className="flex-1 min-h-0 bg-secondary rounded-lg p-2 overflow-y-auto text-xs space-y-1">
        {events.length === 0 ? (
          <p className="text-muted-foreground">— กด "{t('chatStart')}" เพื่อดูแชทสด —</p>
        ) : (
          events
            .filter((ev) => !hideSpam || ev.type !== 'chat' || !isSpam(ev.comment))
            .map((ev) => <ChatLine key={ev.id} event={ev} keywords={keywords} />)
        )}
      </div>
      <div className="text-xs text-muted-foreground mt-1 flex justify-between items-center">
        <span>{eventCount} events</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={hideSpam}
              onCheckedChange={(v) => setHideSpam(!!v)}
              className="w-3.5 h-3.5"
            />
            <ShieldOff className="w-3 h-3" />
            {t('spamHide')}
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <Checkbox
              checked={autoScroll}
              onCheckedChange={(v) => setAutoScroll(!!v)}
              className="w-3.5 h-3.5"
            />
            {t('autoScroll')}
          </label>
        </div>
      </div>
    </div>
  )
}

function ChatLine({ event: ev, keywords }: { event: ChatEvent; keywords: string[] }) {
  const time = <span className="text-muted-foreground">{fmtTime(ev.ts)}</span>
  const name = ev.user?.nickname || ev.user?.uniqueId || '?'
  const avatar = (
    <Avatar url={ev.user?.profilePictureUrl} name={name} size={24} className="mt-0.5" />
  )

  switch (ev.type) {
    case 'chat':
      return <div className="flex items-start gap-1.5 py-0.5">{avatar}<span className="flex-1 min-w-0 leading-snug break-words">{time} <strong className="text-sky-400">{name}</strong>: <HighlightText text={ev.comment || ''} keywords={keywords} className="text-foreground/90" /></span></div>
    case 'gift':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} 🎁 <strong className="text-amber-400">{name}</strong> sent <em className="not-italic text-amber-300">{ev.giftName}</em> ×{ev.repeatCount || 1} <span className="text-amber-200">({ev.diamondCount || 0}💎)</span></span></div>
    case 'like':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ❤️ <strong className="text-rose-400">{name}</strong> liked ×{ev.likeCount || 1}</span></div>
    case 'member':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words text-foreground/70">{time} 👋 {name} joined</span></div>
    case 'social': case 'follow':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ➕ <strong className="text-emerald-400">{name}</strong> <span className="text-foreground/70">{ev.label || 'followed'}</span></span></div>
    case 'share':
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ↗ <strong className="text-cyan-400">{name}</strong> shared</span></div>
    case 'connected':
      return <div>{time} <span className="text-emerald-500">✓ connected to room {ev.roomId || ''}</span></div>
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
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} ⭐ <strong className="text-yellow-400">{name}</strong> subscribed!</span></div>
    case 'envelope':
      return <div>{time} <span className="text-red-400">🧧 Treasure box / Red envelope!</span></div>
    case 'question':
      return <div className="flex items-start gap-1.5 py-0.5">{avatar}<span className="flex-1 min-w-0 leading-snug break-words">{time} ❓ <strong className="text-violet-400">{name}</strong>: <span className="text-foreground/90 italic">{ev.comment || ''}</span></span></div>
    case 'liveIntro':
      return <div>{time} <span className="text-indigo-400">📢 {ev.introText || 'Live intro'}</span></div>
    case 'emote': {
      const emoteImgs = (ev.emotes || []).map((em, i) => (
        em.imageUrl
          ? <img key={i} src={em.imageUrl} alt="emote" className="inline-block w-6 h-6 mx-0.5" loading="lazy" referrerPolicy="no-referrer" />
          : <span key={i} className="text-muted-foreground">[emote]</span>
      ))
      return <div className="flex items-center gap-1.5 py-0.5">{avatar}<span className="min-w-0 break-words">{time} <strong className="text-purple-400">{name}</strong> {emoteImgs}</span></div>
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
