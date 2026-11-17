// players.ts — Lazy-load hls.js and flv.js from CDN with Subresource Integrity.
// These libraries are only needed by pages that play video (Home preview,
// Grid, Replay). Loading them upfront in index.html added ~400KB of blocking
// JS to every page (Dashboard, Watchlist refresh) for no reason.

const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'
const HLS_SRI = 'sha384-9v3HcdYrO3D+OPDTjZ40RXocgE4GtXVCd3/mCS62JsM93JXgI1afJVuwjFvsu6ni'

const FLV_URL = 'https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js'
const FLV_SRI = 'sha384-XeE1sKdKcsuvSZKnQHiuBPgM5gqTRLXKh/IUe1bgkTTQcwLOid3l8tq+uJRKe5zQ'

let hlsPromise: Promise<void> | null = null
let flvPromise: Promise<void> | null = null
let playersPromise: Promise<void> | null = null

function loadScript(src: string, integrity: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if a previous tag already exists (HMR / page reload race).
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)))
      return
    }
    const el = document.createElement('script')
    el.src = src
    el.integrity = integrity
    el.crossOrigin = 'anonymous'
    el.async = true
    el.onload = () => {
      el.dataset.loaded = '1'
      resolve()
    }
    el.onerror = () => {
      el.remove()
      reject(new Error(`failed to load ${src}`))
    }
    document.head.appendChild(el)
  })
}

export function loadHls(): Promise<void> {
  if (typeof window.Hls !== 'undefined') return Promise.resolve()
  if (!hlsPromise) {
    hlsPromise = loadScript(HLS_URL, HLS_SRI).catch((err) => {
      hlsPromise = null
      throw err
    })
  }
  return hlsPromise
}

export function loadFlv(): Promise<void> {
  if (typeof window.flvjs !== 'undefined') return Promise.resolve()
  if (!flvPromise) {
    flvPromise = loadScript(FLV_URL, FLV_SRI).catch((err) => {
      flvPromise = null
      throw err
    })
  }
  return flvPromise
}

// Load both in parallel — used by pages that need to choose at runtime.
export function loadPlayers(): Promise<void> {
  if (!playersPromise) {
    playersPromise = Promise.all([loadHls(), loadFlv()])
      .then(() => undefined)
      .catch((err) => {
        playersPromise = null
        throw err
      })
  }
  return playersPromise
}
