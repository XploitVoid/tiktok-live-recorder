import { useEffect, useRef } from 'react'

/**
 * Run `fn` on a fixed interval, but pause automatically while the tab is
 * hidden. Resumes (and immediately re-runs once) when the tab becomes
 * visible again.
 *
 * Why: many components in the app poll every 1.5–3s. Without this hook all of
 * them keep firing in background tabs, burning CPU on the client *and*
 * driving up server load even when the user isn't looking. The
 * `visibilitychange` gate is a single-line fix that scales across every
 * polling component.
 */
export function usePoll(fn: () => void | Promise<void>, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const run = () => {
      if (document.hidden || cancelled) return
      try {
        const r = fnRef.current()
        if (r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).catch(() => {})
        }
      } catch {
        // Swallow — polling shouldn't take the page down.
      }
    }

    const start = () => {
      if (timer) return
      // Kick off immediately when (re)starting so the user sees fresh data
      // right away after coming back to the tab.
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
