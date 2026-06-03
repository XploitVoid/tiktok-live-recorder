import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Scissors, RefreshCw, Trash2, Download, Play } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/lib/i18n'
import { fmtBytes, fmtTimeSec } from '@/lib/format'
import {
  getHighlights,
  analyzeHighlights,
  cutHighlightClip,
  deleteHighlightClip,
} from '@/lib/api'
import type { HighlightCandidate, HighlightClip } from '@/lib/types'
import { Avatar } from '@/components/Avatar'
import { toast } from 'sonner'

interface Props {
  recording: string
  hasEvents: boolean
  durationSec?: number | null
  onJump: (sec: number) => void
}

export function HighlightsPanel({ recording, hasEvents, durationSec, onJump }: Props) {
  const { t } = useI18n()
  const [candidates, setCandidates] = useState<HighlightCandidate[]>([])
  const [clips, setClips] = useState<HighlightClip[]>([])
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [cuttingId, setCuttingId] = useState<string | null>(null)
  const [usedFallback, setUsedFallback] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getHighlights(recording)
      setCandidates(data.candidates || [])
      setClips(data.clips || [])
      setUsedFallback(!!data.usedFallback)
    } catch (e) {
      console.error('getHighlights:', e)
    } finally {
      setLoading(false)
    }
  }, [recording])

  useEffect(() => {
    if (hasEvents) refresh()
  }, [hasEvents, refresh])

  const handleAnalyze = async () => {
    setAnalyzing(true)
    try {
      await analyzeHighlights(recording)
      await refresh()
      toast.success(t('highlights'), { description: `${candidates.length} → ${(await getHighlights(recording)).candidates.length}` })
    } catch (e: unknown) {
      toast.error('Analyze failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAnalyzing(false)
    }
  }

  const handleCut = async (c: HighlightCandidate) => {
    setCuttingId(c.id)
    try {
      const r = await cutHighlightClip(recording, c.startSec, c.endSec)
      toast.success(t('hlGenerate'), { description: r.clip.name })
      await refresh()
    } catch (e: unknown) {
      toast.error('Cut failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setCuttingId(null)
    }
  }

  const handleDeleteClip = async (clipName: string) => {
    if (!confirm('Delete clip ' + clipName + '?')) return
    try {
      await deleteHighlightClip(clipName)
      toast.info('Deleted', { description: clipName })
      await refresh()
    } catch (e: unknown) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  if (!hasEvents) {
    return (
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold">{t('highlights')}</h2>
          </div>
          <p className="text-xs text-muted-foreground">{t('hlNoEvents')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold">{t('highlights')}</h2>
            <span className="text-xs text-muted-foreground">({candidates.length})</span>
            {usedFallback && candidates.length > 0 && (
              <Badge variant="secondary" className="text-[10px] bg-slate-700/40 text-slate-200 border-slate-700/50" title={t('hlFallbackHint')}>
                {t('hlFallbackBadge')}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="xs" onClick={handleAnalyze} disabled={analyzing}>
            <RefreshCw className={`w-3 h-3 mr-1 ${analyzing ? 'animate-spin' : ''}`} />
            {analyzing ? t('hlAnalyzing') : t('hlReanalyze')}
          </Button>
        </div>

        {/* Timeline strip with markers */}
        {durationSec && durationSec > 0 && candidates.length > 0 && (
          <div className="relative w-full h-3 bg-secondary rounded-full overflow-hidden">
            {candidates.map((c) => {
              const left = Math.max(0, Math.min(100, (c.startSec / durationSec) * 100))
              const width = Math.max(0.5, Math.min(100 - left, ((c.endSec - c.startSec) / durationSec) * 100))
              const color =
                c.reason === 'pk_battle'   ? 'bg-fuchsia-500' :
                c.reason === 'gift_spike'  ? 'bg-amber-400' :
                c.reason === 'chat_spike'  ? 'bg-pink-400' : 'bg-indigo-400'
              return (
                <button
                  key={c.id}
                  onClick={() => onJump(c.startSec)}
                  title={`${fmtTimeSec(c.startSec)} → ${fmtTimeSec(c.endSec)} (${c.reason})`}
                  className={`absolute top-0 h-full ${color} hover:brightness-125 transition-all cursor-pointer`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              )
            })}
          </div>
        )}

        {/* Candidates list */}
        <div className="space-y-1.5 max-h-[280px] overflow-y-auto">
          {loading && candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">— loading —</p>
          ) : candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('hlNone')}</p>
          ) : (
            candidates.map((c) => <CandidateRow key={c.id} c={c} onJump={onJump} onCut={handleCut} cutting={cuttingId === c.id} />)
          )}
        </div>

        {/* Generated clips */}
        {clips.length > 0 && (
          <div className="pt-2 border-t border-border space-y-1.5">
            <h3 className="text-xs font-semibold text-foreground/80 flex items-center gap-1">
              <Scissors className="w-3 h-3" /> {t('hlClipsTitle')} ({clips.length})
            </h3>
            {clips.map((cl) => (
              <div key={cl.name} className="flex items-center gap-2 bg-secondary rounded-lg px-2 py-1.5 text-xs">
                <span className="flex-1 truncate font-mono text-foreground/80">
                  {cl.startSec != null ? fmtTimeSec(cl.startSec) : '?'} · {cl.durSec ?? '?'}s
                </span>
                <span className="text-muted-foreground">{fmtBytes(cl.sizeBytes)}</span>
                <a
                  href={`/files/highlights/${encodeURIComponent(cl.name)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
                >
                  <Play className="w-3 h-3" />
                </a>
                <a
                  href={`/files/highlights/${encodeURIComponent(cl.name)}`}
                  download
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-secondary hover:bg-muted border border-border text-foreground/80 rounded-md transition-colors"
                >
                  <Download className="w-3 h-3" />
                </a>
                <Button variant="destructive" size="icon-xs" onClick={() => handleDeleteClip(cl.name)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground italic">{t('hlAuto')}</p>
      </CardContent>
    </Card>
  )
}

function CandidateRow({
  c,
  onJump,
  onCut,
  cutting,
}: {
  c: HighlightCandidate
  onJump: (sec: number) => void
  onCut: (c: HighlightCandidate) => void
  cutting: boolean
}) {
  const { t } = useI18n()
  const reasonLabel =
    c.reason === 'pk_battle'   ? t('hlReasonPK') :
    c.reason === 'gift_spike'  ? t('hlReasonGift') :
    c.reason === 'chat_spike'  ? t('hlReasonChat') : t('hlReasonActivity')
  const reasonColor =
    c.reason === 'pk_battle'   ? 'bg-fuchsia-700/30 text-fuchsia-200 border-fuchsia-700/40' :
    c.reason === 'gift_spike'  ? 'bg-amber-700/30 text-amber-200 border-amber-700/40' :
    c.reason === 'chat_spike'  ? 'bg-pink-700/30 text-pink-200 border-pink-700/40' :
    'bg-indigo-700/30 text-indigo-200 border-indigo-700/40'
  const dur = Math.round(c.endSec - c.startSec)
  const isPK = c.reason === 'pk_battle'

  return (
    <div className="bg-secondary/60 border border-border rounded-lg px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className={`text-[10px] ${reasonColor}`}>{reasonLabel}</Badge>
        <span className="font-mono text-foreground/90">{fmtTimeSec(c.startSec)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{dur}s</span>
        {!isPK && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-amber-300/90">×{c.ratio.toFixed(1)}</span>
          </>
        )}
        {isPK && c.pk?.opponents && c.pk.opponents.length > 0 && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-fuchsia-300/90 truncate max-w-[180px]" title={c.pk.opponents.join(' vs ')}>
              {t('hlPKOpponents')} {c.pk.opponents.join(' vs ')}
            </span>
          </>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => onJump(c.startSec)}>
          <Play className="w-3 h-3 mr-1" />{t('hlJump')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onCut(c)} disabled={cutting}>
          <Scissors className={`w-3 h-3 mr-1 ${cutting ? 'animate-pulse' : ''}`} />
          {cutting ? t('hlGenerating') : t('hlGenerate')}
        </Button>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 items-center">
        {c.summary.chats > 0 && <span>💬 {c.summary.chats}</span>}
        {c.summary.gifts > 0 && <span>🎁 {c.summary.gifts}</span>}
        {c.summary.diamonds > 0 && <span>💎 {c.summary.diamonds}</span>}
        {c.summary.likes > 0 && <span>❤️ {c.summary.likes}</span>}
        {c.summary.follows > 0 && <span>➕ {c.summary.follows}</span>}
        {c.summary.topGift && <span className="text-amber-300/80">★ {c.summary.topGift.name} ×{c.summary.topGift.count}</span>}
        {c.summary.topUser && (
          <span className="inline-flex items-center gap-1 text-sky-300/80">
            <Avatar url={c.summary.topUser.avatar || undefined} name={c.summary.topUser.name} size={18} />
            @{c.summary.topUser.name}
          </span>
        )}
      </div>
    </div>
  )
}
