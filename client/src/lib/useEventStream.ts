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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
let visibilityBound = false
let lastAuthCheckAt = 0
let authCheckInFlight = false

function buildCombinedQuery(): { url: string | null; keepAlive: boolean } {
  if (subscribers.size === 0) return { url: null, keepAlive: false }
  const channels = new Set<string>()
  let chat: string | null = null
  let sinceId: string | null = null
  let platform: string | null = null
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
      platform = params.get('platform')
    }
  }

  const out = new URLSearchParams()
  if (channels.size > 0) {
    out.set('channels', [...channels].sort().join(','))
  }
  if (chat) {
    out.set('chat', chat)
    if (sinceId !== null) out.set('sinceId', sinceId)
    if (platform) out.set('platform', platform)
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

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function disconnectShared(resetBackoff = true) {
  if (sharedEs) {
    sharedEs.onopen = null
    sharedEs.onerror = null
    sharedEs.close()
    sharedEs = null
  }
  currentUrl = null
  registeredEvents = new Set()
  if (resetBackoff) {
    clearReconnectTimer()
    reconnectAttempt = 0
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const { url, keepAlive } = buildCombinedQuery()
  if (!url || (typeof document !== 'undefined' && document.hidden && !keepAlive)) {
    return
  }
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt))
  reconnectAttempt = Math.min(reconnectAttempt + 1, 6)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    applySharedConnection()
  }, delay)
}

function handleEsError() {
  const isClosed = !sharedEs || sharedEs.readyState === EventSource.CLOSED
  if (isClosed) {
    disconnectShared(false)
  }
  const now = Date.now()
  if (authCheckInFlight || now - lastAuthCheckAt < 5000) {
    if (isClosed) scheduleReconnect()
    return
  }
  lastAuthCheckAt = now
  authCheckInFlight = true
  getAuthStatus()
    .then((s) => {
      if (s.authRequired && !s.authenticated) {
        disconnectShared(true)
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
      } else if (isClosed) {
        scheduleReconnect()
      }
    })
    .catch(() => {
      if (isClosed) scheduleReconnect()
    })
    .finally(() => {
      authCheckInFlight = false
    })
}

function applySharedConnection() {
  const { url, keepAlive } = buildCombinedQuery()
  if (!url || (typeof document !== 'undefined' && document.hidden && !keepAlive)) {
    disconnectShared(true)
    return
  }
  if (sharedEs && sharedEs.readyState !== EventSource.CLOSED && currentUrl === url) {
    syncEventListeners()
    return
  }
  disconnectShared(false)
  clearReconnectTimer()
  currentUrl = url
  sharedEs = new EventSource(url)
  sharedEs.onopen = () => {
    reconnectAttempt = 0
  }
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
  if (typeof document !== 'undefined' && !document.hidden) {
    reconnectAttempt = 0
    clearReconnectTimer()
  }
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
