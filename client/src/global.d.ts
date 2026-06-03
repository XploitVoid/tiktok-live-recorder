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
  createPlayer: (config: Record<string, unknown>) => FlvPlayer
  Events: Record<string, string>
}

interface HlsInstance {
  loadSource: (url: string) => void
  attachMedia: (el: HTMLVideoElement) => void
  destroy: () => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
  recoverMediaError: () => void
}

interface HlsConstructor {
  isSupported: () => boolean
  new(): HlsInstance
  Events: Record<string, string>
}

interface Window {
  flvjs?: FlvJs
  Hls?: HlsConstructor
}

declare const flvjs: FlvJs | undefined
declare const Hls: HlsConstructor | undefined
