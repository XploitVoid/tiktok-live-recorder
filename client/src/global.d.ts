interface FlvPlayer {
  attachMediaElement: (el: HTMLVideoElement) => void
  load: () => void
  unload: () => void
  play: () => Promise<void>
  destroy: () => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
}

interface FlvJs {
  isSupported: () => boolean
  createPlayer: (mediaDataSource: Record<string, unknown>, config?: Record<string, unknown>) => FlvPlayer
  Events: Record<string, string>
}

interface HlsInstance {
  loadSource: (url: string) => void
  attachMedia: (el: HTMLVideoElement) => void
  destroy: () => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
  startLoad: () => void
  recoverMediaError: () => void
}

interface HlsConstructor {
  isSupported: () => boolean
  new(config?: Record<string, unknown>): HlsInstance
  Events: Record<string, string>
  ErrorTypes: Record<string, string>
}

interface Window {
  flvjs?: FlvJs
  Hls?: HlsConstructor
}

declare const flvjs: FlvJs | undefined
declare const Hls: HlsConstructor | undefined
