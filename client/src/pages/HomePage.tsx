import { useState, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SearchSection } from '@/components/SearchSection'
import { StatusSection, StatusSkeleton } from '@/components/StatusSection'
import { StreamPlayer, BlockedStreams } from '@/components/StreamPlayer'
import { Watchlist } from '@/components/Watchlist'
import { ActiveJobs } from '@/components/ActiveJobs'
import { SavedRecordings } from '@/components/SavedRecordings'
import { SettingsPanel } from '@/components/SettingsPanel'
import { useI18n } from '@/lib/i18n'
import type { CheckResult } from '@/lib/types'
import { toast } from 'sonner'

export function HomePage() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialUsername = searchParams.get('u') || undefined

  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)
  const jobsRef = useRef<{ refresh: () => void }>(null)
  const filesRef = useRef<{ refresh: () => void }>(null)

  const handleLoading = useCallback(() => {
    setLoading(true)
  }, [])

  const handleResult = useCallback(
    (data: CheckResult) => {
      setLoading(false)
      setResult(data)
      if (data.username && searchParams.get('u') !== data.username) {
        setSearchParams({ u: data.username }, { replace: true })
      }
    },
    [searchParams, setSearchParams],
  )

  const handleError = useCallback((msg: string) => {
    setLoading(false)
    toast.error(msg)
  }, [])

  const handleRecordStarted = useCallback(() => {
    jobsRef.current?.refresh()
    setTimeout(() => filesRef.current?.refresh(), 1000)
  }, [])

  const handleJobsChanged = useCallback(() => {
    jobsRef.current?.refresh()
  }, [])

  return (
    <div className="space-y-5">
      <SearchSection
        initialUsername={initialUsername}
        onLoading={handleLoading}
        onResult={handleResult}
        onError={handleError}
      />

      {loading && <StatusSkeleton />}

      {result && !loading && (
        <StatusSection key={`status-${result.username}`} data={result} />
      )}

      {result && result.live && result.streamsAvailable && (
        <StreamPlayer
          key={`player-${result.username}`}
          data={result}
          onRecordStarted={handleRecordStarted}
        />
      )}

      {result && result.live && !result.streamsAvailable && (
        <BlockedStreams key={`blocked-${result.username}`} data={result} />
      )}

      <Watchlist onJobsChanged={handleJobsChanged} />
      <ActiveJobs ref={jobsRef} />
      <SavedRecordings ref={filesRef} />
      <SettingsPanel onCleanup={() => filesRef.current?.refresh()} />

      <footer className="text-center text-xs text-muted-foreground pt-3 pb-6 border-t border-border/50">
        {t('footerText')}
      </footer>
    </div>
  )
}
