import { useState, useEffect, useCallback } from 'react'
import { Gem, BarChart3 } from 'lucide-react'
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

export function GiftEconomyPanel({ recording, hasEvents, onJump }: Props) {
  const { t } = useI18n()
  const [data, setData] = useState<GiftEconomyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'gifts' | 'chat'>('gifts')

  const refresh = useCallback(async () => {
    if (!hasEvents) return
    setLoading(true)
    try {
      const d = await getGiftEconomy(recording)
      setData(d)
    } catch (e) {
      console.error('getGiftEconomy:', e)
    } finally {
      setLoading(false)
    }
  }, [recording, hasEvents])

  useEffect(() => { refresh() }, [refresh])

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

  const heatmap = data ? (mode === 'gifts' ? data.giftHeatmap : data.chatHeatmap) : []
  const maxVal = Math.max(1, ...heatmap)

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
              className={mode === 'gifts' ? 'bg-pink-600 hover:bg-pink-500 text-white border-0' : ''}
            >
              💎 {t('geGifts')}
            </Button>
            <Button
              variant={mode === 'chat' ? 'default' : 'ghost'}
              size="xs"
              onClick={() => setMode('chat')}
              className={mode === 'chat' ? 'bg-sky-600 hover:bg-sky-500 text-white border-0' : ''}
            >
              💬 {t('geChat')}
            </Button>
          </div>
        </div>

        {/* Stats row */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <StatBox icon="💎" value={data.totals.diamonds.toLocaleString()} label={t('geTotalDiamonds')} color="text-pink-300" />
            <StatBox icon="📊" value={String(data.totals.avgDiamondPerMin)} label={t('geAvgPerMin')} color="text-amber-300" />
            <StatBox icon="🔥" value={`${data.totals.peakDiamonds} 💎`} label={`${t('gePeak')} @ ${fmtTimeSec(data.totals.peakMomentSec)}`} color="text-rose-300" />
            <StatBox icon="🎁" value={data.totals.gifts.toLocaleString()} label={t('geTotalGifts')} color="text-amber-200" />
          </div>
        )}

        {/* Heatmap bar chart */}
        {data && heatmap.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
              {mode === 'gifts' ? t('geGiftHeatmap') : t('geChatHeatmap')}
            </div>
            <div
              className="flex items-end gap-px h-16 bg-secondary/40 rounded-lg p-1 overflow-hidden cursor-pointer"
              title={t('geClickToJump')}
            >
              {heatmap.map((val, idx) => {
                const height = Math.max(2, (val / maxVal) * 100)
                const sec = idx * (data.bucketSec)
                const color = mode === 'gifts'
                  ? val > maxVal * 0.7 ? 'bg-pink-400' : val > maxVal * 0.3 ? 'bg-pink-500/70' : 'bg-pink-600/40'
                  : val > maxVal * 0.7 ? 'bg-sky-400' : val > maxVal * 0.3 ? 'bg-sky-500/70' : 'bg-sky-600/40'
                return (
                  <button
                    key={idx}
                    onClick={() => onJump?.(sec)}
                    className={`flex-1 min-w-[2px] rounded-t transition-all hover:brightness-125 ${color}`}
                    style={{ height: `${height}%` }}
                    title={`${fmtTimeSec(sec)}: ${val}${mode === 'gifts' ? ' 💎' : ' msgs'}`}
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
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-pink-500/10 text-pink-200 border border-pink-500/20"
                  title={`${g.diamonds.toLocaleString()} 💎`}
                >
                  {g.name} ×{g.count} <span className="text-pink-400/70">({g.diamonds}💎)</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {loading && !data && <p className="text-xs text-muted-foreground">— loading —</p>}
      </CardContent>
    </Card>
  )
}

function StatBox({ icon, value, label, color }: { icon: string; value: string; label: string; color: string }) {
  return (
    <div className="bg-secondary/60 rounded-lg px-2 py-1.5 border border-border">
      <div className="flex items-center gap-1">
        <span>{icon}</span>
        <span className={`font-mono font-semibold ${color}`}>{value}</span>
      </div>
      <div className="text-[10px] text-muted-foreground truncate">{label}</div>
    </div>
  )
}
