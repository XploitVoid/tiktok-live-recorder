import { useEffect, useRef } from 'react'
import { getAuthStatus, UNAUTHORIZED_EVENT } from './api'

type SseHandlers = Record<string, (data: unknown) => void>

interface Subscription {
  query: string
  handlersRef: { current: SseHandlers }
  keepAlive: boolean
}

// Shared per-tab SSE multiplexer so multiple components (Watchlist, ActiveJobs,
// SavedRecordings, ChatPanel, HighlightsPanel) share ONE EventSource connection
// instead of exhausting the browser's 6-connection HTTP/1.1 limit.
const subscribers = new Map<symbol, Subscription>()
let sharedEs: EventSource | null = null
let currentUrl: string | null = null
let registeredEvents = new Set<string>()
let syncTimer: ReturnType<typeof setTimeout> | null = null
let visibilityBound = false
let lastAuthCheckAt = 0
let authCheckInFlight = false

function buildCombinedQuery(): { url: string | null; keepAlive: boolean } {
  if (subscribers.size === 0) return { url: null, keepAlive: false }
  const channels = new Set<string>()
  let chat: string | null = null
  let sinceId: string | null = null
  let keepAlive = false

  for (const sub of subscribers.values()) {
    if (sub.keepAlive) keepAlive = true
    const params = new URLSearchParams(sub.query)
    const ch = params.get('channels')
    if (ch) {
      for (const c of ch.split(',').map((s) => s.trim()).filter(Boolean)) {
        channels.add(c)
      }
    }
    const chatParam = params.get('chat')
    if (chatParam) {
      chat = chatParam
      sinceId = params.get('sinceId') ?? '0'
    }
  }

  const out = new URLSearchParams()
  if (channels.size > 0) {
    out.set('channels', [...channels].sort().join(','))
  }
  if (chat) {
    out.set('chat', chat)
    if (sinceId !== null) out.set('sinceId', sinceId)
  }
  const qs = out.toString()
  return { url: qs ? `/api/events/stream?${qs}` : null, keepAlive }
}

function dispatchSseEvent(ev: Event) {
  const me = ev as MessageEvent
  let parsed: unknown
  try {
    parsed = JSON.parse(me.data)
  } catch {
    return
  }
  for (const sub of subscribers.values()) {
    const fn = sub.handlersRef.current[ev.type]
    if (fn) {
      try { fn(parsed) } catch { /* ignore handler errors */ }
    }
  }
}

function syncEventListeners() {
  if (!sharedEs) return
  for (const sub of subscribers.values()) {
    for (const eventName of Object.keys(sub.handlersRef.current)) {
      if (!registeredEvents.has(eventName)) {
        registeredEvents.add(eventName)
        sharedEs.addEventListener(eventName, dispatchSseEvent)
      }
    }
  }
}

function disconnectShared() {
  if (sharedEs) {
    sharedEs.onerror = null
    sharedEs.close()
    sharedEs = null
  }
  currentUrl = null
  registeredEvents = new Set()
}

function handleEsError() {
  const now = Date.now()
  if (authCheckInFlight || now - lastAuthCheckAt < 5000) return
  lastAuthCheckAt = now
  authCheckInFlight = true
  getAuthStatus()
    .then((s) => {
      if (s.authRequired && !s.authenticated) {
        disconnectShared()
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      }
    })
    .catch(() => { /* ignore transient network errors */ })
    .finally(() => {
      authCheckInFlight = false
    })
}

function applySharedConnection() {
  const { url, keepAlive } = buildCombinedQuery()
  if (!url || (typeof document !== 'undefined' && document.hidden && !keepAlive)) {
    disconnectShared()
    return
  }
  if (sharedEs && currentUrl === url) {
    syncEventListeners()
    return
  }
  disconnectShared()
  currentUrl = url
  sharedEs = new EventSource(url)
  sharedEs.onerror = handleEsError
  syncEventListeners()
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  // Coalesce multiple mounts/unmounts in the same render frame into one connection.
  syncTimer = setTimeout(() => {
    syncTimer = null
    applySharedConnection()
  }, 25)
}

function onVisibilityChange() {
  scheduleSync()
}

function ensureVisibilityListener() {
  if (typeof document === 'undefined') return
  if (subscribers.size > 0 && !visibilityBound) {
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  } else if (subscribers.size === 0 && visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
  }
}

/**
 * Subscribe to Server-Sent Events (/api/events/stream) via a shared per-tab
 * connection while enabled and tab is visible.
 */
export function useEventStream(
  query: string | null,
  handlers: SseHandlers,
  enabled = true,
  keepAliveInBackground = false,
) {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
    syncEventListeners()
  }, [handlers])

  useEffect(() => {
    if (!enabled || !query) return
    const id = Symbol('sse-sub')
    subscribers.set(id, { query, handlersRef, keepAlive: keepAliveInBackground })
    ensureVisibilityListener()
    scheduleSync()

    return () => {
      subscribers.delete(id)
      ensureVisibilityListener()
      scheduleSync()
    }
  }, [query, enabled, keepAliveInBackground])
}
