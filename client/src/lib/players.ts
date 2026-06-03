// players.ts — Lazy-load hls.js and flv.js from CDN.
// These libraries are only needed by pages that play video (Home preview,
// Grid, Replay). Loading them upfront in index.html added ~400KB of blocking
// JS to every page (Dashboard, Watchlist refresh) for no reason.
//
// We keep the CDN URL identical to what was previously hard-coded in
// index.html so cached copies stay valid.

const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js'
const FLV_URL = 'https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js'

let hlsPromise: Promise<void> | null = null
let flvPromise: Promise<void> | null = null
let playersPromise: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
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
    el.async = true
    el.onload = () => {
      el.dataset.loaded = '1'
      resolve()
    }
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}

export function loadHls(): Promise<void> {
  if (typeof window.Hls !== 'undefined') return Promise.resolve()
  if (!hlsPromise) hlsPromise = loadScript(HLS_URL)
  return hlsPromise
}

export function loadFlv(): Promise<void> {
  if (typeof window.flvjs !== 'undefined') return Promise.resolve()
  if (!flvPromise) flvPromise = loadScript(FLV_URL)
  return flvPromise
}

// Load both in parallel — used by pages that need to choose at runtime.
export function loadPlayers(): Promise<void> {
  if (!playersPromise) {
    playersPromise = Promise.all([loadHls(), loadFlv()]).then(() => undefined)
  }
  return playersPromise
}
