import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Sparkles, X, ShieldOff, MessageSquare, Pin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useI18n } from '@/lib/i18n'
import { startChat, stopChat } from '@/lib/api'
import { useEventStream } from '@/lib/useEventStream'
import { fmtTime } from '@/lib/format'
import { getKeywords, addKeyword, removeKeyword } from '@/lib/chatHighlight'
import { ChatEventRow } from '@/components/ChatEventRow'
import type { ChatEvent, ChatPollResult } from '@/lib/types'

function isSpam(comment: string | undefined): boolean {
  if (!comment) return false
  let score = 0
  const len = comment.length
  if (len <= 3 && /^(.)\1+$/.test(comment)) score += 40
  const emojiMatches = comment.match(/\p{Extended_Pictographic}/gu) || []
  const emojiRatio = emojiMatches.length / Math.max(1, [...comment].length)
  if (emojiRatio > 0.7 && len > 4) score += 30
  if (/(.)\1{5,}/.test(comment)) score += 25
  if (len > 10 && comment === comment.toUpperCase() && /[A-Z]/.test(comment)) score += 15
  if (/https?:\/\//i.test(comment)) score += 50
  if (/\b(follow|subscribe|check|click|link|bio)\b/i.test(comment) && /https?:\/\//i.test(comment)) score += 30
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
  const [streaming, setStreaming] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [eventCount, setEventCount] = useState(0)
  const [keywords, setKeywords] = useState<string[]>(getKeywords())
  const [kwInput, setKwInput] = useState('')
  const [hideSpam, setHideSpam] = useState(false)
  const [pinnedMessage, setPinnedMessage] = useState<{ text: string; user: string } | null>(null)
  const [connectSinceId, setConnectSinceId] = useState(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const lastIdRef = useRef(0)
  const streamingRef = useRef(false)
  const activeUserRef = useRef<string | null>(username)

  useEffect(() => {
    streamingRef.current = streaming
  }, [streaming])

  useEffect(() => {
    activeUserRef.current = username
    return () => {
      activeUserRef.current = null
      if (streamingRef.current) {
        void stopChat(username).catch(() => {})
      }
    }
  }, [username])

  const refreshKeywords = useCallback(() => setKeywords(getKeywords()), [])

  const handleAddKeyword = () => {
    const tokens = kwInput.split(',').map((s) => s.trim()).filter(Boolean)
    if (!tokens.length) return
    for (const token of tokens) {
      addKeyword(token)
    }
    setKwInput('')
    refreshKeywords()
  }

  const handleRemoveKeyword = (w: string) => {
    removeKeyword(w)
    refreshKeywords()
  }

  const ingestEvents = useCallback((incoming: ChatEvent[], nextState: string, viewerCount?: number) => {
    setState(nextState + (viewerCount != null ? ` · ${viewerCount.toLocaleString()}` : ''))
    if (!incoming.length) return
    const fresh = incoming.filter((ev) => ev.id > lastIdRef.current)
    if (!fresh.length) return
    for (const ev of fresh) {
      lastIdRef.current = Math.max(lastIdRef.current, ev.id)
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
    setEvents((prev) => [...prev, ...fresh].slice(-300))
    setEventCount((prev) => prev + fresh.length)
  }, [])

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        setConnectSinceId(lastIdRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const sseQuery = streaming ? `chat=${encodeURIComponent(username)}&sinceId=${connectSinceId}` : null
  const sseHandlers = useMemo(() => ({
    chat_snapshot: (raw: unknown) => {
      const snap = raw as ChatPollResult
      ingestEvents(snap.events || [], snap.state, snap.viewerCount)
    },
    chat_event: (raw: unknown) => {
      const msg = raw as { event: ChatEvent; state: string; viewerCount?: number }
      if (msg?.event) ingestEvents([msg.event], msg.state, msg.viewerCount)
    },
    chat_state: (raw: unknown) => {
      const msg = raw as { state: string; error?: string; viewerCount?: number }
      if (msg?.state) {
        setState(msg.state + (msg.viewerCount != null ? ` · ${msg.viewerCount.toLocaleString()}` : ''))
      }
    },
  }), [ingestEvents])

  useEventStream(sseQuery, sseHandlers, streaming)

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [events, autoScroll])

  const handleStart = async () => {
    if (streaming || connecting) return
    const targetUser = username
    setConnecting(true)
    lastIdRef.current = 0
    setConnectSinceId(0)
    setEventCount(0)
    setEvents([])
    setPinnedMessage(null)
    setState('connecting...')
    try {
      await startChat(targetUser)
      if (activeUserRef.current !== targetUser) {
        void stopChat(targetUser).catch(() => {})
        return
      }
      streamingRef.current = true
      setStreaming(true)
    } catch (e: unknown) {
      if (activeUserRef.current === targetUser) {
        setState('error: ' + (e instanceof Error ? e.message : String(e)))
      }
    } finally {
      if (activeUserRef.current === targetUser) {
        setConnecting(false)
      }
    }
  }

  const handleStop = async () => {
    streamingRef.current = false
    setStreaming(false)
    setState('stopping...')
    try { await stopChat(username) } catch { /* ignore */ }
    setState('stopped')
  }

  return (
    <div className="flex flex-col h-full min-h-[300px] overflow-hidden">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-foreground flex items-center gap-2 text-sm">
          <MessageSquare className="w-4 h-4 text-muted-foreground" />
          <span>Chat</span>
          {state && <span className="text-xs text-muted-foreground font-normal font-mono tabular-nums">· {state}</span>}
        </h2>
        <div className="flex gap-1">
          <Button size="xs" onClick={handleStart} disabled={streaming || connecting} className="cursor-pointer">
            {t('chatStart')}
          </Button>
          <Button size="xs" variant="secondary" onClick={handleStop} disabled={!streaming} className="cursor-pointer">
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
          <Pin className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <span className="flex-1 min-w-0 truncate text-foreground/90">
            <strong className="text-indigo-300">{pinnedMessage.user}</strong>: {pinnedMessage.text}
          </span>
          <button
            type="button"
            onClick={() => setPinnedMessage(null)}
            className="text-muted-foreground hover:text-foreground p-0.5 cursor-pointer"
            aria-label="Dismiss pinned message"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div ref={feedRef} className="flex-1 min-h-0 bg-secondary/70 border border-border/50 rounded-lg p-2 overflow-y-auto text-xs space-y-1">
        {events.length === 0 ? (
          <p className="text-muted-foreground">{t('chatEmptyHint').replace('{action}', t('chatStart'))}</p>
        ) : (
          events
            .filter((ev) => !hideSpam || ev.type !== 'chat' || !isSpam(ev.comment))
            .map((ev) => (
              <ChatEventRow key={ev.id} event={ev} timeText={fmtTime(ev.ts)} keywords={keywords} />
            ))
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


