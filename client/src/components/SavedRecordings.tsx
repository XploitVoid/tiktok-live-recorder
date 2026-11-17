import { useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react'
import { FolderOpen, RefreshCw, Trash2, Download, Play, MessageSquare, Sparkles, Scissors, Search, Music, FileArchive, Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import { fmtBytes, fmtTimeSec } from '@/lib/format'
import { getRecordings, deleteRecording, extractRecordingAudio, compressRecording } from '@/lib/api'
import { useEventStream } from '@/lib/useEventStream'
import type { RecordingFile } from '@/lib/types'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { ConfirmButton } from '@/components/ConfirmButton'

export interface SavedRecordingsRef {
  refresh: () => void
}

export const SavedRecordings = forwardRef<SavedRecordingsRef>(function SavedRecordings(_props, ref) {
  const { t } = useI18n()
  const [files, setFiles] = useState<RecordingFile[]>([])
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<'all' | 'chat' | 'highlights'>('all')
  const [sortMode, setSortMode] = useState<'newest' | 'largest' | 'longest'>('newest')
  const [extracting, setExtracting] = useState<string | null>(null)
  const [compressing, setCompressing] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await getRecordings()
      setFiles(data)
    } catch (e) {
      console.error('refreshFiles:', e)
    }
  }, [])

  useImperativeHandle(ref, () => ({ refresh }), [refresh])

  useEffect(() => {
    let active = true
    getRecordings()
      .then((data) => { if (active) setFiles(data) })
      .catch((e) => console.error('refreshFiles:', e))
    return () => { active = false }
  }, [])

  const sseHandlers = useMemo(() => ({
    recordings: () => { void refresh() },
  }), [refresh])
  useEventStream('channels=jobs', sseHandlers, true)

  const handleDelete = async (name: string) => {
    try {
      await deleteRecording(name)
      toast.info('Deleted', { description: name })
      void refresh()
    } catch (e: unknown) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleExtractAudio = async (name: string, format: 'm4a' | 'mp3') => {
    setExtracting(`${name}:${format}`)
    try {
      const res = await extractRecordingAudio(name, format)
      toast.success(`Audio ready (${format.toUpperCase()})`, { description: res.name })
      const a = document.createElement('a')
      a.href = res.url
      a.download = res.name
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (e: unknown) {
      toast.error('Audio extract failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setExtracting(null)
    }
  }

  const handleCompress = async (name: string) => {
    setCompressing(name)
    toast.info(t('savedCompressing'), { description: name })
    try {
      const res = await compressRecording(name, 'balanced')
      const pct = res.origBytes > 0 ? Math.round((1 - res.sizeBytes / res.origBytes) * 100) : 0
      toast.success(t('savedCompressed'), {
        description: `${res.name} (${fmtBytes(res.sizeBytes)}${pct > 0 ? `, -${pct}%` : ''})`,
      })
      void refresh()
    } catch (e: unknown) {
      toast.error('Compress failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setCompressing(null)
    }
  }

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = files.filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false
      if (filterMode === 'chat' && !f.hasEvents) return false
      if (filterMode === 'highlights' && !(f.highlightCount && f.highlightCount > 0)) return false
      return true
    })
    return [...filtered].sort((a, b) => {
      if (sortMode === 'largest') return (b.sizeBytes || 0) - (a.sizeBytes || 0)
      if (sortMode === 'longest') return (b.durationSec || 0) - (a.durationSec || 0)
      return (b.mtime || 0) - (a.mtime || 0)
    })
  }, [files, query, filterMode, sortMode])

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <FolderOpen className="w-4 h-4 text-indigo-400" />
            {t('savedRec')}
            <span className="text-xs text-muted-foreground font-normal">({visibleFiles.length})</span>
          </h2>
          <Button variant="ghost" size="xs" onClick={refresh}>
            <RefreshCw className="w-3 h-3 mr-1" /> {t('btnRefresh')}
          </Button>
        </div>

        {/* Search / Filter / Sort */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('savedSearchPlaceholder')}
                className="h-7 pl-8 text-xs"
              />
            </div>
            <Select value={filterMode} onValueChange={(v) => v && setFilterMode(v as typeof filterMode)}>
              <SelectTrigger className="w-[130px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('savedFilterAll')}</SelectItem>
                <SelectItem value="chat">{t('fChat')}</SelectItem>
                <SelectItem value="highlights">{t('highlights')}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortMode} onValueChange={(v) => v && setSortMode(v as typeof sortMode)}>
              <SelectTrigger className="w-[115px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">{t('savedSortNewest')}</SelectItem>
                <SelectItem value="largest">{t('savedSortLargest')}</SelectItem>
                <SelectItem value="longest">Longest</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5 text-sm">
          {visibleFiles.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('emptyList')}</p>
          ) : (
            visibleFiles.map((f) => (
              <div key={f.name} className="flex items-center gap-2 bg-secondary rounded-lg px-2 py-1.5 flex-wrap sm:flex-nowrap">
                {f.thumbUrl ? (
                  <img
                    src={f.thumbUrl}
                    alt=""
                    loading="lazy"
                    className="w-12 h-7 rounded object-cover bg-black shrink-0 border border-border"
                  />
                ) : (
                  <div className="w-12 h-7 rounded bg-zinc-800/80 border border-border flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                    MP4
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-foreground/90 truncate font-mono">{f.name}</div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                    {f.durationSec != null && (
                      <span className="text-[10px] font-mono text-emerald-300/90">{fmtTimeSec(f.durationSec)}</span>
                    )}
                    {f.height != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {f.height}p{f.fps && f.fps >= 50 ? f.fps : ''}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">{fmtBytes(f.sizeBytes)}</span>
                    {f.hasEvents && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-pink-700/30 text-pink-200 border-pink-700/40">
                        <MessageSquare className="w-2.5 h-2.5 mr-0.5" /> chat
                      </Badge>
                    )}
                    {!!f.highlightCount && f.highlightCount > 0 && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-amber-700/30 text-amber-200 border-amber-700/40" title={`${f.highlightCount} highlight candidates`}>
                        <Sparkles className="w-2.5 h-2.5 mr-0.5" /> {f.highlightCount}
                      </Badge>
                    )}
                    {!!f.clipCount && f.clipCount > 0 && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-indigo-700/30 text-indigo-200 border-indigo-700/40" title={`${f.clipCount} cut clips`}>
                        <Scissors className="w-2.5 h-2.5 mr-0.5" /> {f.clipCount}
                      </Badge>
                    )}
                  </div>
                </div>
                <Link
                  to={`/replay?file=${encodeURIComponent(f.name)}`}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
                >
                  <Play className="w-3 h-3" /> {t('btnReplay')}
                </Link>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={extracting === `${f.name}:m4a`}
                  onClick={() => handleExtractAudio(f.name, 'm4a')}
                  title={t('savedExtractAudio')}
                  className="h-6 px-2 text-xs"
                >
                  <Music className="w-3 h-3 mr-1" /> M4A
                </Button>
                {!/_(balanced|compact)\.mp4$/i.test(f.name) && (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={compressing === f.name}
                    onClick={() => handleCompress(f.name)}
                    title={t('savedCompress')}
                    className="h-6 px-2 text-xs"
                  >
                    {compressing === f.name
                      ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                      : <FileArchive className="w-3 h-3 mr-1" />}
                    720p
                  </Button>
                )}
                <a
                  href={`/files/${encodeURIComponent(f.name)}`}
                  download
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-secondary hover:bg-muted border border-border text-foreground/80 rounded-md transition-colors"
                >
                  <Download className="w-3 h-3" /> {t('btnDownload')}
                </a>
                <ConfirmButton
                  onConfirm={() => handleDelete(f.name)}
                  confirmLabel={t('confirm')}
                  cancelLabel={t('cancel')}
                  title={t('accDelete')}
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </ConfirmButton>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
})
