import { useEffect, useRef } from 'react'

export function usePoll(fn: () => void | Promise<void>, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const run = () => {
      if (document.hidden || cancelled) return
      try {
        const r = fnRef.current()
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).catch(() => { /* ignore */ })
        }
      } catch {
        // Swallow — polling shouldn't take the page down.
      }
    }

    const start = () => {
      if (timer) return
      run()
      timer = setInterval(run, intervalMs)
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, enabled])
}
