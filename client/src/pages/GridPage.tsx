import { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Tv, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Header } from '@/components/Header'
import { GridTile, hasPlayableGridStream } from '@/components/GridTile'
import { useI18n } from '@/lib/i18n'
import { usePoll } from '@/lib/usePoll'
import { getLiveStreams } from '@/lib/api'
import type { CheckResult } from '@/lib/types'
import { toast } from 'sonner'

export function GridPage() {
  const { t } = useI18n()
  const [cols, setCols] = useState(3)
  const [quality, setQuality] = useState('ld')
  const [muted, setMuted] = useState(true)
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
}

  const [streams, setStreams] = useState<CheckResult[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [maxTiles, setMaxTiles] = useState(6)
  const mountedRef = useRef(true)
  const reqIdRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    const reqId = ++reqIdRef.current
    setRefreshing(true)
    try {
      const list = await getLiveStreams()
      if (!mountedRef.current || reqId !== reqIdRef.current) return
      setStreams(list)
      setError(null)
    } catch (e: unknown) {
      if (!mountedRef.current || reqId !== reqIdRef.current) return
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      toast.error(t('loadFailed'), { description: msg })
    } finally {
      if (mountedRef.current && reqId === reqIdRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [t])

  // Auto-refresh every 60s (and immediately on mount via usePoll), pausing when hidden.
  usePoll(refresh, 60000)

  const playableStreams = streams.filter((entry) => hasPlayableGridStream(entry, quality, false))

  return (
    <div className="max-w-[1600px] mx-auto p-4 md:p-6 space-y-4">
      <Header />

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <div className="flex h-6 items-center gap-1.5 bg-secondary rounded-[min(var(--radius-md),10px)] px-2 py-0 border border-border">
          <span className="text-muted-foreground uppercase tracking-wider font-medium">{t('qualityLabel')}</span>
          <Select items={{ ld: 'ld (360p)', hd: 'hd (720p)' }} value={quality} onValueChange={(v) => v && setQuality(v)}>
            <SelectTrigger size="sm" className="w-auto min-w-[78px] !h-5 text-xs border-0 bg-transparent hover:bg-background/50 rounded-md shadow-none px-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ld">ld (360p)</SelectItem>
              <SelectItem value="hd">hd (720p)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex h-6 items-center gap-1.5 bg-secondary rounded-[min(var(--radius-md),10px)] px-2 py-0 border border-border">
          <span className="text-muted-foreground uppercase tracking-wider font-medium">{t('colsLabel')}</span>
          <Select items={{ '1': '1', '2': '2', '3': '3', '4': '4', '5': '5' }} value={String(cols)} onValueChange={(v) => setCols(Number(v))}>
            <SelectTrigger size="sm" className="w-[42px] !h-5 text-xs border-0 bg-transparent hover:bg-background/50 rounded-md shadow-none px-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <label className="flex h-6 items-center gap-1.5 bg-secondary rounded-[min(var(--radius-md),10px)] px-2 py-0 border border-border cursor-pointer">
          <Checkbox checked={muted} onCheckedChange={(v) => setMuted(!!v)} className="w-3.5 h-3.5" />
          <span className="text-foreground/80">{t('muteAll')}</span>
        </label>

        <Button variant="outline" size="xs" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`w-3 h-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} /> {t('btnRefresh')}
        </Button>

        {playableStreams.length > 0 && (
          <span className="text-muted-foreground">· {playableStreams.length} {t('gridLiveCount')}</span>
        )}

        <span className="text-muted-foreground hidden md:inline">{t('gridWarning')}</span>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{t('loadFailed')}: {error}</span>
          </div>
          <Button variant="outline" size="xs" onClick={refresh} disabled={refreshing} className="shrink-0">
            {t('retry')}
          </Button>
        </div>
      )}

      {/* Grid */}
      <div className={`grid gap-4 auto-rows-fr ${GRID_COLS[cols] || GRID_COLS[2]}`}>
        {loading ? (
          <div className="col-span-full text-center py-20 rounded-xl border border-dashed border-border">
            <Tv className="w-10 h-10 mx-auto mb-3 opacity-40 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">{t('loading')}</p>
          </div>
        ) : playableStreams.length === 0 ? (
          <div className="col-span-full text-center py-20 rounded-xl border border-dashed border-border space-y-3">
            <Tv className="w-10 h-10 mx-auto opacity-40 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">{t('noOneLive')}</p>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-secondary hover:bg-muted border border-border transition-colors"
            >
              {t('gridOpenHome')}
            </Link>
          </div>
        ) : (
          <>
            {playableStreams.slice(0, maxTiles).map((entry) => (
              <GridTile
                key={`${entry.platform || 'tiktok'}:${entry.username}`}
                entry={entry}
                quality={quality}
                muted={muted}
                preferHls={Math.min(playableStreams.length, maxTiles) >= 4}
              />
            ))}
            {playableStreams.length > maxTiles && (
              <div className="col-span-full flex items-center justify-center py-4">
                <Button variant="outline" size="sm" onClick={() => setMaxTiles((n) => n + 6)}>
                  {t('gridLoadMore')
                    .replace('{n}', String(Math.min(6, playableStreams.length - maxTiles)))
                    .replace('{hidden}', String(playableStreams.length - maxTiles))}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="text-center text-xs text-muted-foreground pt-2">
        {t('footerText')}
      </footer>
    </div>
  )
}
