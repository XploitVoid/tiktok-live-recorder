import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Tv } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Header } from '@/components/Header'
import { GridTile } from '@/components/GridTile'
import { useI18n } from '@/lib/i18n'
import { usePoll } from '@/lib/usePoll'
import { getLiveStreams } from '@/lib/api'
import type { CheckResult } from '@/lib/types'

export function GridPage() {
  const { t } = useI18n()
  const [cols, setCols] = useState(3)
  const [quality, setQuality] = useState('ld')
  const [muted, setMuted] = useState(true)
  const [streams, setStreams] = useState<CheckResult[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const list = await getLiveStreams()
      setStreams(list)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-refresh every 60s, but pause when the grid tab is hidden so we
  // don't keep fanning out TikTok lookups for nothing.
  usePoll(refresh, 60000)

  return (
    <div className="max-w-[1600px] mx-auto p-4 md:p-6 space-y-4">
      <Header />

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <div className="flex h-6 items-center gap-1.5 bg-secondary rounded-[min(var(--radius-md),10px)] px-2 py-0 border border-border">
          <span className="text-muted-foreground uppercase tracking-wider font-medium">{t('qualityLabel')}</span>
          <Select value={quality} onValueChange={(v) => v && setQuality(v)}>
            <SelectTrigger size="sm" className="w-[56px] !h-5 text-xs border-0 bg-transparent hover:bg-background/50 rounded-md shadow-none px-1.5">
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
          <Select value={String(cols)} onValueChange={(v) => setCols(Number(v))}>
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

        <Button variant="outline" size="xs" onClick={refresh}>
          <RefreshCw className="w-3 h-3 mr-1" /> {t('btnRefresh')}
        </Button>

        {streams.length > 0 && (
          <span className="text-muted-foreground">· {streams.length} live</span>
        )}

        <span className="text-muted-foreground hidden md:inline">{t('gridWarning')}</span>
      </div>

      {/* Grid */}
      <div
        className="grid gap-4 auto-rows-fr"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {loading ? (
          <div className="col-span-full text-center py-20 rounded-2xl border border-dashed border-border">
            <Tv className="w-12 h-12 mx-auto mb-3 opacity-40 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">{t('loading')}</p>
          </div>
        ) : streams.length === 0 ? (
          <div className="col-span-full text-center py-20 rounded-2xl border border-dashed border-border">
            <div className="text-4xl mb-3 opacity-40">📺</div>
            <p className="text-muted-foreground text-sm">{t('noOneLive')}</p>
          </div>
        ) : (
          streams.map((entry) => (
            <GridTile
              key={entry.username}
              entry={entry}
              quality={quality}
              muted={muted}
            />
          ))
        )}
      </div>

      <footer className="text-center text-xs text-muted-foreground pt-2">
        {t('footerText')}
      </footer>
    </div>
  )
}
