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
import type { CheckResult, Platform } from '@/lib/types'
import { toast } from 'sonner'

export function HomePage() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialUsername = searchParams.get('u') || undefined
  const rawPlatform = searchParams.get('platform')
  const initialPlatform: Platform = rawPlatform === 'twitch' ? 'twitch' : 'tiktok'

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
      if (data.username) {
        const plat: Platform = data.platform || 'tiktok'
        const nextPlatParam = plat !== 'tiktok' ? plat : null
        setSearchParams(
          (prev) => {
            if (prev.get('u') === data.username && prev.get('platform') === nextPlatParam) {
              return prev
            }
            const nextParams: Record<string, string> = nextPlatParam
              ? { u: data.username, platform: nextPlatParam }
              : { u: data.username }
            return nextParams
          },
          { replace: true },
        )
      }
    },
    [setSearchParams],
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
        initialPlatform={initialPlatform}
        onLoading={handleLoading}
        onResult={handleResult}
        onError={handleError}
      />

      {loading && <StatusSkeleton />}

      {result && !loading && (
        <StatusSection key={`status-${result.platform || 'tiktok'}-${result.username}`} data={result} />
      )}

      {result && result.live && result.streamsAvailable && (
        <StreamPlayer
          key={`player-${result.platform || 'tiktok'}-${result.username}`}
          data={result}
          onRecordStarted={handleRecordStarted}
        />
      )}

      {result && result.live && !result.streamsAvailable && (
        <BlockedStreams key={`blocked-${result.platform || 'tiktok'}-${result.username}`} data={result} />
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
