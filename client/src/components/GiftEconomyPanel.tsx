import { useState, useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Gem, BarChart3, MessageSquare, Flame, Gift } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { getGiftEconomy } from '@/lib/api'
import { fmtTimeSec } from '@/lib/format'
import type { GiftEconomyData } from '@/lib/types'

interface Props {
  recording: string
  hasEvents: boolean
  onJump?: (sec: number) => void
}

const MAX_HEATMAP_BINS = 200

export function GiftEconomyPanel({ recording, hasEvents, onJump }: Props) {
  const { t } = useI18n()
  const [result, setResult] = useState<{ key: string; data: GiftEconomyData | null; error: string | null }>({
    key: '',
    data: null,
    error: null,
  })
  const [reloadNonce, setReloadNonce] = useState(0)
  const [mode, setMode] = useState<'gifts' | 'chat'>('gifts')

  const resultKey = `${recording}:${reloadNonce}`
  useEffect(() => {
    if (!hasEvents) return
    let active = true
    getGiftEconomy(recording)
      .then((d) => { if (active) setResult({ key: resultKey, data: d, error: null }) })
      .catch((e: unknown) => {
        console.error('getGiftEconomy:', e)
        if (active) setResult({ key: resultKey, data: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => { active = false }
  }, [recording, hasEvents, resultKey])

  const data = result.key === resultKey ? result.data : null
  const error = result.key === resultKey ? result.error : null
  const loading = hasEvents && result.key !== resultKey

  const bins = useMemo(() => {
    if (!data) return []
    const raw = mode === 'gifts' ? data.giftHeatmap : data.chatHeatmap
    if (!raw.length) return []
    if (raw.length <= MAX_HEATMAP_BINS) {
      return raw.map((val, idx) => ({ val, startSec: idx * data.bucketSec }))
    }
    const groupSize = Math.ceil(raw.length / MAX_HEATMAP_BINS)
    const out: { val: number; startSec: number }[] = []
    for (let i = 0; i < raw.length; i += groupSize) {
      let sum = 0
      const end = Math.min(raw.length, i + groupSize)
      for (let j = i; j < end; j++) sum += raw[j]
      out.push({ val: sum, startSec: i * data.bucketSec })
    }
    return out
  }, [data, mode])

  if (!hasEvents) {
    return (
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-center gap-2 mb-2">
            <Gem className="w-4 h-4 text-pink-400" />
            <h2 className="font-semibold">{t('geTitle')}</h2>
          </div>
          <p className="text-xs text-muted-foreground">{t('lbNoEvents')}</p>
        </CardContent>
      </Card>
    )
  }

  const maxVal = bins.reduce((m, b) => Math.max(m, b.val), 1)

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-pink-400" />
            <h2 className="font-semibold">{t('geTitle')}</h2>
          </div>
          <div className="flex gap-1">
            <Button
              variant={mode === 'gifts' ? 'default' : 'ghost'}
              size="xs"
              onClick={() => setMode('gifts')}
              className={mode === 'gifts' ? 'bg-primary text-primary-foreground border-0' : ''}
            >
              <Gem className="w-3 h-3 mr-1" /> {t('geGifts')}
            </Button>
            <Button
              variant={mode === 'chat' ? 'default' : 'ghost'}
              size="xs"
              onClick={() => setMode('chat')}
              className={mode === 'chat' ? 'bg-sky-600 hover:bg-sky-500 text-white border-0' : ''}
            >
              <MessageSquare className="w-3 h-3 mr-1" /> {t('geChat')}
            </Button>
          </div>
        </div>

        {/* Stats row */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs tabular-nums">
            <StatBox icon={<Gem className="w-3.5 h-3.5 text-primary" />} value={data.totals.diamonds.toLocaleString()} label={t('geTotalDiamonds')} color="text-foreground" />
            <StatBox icon={<BarChart3 className="w-3.5 h-3.5 text-amber-400" />} value={String(data.totals.avgDiamondPerMin)} label={t('geAvgPerMin')} color="text-foreground" />
            <StatBox icon={<Flame className="w-3.5 h-3.5 text-rose-400" />} value={`${data.totals.peakDiamonds}`} label={`${t('gePeak')} @ ${fmtTimeSec(data.totals.peakMomentSec)}`} color="text-foreground" />
            <StatBox icon={<Gift className="w-3.5 h-3.5 text-amber-300" />} value={data.totals.gifts.toLocaleString()} label={t('geTotalGifts')} color="text-foreground" />
          </div>
        )}

        {/* Heatmap bar chart */}
        {data && bins.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              {mode === 'gifts' ? t('geGiftHeatmap') : t('geChatHeatmap')}
            </div>
            <div
              className="flex items-end gap-px h-16 bg-secondary/40 rounded-lg p-1 overflow-hidden cursor-pointer"
              title={t('geClickToJump')}
            >
              {bins.map((bin, idx) => {
                const height = Math.max(2, (bin.val / maxVal) * 100)
                const color = mode === 'gifts'
                  ? bin.val > maxVal * 0.7 ? 'bg-pink-400' : bin.val > maxVal * 0.3 ? 'bg-pink-500/70' : 'bg-pink-600/40'
                  : bin.val > maxVal * 0.7 ? 'bg-sky-400' : bin.val > maxVal * 0.3 ? 'bg-sky-500/70' : 'bg-sky-600/40'
                return (
                  <button
                    key={idx}
                    onClick={() => onJump?.(bin.startSec)}
                    className={`flex-1 min-w-[2px] rounded-t transition-all hover:brightness-125 ${color}`}
                    style={{ height: `${height}%` }}
                    title={`${fmtTimeSec(bin.startSec)}: ${bin.val}${mode === 'gifts' ? ' diamonds' : ' msgs'}`}
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Gift breakdown */}
        {data && data.giftBreakdown.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              {t('geBreakdown')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.giftBreakdown.map((g) => (
                <span
                  key={g.name}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] bg-secondary/80 text-foreground/85 border border-border/70 tabular-nums"
                  title={`${g.diamonds.toLocaleString()} diamonds`}
                >
                  {g.name} ×{g.count}{' '}
                  <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                    ({g.diamonds}<Gem className="w-2.5 h-2.5 text-primary" />)
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {loading && !data && <p className="text-xs text-muted-foreground">{t('loading')}</p>}
        {error && !data && (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <span>{error || t('loadFailed')}</span>
            <Button variant="outline" size="xs" onClick={() => setReloadNonce((n) => n + 1)}>
              {t('retry')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatBox({ icon, value, label, color }: { icon: ReactNode; value: string; label: string; color: string }) {
  return (
    <div className="bg-secondary/60 rounded-lg px-2.5 py-2 border border-border/70">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className={`font-mono font-semibold tabular-nums ${color}`}>{value}</span>
      </div>
      <div className="text-[10px] text-muted-foreground truncate mt-0.5">{label}</div>
    </div>
  )
}
