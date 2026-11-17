import { useEffect, useRef } from 'react'

type SseHandlers = Record<string, (data: unknown) => void>

/**
 * Subscribe to Server-Sent Events (/api/events/stream) while enabled and tab is visible.
 * Automatically disconnects when hidden and reconnects when tab returns.
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
  }, [handlers])

  useEffect(() => {
    if (!enabled || !query) return
    let es: EventSource | null = null
    let closed = false

    const connect = () => {
      if (closed || (document.hidden && !keepAliveInBackground) || es) return
      es = new EventSource(`/api/events/stream?${query}`)
      for (const eventName of Object.keys(handlersRef.current)) {
        es.addEventListener(eventName, (ev) => {
          const fn = handlersRef.current[eventName]
          if (!fn) return
          try {
            const parsed: unknown = JSON.parse((ev as MessageEvent).data)
            fn(parsed)
          } catch { /* ignore malformed payload */ }
        })
      }
    }

    const disconnect = () => {
      if (es) {
        es.close()
        es = null
      }
    }

    const onVisibility = () => {
      if (keepAliveInBackground) return
      if (document.hidden) disconnect()
      else connect()
    }

    if (!document.hidden || keepAliveInBackground) connect()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      closed = true
      disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [query, enabled, keepAliveInBackground])
}
