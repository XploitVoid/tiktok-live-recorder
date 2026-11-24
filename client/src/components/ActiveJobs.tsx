import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef, useMemo } from 'react'
import { Circle, RefreshCw, Square, Scissors, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { useEventStream } from '@/lib/useEventStream'
import { fmtBytes, fmtDuration, fmtTime } from '@/lib/format'
import { getJobs, stopRecord, cutLiveClip } from '@/lib/api'
import { PlatformBadge } from '@/components/PlatformBadge'
import type { RecordJob } from '@/lib/types'
import { toast } from 'sonner'

export interface ActiveJobsRef {
  refresh: () => void
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export const ActiveJobs = forwardRef<ActiveJobsRef>(function ActiveJobs(_props, ref) {
  const { t } = useI18n()
  const [jobs, setJobs] = useState<RecordJob[]>([])
  const jobsRef = useRef<RecordJob[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [cutting, setCutting] = useState<{ id: number; seconds: number } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getJobs()
      setJobs(data)
      jobsRef.current = data
      setNow(Date.now())
    } catch { /* ignore */ }
  }, [])

  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  const sseHandlers = useMemo(() => ({
    jobs: (data: unknown) => {
      if (Array.isArray(data)) {
        setJobs(data as RecordJob[])
        jobsRef.current = data as RecordJob[]
        setNow(Date.now())
      }
    },
  }), [])

  useEventStream('channels=jobs', sseHandlers, true)

  // Re-render durations every second for active jobs (only while visible)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return
      if (jobsRef.current.some((j) => !j.exited)) setNow(Date.now())
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const handleStop = async (id: number) => {
    try {
      await stopRecord(id)
      toast.info('Recording stopped')
      void refresh()
    } catch (e: unknown) {
      toast.error('Stop failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleLiveClip = async (id: number, seconds: number) => {
    setCutting({ id, seconds })
    try {
      const res = await cutLiveClip(id, seconds)
      toast.success(t('liveClipSaved'), {
        description: res.name,
        action: {
          label: t('btnDownload'),
          onClick: () => triggerDownload(res.url, res.name),
        },
      })
    } catch (e: unknown) {
      toast.error(t('liveClipFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setCutting(null)
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <Circle className="w-4 h-4 text-emerald-400 fill-emerald-400" />
            {t('activeJobs')}
          </h2>
          <Button variant="ghost" size="xs" onClick={refresh}>
            <RefreshCw className="w-3 h-3 mr-1" /> {t('btnRefresh')}
          </Button>
        </div>
        <div className="space-y-1.5 text-sm">
          {jobs.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('noJobs')}</p>
          ) : (
            jobs.map((j) => {
              const elapsed = (j.exited ? (j.exitedAt || now) : now) - j.startedAt
              return (
                <div key={j.id}>
                  <div className="flex items-center gap-2 flex-wrap bg-secondary/70 border border-border/50 rounded-lg px-2.5 py-1.5">
                    <Badge
                      variant={j.exited ? 'secondary' : 'default'}
                      className={j.exited ? 'text-[10px]' : 'bg-primary text-primary-foreground text-[10px] border-0 gap-1'}
                    >
                      {j.exited ? (
                        `EXITED ${j.exitCode ?? ''}`
                      ) : (
                        <>
                          <Circle className="w-2 h-2 fill-current" />
                          <span>REC</span>
                        </>
                      )}
                    </Badge>
                    <PlatformBadge platform={j.platform || 'tiktok'} />
                    <span className="font-medium font-mono text-sm">@{j.username}</span>
                    <span className="text-xs text-muted-foreground font-mono">{j.kind}/{j.quality}</span>
                    {!!j.part && j.part > 1 && (
                      <Badge variant="outline" className="text-[10px]">part {j.part}</Badge>
                    )}
                    {!!j.retryCount && j.retryCount > 0 && (
                      <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-500/40">
                        retry #{j.retryCount}
                      </Badge>
                    )}
                    <span className={`text-xs font-mono ${j.exited ? 'text-muted-foreground' : 'text-emerald-400'}`}>
                      {fmtDuration(elapsed)}
                    </span>
                    {!j.exited && j.stats && (
                      <span className="text-[11px] font-mono text-sky-300/90">
                        {j.stats.fps ? `${j.stats.fps}fps` : ''}
                        {j.stats.bitrate ? ` · ${j.stats.bitrate}` : ''}
                        {j.stats.speed ? ` · ${j.stats.speed}` : ''}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground flex-1 truncate">{j.file}</span>
                    <span className="text-xs text-muted-foreground">{fmtBytes(j.sizeBytes)}</span>
                    <span className="text-xs text-muted-foreground">{fmtTime(j.startedAt)}</span>
                    {!j.exited && (
                      <div className="flex items-center gap-1 shrink-0">
                        {([30, 60] as const).map((sec) => {
                          const isJobCutting = cutting?.id === j.id
                          const isThisCutting = isJobCutting && cutting?.seconds === sec
                          const label = sec === 30 ? t('liveClip30') : t('liveClip60')
                          return (
                            <Button
                              key={sec}
                              variant="outline"
                              size="xs"
                              disabled={isJobCutting}
                              onClick={() => handleLiveClip(j.id, sec)}
                              title={label}
                              aria-label={label}
                              className="h-6 px-1.5 text-[11px] font-mono gap-1"
                            >
                              {isThisCutting
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <Scissors className="w-3 h-3" />}
                              <span>{sec}s</span>
                            </Button>
                          )
                        })}
                        <Button variant="destructive" size="icon-xs" onClick={() => handleStop(j.id)}>
                          <Square className="w-3 h-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {j.lastErr && (
                    <pre className="text-xs text-destructive ml-4 whitespace-pre-wrap mt-0.5">{j.lastErr}</pre>
                  )}
                </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
})
