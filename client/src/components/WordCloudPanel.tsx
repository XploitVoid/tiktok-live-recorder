import { useState, useEffect, useCallback } from 'react'
import { Hash } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useI18n } from '@/lib/i18n'
import { getWordFrequency } from '@/lib/api'
import type { WordFrequencyData } from '@/lib/types'

interface Props {
  recording: string
  hasEvents: boolean
}

export function WordCloudPanel({ recording, hasEvents }: Props) {
  const { t } = useI18n()
  const [data, setData] = useState<WordFrequencyData | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!hasEvents) return
    setLoading(true)
    try {
      const d = await getWordFrequency(recording)
      setData(d)
    } catch (e) {
      console.error('getWordFrequency:', e)
    } finally {
      setLoading(false)
    }
  }, [recording, hasEvents])

  useEffect(() => { refresh() }, [refresh])

  if (!hasEvents) return null

  const phrases = data?.phrases || []
  const maxCount = phrases.length > 0 ? phrases[0].count : 1

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center gap-2">
          <Hash className="w-4 h-4 text-emerald-400" />
          <h2 className="font-semibold">{t('wcTitle')}</h2>
          {data && (
            <span className="text-xs text-muted-foreground">
              · {data.totalMessages.toLocaleString()} {t('wcMessages')}
            </span>
          )}
        </div>

        {loading && !data && <p className="text-xs text-muted-foreground">— loading —</p>}

        {/* Word cloud (sized by frequency) */}
        {phrases.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center justify-center py-2">
            {phrases.slice(0, 40).map((p) => {
              // Scale font size between 11px and 28px based on relative frequency
              const ratio = p.count / maxCount
              const fontSize = Math.round(11 + ratio * 17)
              const opacity = 0.5 + ratio * 0.5
              // Color based on rank
              const colors = [
                'text-emerald-300', 'text-sky-300', 'text-amber-300',
                'text-pink-300', 'text-indigo-300', 'text-cyan-300',
                'text-rose-300', 'text-violet-300',
              ]
              const color = colors[phrases.indexOf(p) % colors.length]
              return (
                <span
                  key={p.word}
                  className={`inline-block px-1 cursor-default transition-transform hover:scale-110 ${color}`}
                  style={{ fontSize: `${fontSize}px`, opacity }}
                  title={`${p.word}: ${p.count} (${p.pct}%)`}
                >
                  {p.word}
                </span>
              )
            })}
          </div>
        )}

        {/* Top phrases table */}
        {phrases.length > 0 && (
          <div className="max-h-[200px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground text-left">
                  <th className="pb-1 font-medium">#</th>
                  <th className="pb-1 font-medium">{t('wcWord')}</th>
                  <th className="pb-1 font-medium text-right">{t('wcCount')}</th>
                  <th className="pb-1 font-medium text-right">%</th>
                  <th className="pb-1 font-medium w-24"></th>
                </tr>
              </thead>
              <tbody>
                {phrases.slice(0, 20).map((p, idx) => (
                  <tr key={p.word} className="border-t border-border/30">
                    <td className="py-0.5 text-muted-foreground">{idx + 1}</td>
                    <td className="py-0.5 font-medium text-foreground/90">{p.word}</td>
                    <td className="py-0.5 text-right font-mono">{p.count}</td>
                    <td className="py-0.5 text-right text-muted-foreground">{p.pct}%</td>
                    <td className="py-0.5 pl-2">
                      <div className="h-2 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500/60 rounded-full"
                          style={{ width: `${(p.count / maxCount) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {phrases.length === 0 && data && (
          <p className="text-xs text-muted-foreground">{t('wcEmpty')}</p>
        )}
      </CardContent>
    </Card>
  )
}
