import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { Circle, RefreshCw, Square } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { usePoll } from '@/lib/usePoll'
import { fmtBytes, fmtDuration, fmtTime } from '@/lib/format'
import { getJobs, stopRecord } from '@/lib/api'
import type { RecordJob } from '@/lib/types'
import { toast } from 'sonner'

export interface ActiveJobsRef {
  refresh: () => void
}

export const ActiveJobs = forwardRef<ActiveJobsRef>(function ActiveJobs(_props, ref) {
  const { t } = useI18n()
  const [jobs, setJobs] = useState<RecordJob[]>([])
  const jobsRef = useRef<RecordJob[]>([])
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const data = await getJobs()
      setJobs(data)
      jobsRef.current = data
    } catch { /* ignore */ }
  }, [])

  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  // Pause polling when the tab is hidden so we don't keep hitting /api/record/jobs
  // while the user is on another tab.
  usePoll(refresh, 3000)

  // Re-render durations every second for active jobs (only while visible)
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return
      if (jobsRef.current.some(j => !j.exited)) setTick(n => n + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const handleStop = async (id: number) => {
    try {
      await stopRecord(id)
      toast.info('Recording stopped')
      refresh()
    } catch (e: unknown) {
      toast.error('Stop failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const now = Date.now()

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
                  <div className="flex items-center gap-2 bg-secondary rounded-lg px-2 py-1.5">
                    <Badge
                      variant={j.exited ? 'secondary' : 'default'}
                      className={j.exited ? 'text-[10px]' : 'bg-emerald-600 text-white text-[10px] border-0'}
                    >
                      {j.exited ? `EXITED ${j.exitCode ?? ''}` : '● REC'}
                    </Badge>
                    <span className="font-medium">@{j.username}</span>
                    <span className="text-xs text-muted-foreground">{j.kind}/{j.quality}</span>
                    <span className={`text-xs font-mono ${j.exited ? 'text-muted-foreground' : 'text-emerald-400'}`}>
                      {fmtDuration(elapsed)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-1 truncate">{j.file}</span>
                    <span className="text-xs text-muted-foreground">{fmtBytes(j.sizeBytes)}</span>
                    <span className="text-xs text-muted-foreground">{fmtTime(j.startedAt)}</span>
                    {!j.exited && (
                      <Button variant="destructive" size="icon-xs" onClick={() => handleStop(j.id)}>
                        <Square className="w-3 h-3" />
                      </Button>
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
