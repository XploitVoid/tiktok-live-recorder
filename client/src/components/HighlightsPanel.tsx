import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Sparkles, Scissors, RefreshCw, Trash2, Download, Play,
  MessageSquare, Gift, Gem, Heart, UserPlus, Star, Volume2, Users,
  SlidersHorizontal, ArrowUpDown, Clock,
} from 'lucide-react'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import { fmtBytes, fmtTimeSec } from '@/lib/format'
import { useEventStream } from '@/lib/useEventStream'
import {
  getHighlights,
  analyzeHighlights,
  cutHighlightClip,
  deleteHighlightClip,
} from '@/lib/api'
import type { HighlightCandidate, HighlightClip, SpriteMeta } from '@/lib/types'
import { Avatar } from '@/components/Avatar'
import { toast } from 'sonner'

interface Props {
  recording: string
  hasEvents: boolean
  durationSec?: number | null
  currentTime?: number
  spriteUrl?: string | null
  spriteMeta?: SpriteMeta | null
  onJump: (sec: number) => void
}

const MAX_CLIP_SEC = 240

export function HighlightsPanel({ recording, hasEvents, durationSec, currentTime = 0, spriteUrl, spriteMeta, onJump }: Props) {
  const { t } = useI18n()
  const [candidates, setCandidates] = useState<HighlightCandidate[]>([])
  const [clips, setClips] = useState<HighlightClip[]>([])
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [cuttingId, setCuttingId] = useState<string | null>(null)
  const [cutPercent, setCutPercent] = useState<number | null>(null)
  const [usedFallback, setUsedFallback] = useState(false)
  const [sensitivity, setSensitivity] = useState<'strict' | 'balanced' | 'sensitive'>('balanced')
  const [includeAudio, setIncludeAudio] = useState(true)
  const [reasonFilter, setReasonFilter] = useState<'all' | HighlightCandidate['reason']>('all')
  const [sortBy, setSortBy] = useState<'time' | 'score'>('time')
  const [verticalMode, setVerticalMode] = useState<'none' | 'blur' | 'crop' | 'pk-split'>('none')
  const [burnSubtitles, setBurnSubtitles] = useState(false)
  const [trimIn, setTrimIn] = useState(0)
  const [trimOutRaw, setTrimOutRaw] = useState(30)
  const [hoverSec, setHoverSec] = useState<number | null>(null)

  const trimOut = durationSec && durationSec > 0
    ? Math.min(
        durationSec,
        trimIn + MAX_CLIP_SEC,
        Math.max(trimIn + 1, trimOutRaw > durationSec ? Math.min(30, durationSec) : trimOutRaw),
      )
    : Math.min(trimIn + MAX_CLIP_SEC, trimOutRaw)

  const verticalItems = {
    none: 'Original (fast copy)',
    blur: '9:16 Blur BG',
    crop: '9:16 Center Crop',
    'pk-split': '9:16 PK Split (Top/Bot)',
  }

  const sensitivityItems = {
    strict: t('hlSensitivityStrict'),
    balanced: t('hlSensitivityBalanced'),
    sensitive: t('hlSensitivitySensitive'),
  }

  const visibleCandidates = useMemo(() => {
    const filtered = reasonFilter === 'all'
      ? candidates
      : candidates.filter((c) => c.reason === reasonFilter)
    return [...filtered].sort((a, b) =>
      sortBy === 'score'
        ? b.score - a.score || (b.confidence ?? 0) - (a.confidence ?? 0)
        : a.startSec - b.startSec,
    )
  }, [candidates, reasonFilter, sortBy])

  const presentReasons = useMemo(() => new Set(candidates.map((c) => c.reason)), [candidates])

  const sseHandlers = useMemo(() => ({
    cut_progress: (raw: unknown) => {
      const ev = raw as { recording?: string; percent?: number; done?: boolean }
      if (!ev || ev.recording !== recording) return
      if (ev.done) setCutPercent(null)
      else if (typeof ev.percent === 'number') setCutPercent(ev.percent)
    },
  }), [recording])
  useEventStream('channels=highlights', sseHandlers, true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getHighlights(recording)
      setCandidates(data.candidates || [])
      setClips(data.clips || [])
      setUsedFallback(!!data.usedFallback)
      if (data.stats?.sensitivity) setSensitivity(data.stats.sensitivity)
    } catch (e) {
      console.error('getHighlights:', e)
    } finally {
      setLoading(false)
    }
  }, [recording])

  useEffect(() => {
    let active = true
    getHighlights(recording)
      .then((data) => {
        if (!active) return
        setCandidates(data.candidates || [])
        setClips(data.clips || [])
        setUsedFallback(!!data.usedFallback)
        if (data.stats?.sensitivity) setSensitivity(data.stats.sensitivity)
      })
      .catch((e) => console.error('getHighlights:', e))
    return () => { active = false }
  }, [recording])

  const handleAnalyze = async () => {
    if (!hasEvents && !includeAudio) return
    setAnalyzing(true)
    try {
      await analyzeHighlights(recording, { sensitivity, includeAudio })
      const data = await getHighlights(recording)
      setCandidates(data.candidates || [])
      setClips(data.clips || [])
      setUsedFallback(!!data.usedFallback)
      toast.success(t('highlights'), { description: `${data.candidates.length} candidates` })
    } catch (e: unknown) {
      toast.error('Analyze failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAnalyzing(false)
    }
  }

  const handleLoadToTrimmer = (c: HighlightCandidate) => {
    const start = Math.max(0, Math.floor(c.startSec))
    const rawEnd = Math.ceil(c.endSec)
    const maxAllowed = durationSec && durationSec > 0 ? Math.min(Math.floor(durationSec), start + MAX_CLIP_SEC) : start + MAX_CLIP_SEC
    setTrimIn(start)
    setTrimOutRaw(Math.min(maxAllowed, Math.max(start + 1, rawEnd)))
    onJump(c.startSec)
  }

  const handleCut = async (c: HighlightCandidate) => {
    if (cuttingId !== null) return
    setCuttingId(c.id)
    try {
      const r = await cutHighlightClip(recording, c.startSec, c.endSec, {
        vertical: verticalMode,
        burnSubtitles: hasEvents ? burnSubtitles : false,
      })
      toast.success(t('hlGenerate'), { description: r.clip.name })
      await refresh()
    } catch (e: unknown) {
      toast.error('Cut failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setCuttingId(null)
      setCutPercent(null)
    }
  }

  const handleCutRange = async () => {
    if (cuttingId !== null || trimOut <= trimIn) return
    setCuttingId('custom_trim')
    setCutPercent(0)
    try {
      const r = await cutHighlightClip(recording, trimIn, trimOut, {
        vertical: verticalMode,
        burnSubtitles: hasEvents ? burnSubtitles : false,
      })
      toast.success(t('hlGenerate'), { description: r.clip.name })
      await refresh()
    } catch (e: unknown) {
      toast.error('Cut failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setCuttingId(null)
      setCutPercent(null)
    }
  }

  const handleDeleteClip = async (clipName: string) => {
    try {
      await deleteHighlightClip(clipName)
      toast.info('Deleted', { description: clipName })
      await refresh()
    } catch (e: unknown) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
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
          <div className="flex items-center gap-2 flex-wrap">
            <Select items={verticalItems} value={verticalMode} onValueChange={(v) => v && setVerticalMode(v as typeof verticalMode)}>
              <SelectTrigger className="w-[155px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Original (fast copy)</SelectItem>
                <SelectItem value="blur">9:16 Blur BG</SelectItem>
                <SelectItem value="crop">9:16 Center Crop</SelectItem>
                <SelectItem value="pk-split">9:16 PK Split (Top/Bot)</SelectItem>
              </SelectContent>
            </Select>
            <Select items={sensitivityItems} value={sensitivity} onValueChange={(v) => v && setSensitivity(v as typeof sensitivity)}>
              <SelectTrigger className="w-[140px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">{t('hlSensitivityStrict')}</SelectItem>
                <SelectItem value="balanced">{t('hlSensitivityBalanced')}</SelectItem>
                <SelectItem value="sensitive">{t('hlSensitivitySensitive')}</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <Checkbox checked={includeAudio} onCheckedChange={(v) => setIncludeAudio(!!v)} className="w-3.5 h-3.5" />
              <span>{t('hlIncludeAudio')}</span>
            </label>
            {hasEvents && (
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={burnSubtitles} onCheckedChange={(v) => setBurnSubtitles(!!v)} className="w-3.5 h-3.5" />
                <span>{t('hlBurnSubs')}</span>
              </label>
            )}
            <Button variant="ghost" size="xs" onClick={handleAnalyze} disabled={analyzing || (!hasEvents && !includeAudio)}>
              <RefreshCw className={`w-3 h-3 mr-1 ${analyzing ? 'animate-spin' : ''}`} />
              {analyzing ? t('hlAnalyzing') : t('hlReanalyze')}
            </Button>
          </div>
        </div>

        {/* Reason filter pills & sort toggle */}
        {candidates.length > 0 && (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-1 flex-wrap">
              {(
                [
                  { id: 'all', label: t('hlFilterAll'), show: true },
                  { id: 'pk_battle', label: t('hlFilterPK'), show: presentReasons.has('pk_battle') },
                  { id: 'gift_spike', label: t('hlFilterGift'), show: presentReasons.has('gift_spike') },
                  { id: 'sub_spike', label: t('hlFilterSub'), show: presentReasons.has('sub_spike') },
                  { id: 'chat_spike', label: t('hlFilterChat'), show: presentReasons.has('chat_spike') },
                  { id: 'audio_spike', label: t('hlFilterAudio'), show: presentReasons.has('audio_spike') },
                ] as const
              )
                .filter((f) => f.show)
                .map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setReasonFilter(f.id)}
                    className={`px-2 py-0.5 rounded-md text-[11px] border transition-colors cursor-pointer ${
                      reasonFilter === f.id
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-secondary/60 text-muted-foreground border-border hover:text-foreground'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
            </div>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSortBy((prev) => (prev === 'time' ? 'score' : 'time'))}
              className="text-[11px] h-6 gap-1 cursor-pointer"
            >
              {sortBy === 'score' ? <ArrowUpDown className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
              <span>{sortBy === 'score' ? t('hlSortScore') : t('hlSortTime')}</span>
            </Button>
          </div>
        )}

        {/* Timeline strip with markers + hover sprite preview */}
        {durationSec && durationSec > 0 && (
          <div className="space-y-2">
            <div
              className="relative w-full h-3 bg-secondary rounded-full overflow-hidden cursor-pointer"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                setHoverSec(ratio * durationSec)
              }}
              onMouseLeave={() => setHoverSec(null)}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                onJump(ratio * durationSec)
              }}
            >
              {candidates.map((c) => {
                const left = Math.max(0, Math.min(100, (c.startSec / durationSec) * 100))
                const width = Math.max(0.5, Math.min(100 - left, ((c.endSec - c.startSec) / durationSec) * 100))
                const color =
                  c.reason === 'pk_battle' ? 'bg-fuchsia-500' :
                  c.reason === 'gift_spike' ? 'bg-amber-400' :
                  c.reason === 'sub_spike' ? 'bg-emerald-400' :
                  c.reason === 'audio_spike' ? 'bg-cyan-400' :
                  c.reason === 'chat_spike' ? 'bg-pink-400' : 'bg-indigo-400'
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onJump(c.startSec) }}
                    title={`${fmtTimeSec(c.startSec)} → ${fmtTimeSec(c.endSec)} (${c.reason})`}
                    className={`absolute top-0 h-full ${color} hover:brightness-125 transition-all cursor-pointer`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                )
              })}
              {/* Selected In/Out range overlay */}
              <div
                className="pointer-events-none absolute top-0 h-full bg-white/25 border-x border-white/70"
                style={{
                  left: `${Math.max(0, Math.min(100, (trimIn / durationSec) * 100))}%`,
                  width: `${Math.max(0.5, Math.min(100, ((trimOut - trimIn) / durationSec) * 100))}%`,
                }}
              />
            </div>

            {hoverSec !== null && spriteUrl && spriteMeta && (() => {
              const idx = Math.min(
                spriteMeta.cols * spriteMeta.rows - 1,
                Math.max(0, Math.floor(hoverSec / spriteMeta.intervalSec)),
              )
              const col = idx % spriteMeta.cols
              const row = Math.floor(idx / spriteMeta.cols)
              return (
                <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                  <div
                    className="rounded border border-border bg-black shrink-0"
                    style={{
                      width: spriteMeta.tileWidth,
                      height: spriteMeta.tileHeight,
                      backgroundImage: `url(${spriteUrl})`,
                      backgroundPosition: `-${col * spriteMeta.tileWidth}px -${row * spriteMeta.tileHeight}px`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  />
                  <span>{fmtTimeSec(hoverSec)}</span>
                </div>
              )
            })()}

            {/* Visual Timeline In/Out Trimmer */}
            <div className="flex flex-wrap items-center gap-2 bg-secondary/40 border border-border/70 rounded-lg px-2.5 py-2 text-xs">
              <span className="font-medium text-muted-foreground">{t('trimmerTitle')}</span>
              <div className="flex items-center gap-1.5">
                <Button size="xs" variant="outline" onClick={() => {
                  const v = Math.floor(currentTime)
                  setTrimIn(v)
                  if (trimOut <= v) {
                    setTrimOutRaw(Math.min(Math.floor(durationSec), v + 15))
                  } else if (trimOut - v > MAX_CLIP_SEC) {
                    setTrimOutRaw(Math.min(Math.floor(durationSec), v + MAX_CLIP_SEC))
                  }
                }}>
                  {t('trimmerSetIn')} ({fmtTimeSec(trimIn)})
                </Button>
                <Button size="xs" variant="outline" onClick={() => {
                  const v = Math.min(trimIn + MAX_CLIP_SEC, Math.max(trimIn + 1, Math.ceil(currentTime)))
                  setTrimOutRaw(Math.min(Math.floor(durationSec), v))
                }}>
                  {t('trimmerSetOut')} ({fmtTimeSec(trimOut)})
                </Button>
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.floor(durationSec) - 1)}
                value={trimIn}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setTrimIn(v)
                  if (trimOut <= v) {
                    setTrimOutRaw(Math.min(Math.floor(durationSec), v + 1))
                  } else if (trimOut - v > MAX_CLIP_SEC) {
                    setTrimOutRaw(Math.min(Math.floor(durationSec), v + MAX_CLIP_SEC))
                  }
                }}
                className="w-24 accent-primary"
                aria-label="Trim In"
              />
              <input
                type="range"
                min={Math.min(Math.floor(durationSec), trimIn + 1)}
                max={Math.min(Math.max(1, Math.floor(durationSec)), trimIn + MAX_CLIP_SEC)}
                value={trimOut}
                onChange={(e) => setTrimOutRaw(Math.min(trimIn + MAX_CLIP_SEC, Math.max(trimIn + 1, Number(e.target.value))))}
                className="w-24 accent-primary"
                aria-label="Trim Out"
              />
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {Math.max(0, Math.round(trimOut - trimIn))}s <span className="opacity-70">(max {MAX_CLIP_SEC}s)</span>
              </span>
              <Button
                size="xs"
                onClick={handleCutRange}
                disabled={cuttingId !== null || trimOut <= trimIn}
                className="ml-auto cursor-pointer"
              >
                <Scissors className="w-3 h-3 mr-1" />
                {cuttingId === 'custom_trim' ? t('hlGenerating') : t('trimmerCut')}
              </Button>
            </div>

            {cutPercent !== null && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                  <span>FFmpeg encoding...</span>
                  <span>{cutPercent}%</span>
                </div>
                <div className="w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-150" style={{ width: `${cutPercent}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Candidates list */}
        <div className="space-y-1.5 max-h-[340px] overflow-y-auto">
          {!hasEvents && candidates.length === 0 && !includeAudio ? (
            <p className="text-xs text-muted-foreground">{t('hlNoEvents')}</p>
          ) : loading && candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          ) : visibleCandidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{!hasEvents ? t('hlNoEvents') : t('hlNone')}</p>
          ) : (
            visibleCandidates.map((c) => (
              <CandidateRow
                key={c.id}
                c={c}
                onJump={onJump}
                onCut={handleCut}
                onLoadToTrimmer={handleLoadToTrimmer}
                cutting={cuttingId === c.id}
                disabled={cuttingId !== null}
              />
            ))
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
                  {cl.startSec != null ? fmtTimeSec(cl.startSec) : '?'} · {cl.durSec ?? '?'}s · {cl.name}
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
                <ConfirmButton
                  onConfirm={() => handleDeleteClip(cl.name)}
                  confirmLabel={t('confirm')}
                  cancelLabel={t('cancel')}
                  title={t('hlDeleteClip')}
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </ConfirmButton>
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
  onLoadToTrimmer,
  cutting,
  disabled,
}: {
  c: HighlightCandidate
  onJump: (sec: number) => void
  onCut: (c: HighlightCandidate) => void
  onLoadToTrimmer: (c: HighlightCandidate) => void
  cutting: boolean
  disabled: boolean
}) {
  const { t } = useI18n()
  const reasonLabel =
    c.reason === 'pk_battle' ? t('hlReasonPK') :
    c.reason === 'gift_spike' ? t('hlReasonGift') :
    c.reason === 'sub_spike' ? t('hlReasonSub') :
    c.reason === 'audio_spike' ? t('hlReasonAudio') :
    c.reason === 'chat_spike' ? t('hlReasonChat') : t('hlReasonActivity')
  const reasonColor =
    c.reason === 'pk_battle' ? 'bg-fuchsia-700/30 text-fuchsia-200 border-fuchsia-700/40' :
    c.reason === 'gift_spike' ? 'bg-amber-700/30 text-amber-200 border-amber-700/40' :
    c.reason === 'sub_spike' ? 'bg-emerald-700/30 text-emerald-200 border-emerald-700/40' :
    c.reason === 'audio_spike' ? 'bg-cyan-700/30 text-cyan-200 border-cyan-700/40' :
    c.reason === 'chat_spike' ? 'bg-pink-700/30 text-pink-200 border-pink-700/40' :
    'bg-indigo-700/30 text-indigo-200 border-indigo-700/40'
  const moodLabel =
    c.mood === 'funny' ? t('hlMoodFunny') :
    c.mood === 'hype' ? t('hlMoodHype') :
    c.mood === 'shock' ? t('hlMoodShock') :
    c.mood === 'love' ? t('hlMoodLove') : null
  const dur = Math.round(c.endSec - c.startSec)
  const isPK = c.reason === 'pk_battle'
  const conf = c.confidence ?? null
  const confStyle =
    conf == null ? '' :
    conf >= 80 ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' :
    conf >= 60 ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' :
    'bg-slate-600/30 text-slate-300 border-slate-600/40'

  return (
    <div className="bg-secondary/60 border border-border rounded-lg px-2 py-1.5 text-xs">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant="secondary" className={`text-[10px] ${reasonColor}`}>{reasonLabel}</Badge>
        {moodLabel && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/80">
            {moodLabel}
          </Badge>
        )}
        {conf !== null && (
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 tabular-nums ${confStyle}`}>
            {conf}%
          </Badge>
        )}
        {c.hasAudioPeak && c.reason !== 'audio_spike' && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-cyan-300 border-cyan-500/40 bg-cyan-500/10 gap-0.5" title={t('hlAudioBoostBadge')}>
            <Volume2 className="w-2.5 h-2.5" />
          </Badge>
        )}
        <span className="font-mono text-foreground/90">{fmtTimeSec(c.startSec)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{dur}s</span>
        {!isPK && c.ratio > 0 && (
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
        <Button variant="ghost" size="xs" onClick={() => onLoadToTrimmer(c)} title={t('hlLoadTrimmer')}>
          <SlidersHorizontal className="w-3 h-3 mr-1" />{t('hlLoadTrimmer')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onJump(c.startSec)}>
          <Play className="w-3 h-3 mr-1" />{t('hlJump')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => onCut(c)} disabled={disabled || cutting}>
          <Scissors className={`w-3 h-3 mr-1 ${cutting ? 'animate-pulse' : ''}`} />
          {cutting ? t('hlGenerating') : t('hlGenerate')}
        </Button>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 items-center tabular-nums">
        {(c.summary.uniqueUsers ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1"><Users className="w-3 h-3 text-violet-400" /> {c.summary.uniqueUsers} {t('hlUniqueUsers')}</span>
        )}
        {c.summary.chats > 0 && (
          <span className="inline-flex items-center gap-1"><MessageSquare className="w-3 h-3 text-sky-400" /> {c.summary.chats}</span>
        )}
        {(c.summary.subscribes ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-emerald-300"><Star className="w-3 h-3" /> {c.summary.subscribes} {t('hlSubs')}</span>
        )}
        {c.summary.gifts > 0 && (
          <span className="inline-flex items-center gap-1"><Gift className="w-3 h-3 text-amber-400" /> {c.summary.gifts}</span>
        )}
        {c.summary.diamonds > 0 && (
          <span className="inline-flex items-center gap-1"><Gem className="w-3 h-3 text-primary" /> {c.summary.diamonds}</span>
        )}
        {c.summary.likes > 0 && (
          <span className="inline-flex items-center gap-1"><Heart className="w-3 h-3 text-rose-400" /> {c.summary.likes}</span>
        )}
        {c.summary.follows > 0 && (
          <span className="inline-flex items-center gap-1"><UserPlus className="w-3 h-3 text-emerald-400" /> {c.summary.follows}</span>
        )}
        {c.summary.topGift && (
          <span className="inline-flex items-center gap-1 text-amber-300/90"><Star className="w-3 h-3" /> {c.summary.topGift.name} ×{c.summary.topGift.count}</span>
        )}
        {c.summary.topUser && (
          <span className="inline-flex items-center gap-1 text-sky-300/80">
            <Avatar url={c.summary.topUser.avatar || undefined} name={c.summary.topUser.name} size={18} />
            @{c.summary.topUser.name}
          </span>
        )}
        {c.summary.topKeywords && c.summary.topKeywords.length > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px]">
            {c.summary.topKeywords.map((kw) => (
              <span key={kw} className="px-1.5 py-0.2 rounded bg-background/60 border border-border/70 text-foreground/80">
                #{kw}
              </span>
            ))}
          </span>
        )}
      </div>
      {c.summary.sampleQuotes && c.summary.sampleQuotes.length > 0 && (
        <div className="mt-1 space-y-0.5 text-[11px] text-foreground/75 border-l-2 border-primary/40 pl-2">
          {c.summary.sampleQuotes.map((q, i) => (
            <div key={i} className="truncate">
              <span className="font-medium text-sky-300/90">{q.user}:</span> {q.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
