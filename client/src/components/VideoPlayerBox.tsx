import { useEffect, useRef, useState, useCallback } from 'react'
import { Maximize, Minimize, PictureInPicture2, Scaling, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { toast } from 'sonner'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

interface VideoPlayerBoxProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  muted?: boolean
  src?: string
  showPip?: boolean
  overlay?: React.ReactNode
}

export function VideoPlayerBox({ videoRef, muted = false, src, showPip = true, overlay }: VideoPlayerBoxProps) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fitMode, setFitMode] = useState<'contain' | 'cover' | 'fill'>('contain')
  const [showOverlay, setShowOverlay] = useState(true)
  const pipSupported =
    typeof document !== 'undefined' &&
    Boolean(document.pictureInPictureEnabled) &&
    typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function'

  const cycleFitMode = () => {
    setFitMode((prev) => (prev === 'contain' ? 'cover' : prev === 'cover' ? 'fill' : 'contain'))
  }
  const fitLabel = fitMode === 'contain' ? t('videoFitContain') : fitMode === 'cover' ? t('videoFitCover') : t('videoFitFill')
  const fitTitle = fitMode === 'contain' ? t('videoFitContainTitle') : fitMode === 'cover' ? t('videoFitCoverTitle') : t('videoFitFillTitle')

  useEffect(() => {
    const onFsChange = () => {
      const fsEl = document.fullscreenElement
      setIsFullscreen(
        Boolean(fsEl && (fsEl === containerRef.current || fsEl === videoRef.current)),
      )
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [videoRef])

  const toggleFullscreen = useCallback(async () => {
    const target = containerRef.current || videoRef.current
    if (!target) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await target.requestFullscreen()
      }
    } catch {
      // Fallback to video element fullscreen if container fullscreen is restricted
      try {
        if (!document.fullscreenElement && videoRef.current?.requestFullscreen) {
          await videoRef.current.requestFullscreen()
        }
      } catch {
        toast.error(t('fullscreenNotSupported'))
      }
    }
  }, [t, videoRef])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'f') return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      void toggleFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  const togglePip = () => {
    const v = videoRef.current
    if (!v || !pipSupported || typeof v.requestPictureInPicture !== 'function') {
      toast.error(t('pipNotSupported'))
      return
    }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {})
    } else {
      v.requestPictureInPicture().catch(() =>
        toast.error(t('pipNotSupported')),
      )
    }
  }

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? 'relative group/video w-screen h-screen bg-black flex items-center justify-center'
          : 'relative group/video'
      }
    >
      <video
        ref={videoRef}
        controls
        muted={muted}
        playsInline
        src={src}
        style={{ objectFit: isFullscreen ? fitMode : 'contain' }}
        className={
          isFullscreen
            ? 'w-full h-full bg-black'
            : 'w-full aspect-video bg-black rounded-lg fullscreen:w-full fullscreen:h-full fullscreen:aspect-auto fullscreen:rounded-none'
        }
      />

      <div
        className={`absolute top-2 right-2 z-10 flex items-center gap-1 transition-opacity ${
          isFullscreen ? 'opacity-0 group-hover/video:opacity-100 focus-within:opacity-100' : 'opacity-75 hover:opacity-100'
        }`}
      >
        {isFullscreen && overlay && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => setShowOverlay((v) => !v)}
            className="gap-1 bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-xs cursor-pointer"
          >
            <MessageSquare className="w-3 h-3" />
            <span>{showOverlay ? t('chatOverlayHide') : t('chatOverlayShow')}</span>
          </Button>
        )}
        {isFullscreen && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={cycleFitMode}
            title={fitTitle}
            className="gap-1 bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-xs cursor-pointer"
          >
            <Scaling className="w-3 h-3" />
            <span>{fitLabel}</span>
          </Button>
        )}
        {showPip && pipSupported && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={togglePip}
            title={t('pip')}
            className="gap-1 bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-xs cursor-pointer"
          >
            <PictureInPicture2 className="w-3 h-3" />
            <span>{t('pip')}</span>
          </Button>
        )}

        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={() => void toggleFullscreen()}
          title={isFullscreen ? t('fullscreenExit') : t('fullscreenEnter')}
          aria-label={isFullscreen ? t('fullscreenExit') : t('fullscreenEnter')}
          className="gap-1 bg-black/65 hover:bg-black/85 text-white border border-white/15 backdrop-blur-xs cursor-pointer"
        >
          {isFullscreen ? <Minimize className="w-3 h-3" /> : <Maximize className="w-3 h-3" />}
          <span>{isFullscreen ? t('fullscreenExit') : t('fullscreenEnter')}</span>
        </Button>
      </div>

      {isFullscreen && overlay && showOverlay && (
        <div className="pointer-events-none absolute bottom-14 left-4 z-10 w-80 max-w-[75vw] rounded-lg bg-black/60 backdrop-blur-xs border border-white/10 p-2.5 text-xs text-white space-y-1">
          {overlay}
        </div>
      )}
    </div>
  )
}
