import { useState, useRef, useCallback } from 'react'
import { SearchSection } from '@/components/SearchSection'
import { StatusSection, StatusSkeleton } from '@/components/StatusSection'
import { StreamPlayer, BlockedStreams } from '@/components/StreamPlayer'
import { Watchlist } from '@/components/Watchlist'
import { ActiveJobs, type ActiveJobsRef } from '@/components/ActiveJobs'
import { SavedRecordings, type SavedRecordingsRef } from '@/components/SavedRecordings'
import type { CheckResult } from '@/lib/types'
import { toast } from 'sonner'

export function HomePage() {
  const [result, setResult] = useState<CheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const jobsRef = useRef<ActiveJobsRef>(null)
  const filesRef = useRef<SavedRecordingsRef>(null)

  const handleLoading = useCallback(() => {
    setLoading(true)
  }, [])

  const handleResult = useCallback((data: CheckResult) => {
    setResult(data)
    setLoading(false)
  }, [])

  const handleError = useCallback((msg: string) => {
    setResult(null)
    setLoading(false)
    toast.error('Check failed', { description: msg })
  }, [])

  const handleRecordStarted = useCallback(() => {
    jobsRef.current?.refresh()
    setTimeout(() => filesRef.current?.refresh(), 800)
  }, [])

  const handleJobsChanged = useCallback(() => {
    jobsRef.current?.refresh()
    filesRef.current?.refresh()
  }, [])

  return (
    <div className="space-y-5">
      <SearchSection
        onLoading={handleLoading}
        onResult={handleResult}
        onError={handleError}
      />

      {loading && <StatusSkeleton />}

      {result && !loading && <StatusSection data={result} />}

      {result && result.live && result.streamsAvailable && (
        <StreamPlayer data={result} onRecordStarted={handleRecordStarted} />
      )}

      {result && result.live && !result.streamsAvailable && (
        <BlockedStreams data={result} />
      )}

      <Watchlist onJobsChanged={handleJobsChanged} />
      <ActiveJobs ref={jobsRef} />
      <SavedRecordings ref={filesRef} />

      <footer className="text-center text-xs text-muted-foreground pt-4 pb-6">
        ไม่เป็นทางการ — ใช้ <code className="bg-secondary px-1 rounded">tiktok-live-connector</code> + <code className="bg-secondary px-1 rounded">ffmpeg</code> · กรุณาเคารพข้อกำหนดของ TikTok และเจ้าของไลฟ์
      </footer>
    </div>
  )
}
