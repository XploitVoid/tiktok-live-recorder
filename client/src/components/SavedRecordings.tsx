import { useState, useEffect, useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { FolderOpen, RefreshCw, Trash2, Download, Play, MessageSquare, Sparkles, Scissors, Search, Music, FileArchive, Loader2, Lock, Unlock, Pencil, Check, X, Layers } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n'
import { fmtBytes, fmtTimeSec, recordingFileUrl } from '@/lib/format'
import { getRecordings, deleteRecording, extractRecordingAudio, compressRecording, updateRecordingMeta, mergeRecordings, searchChatAll, type ChatSearchResult } from '@/lib/api'
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
  const [filterMode, setFilterMode] = useState<'all' | 'chat' | 'highlights' | 'protected'>('all')
  const [sortMode, setSortMode] = useState<'newest' | 'largest' | 'longest'>('newest')
  const [extracting, setExtracting] = useState<string | null>(null)
  const [compressing, setCompressing] = useState<string | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [mergeMode, setMergeMode] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [deleteSources, setDeleteSources] = useState(false)
  const [merging, setMerging] = useState(false)
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatQuery, setChatQuery] = useState('')
  const [chatResults, setChatResults] = useState<ChatSearchResult[] | null>(null)
  const [chatSearching, setChatSearching] = useState(false)
  const [chatSearchTooShort, setChatSearchTooShort] = useState(false)
  const chatReqIdRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  const handleToggleProtect = async (f: RecordingFile) => {
    try {
      const next = !f.protected
      await updateRecordingMeta(f.name, { protected: next })
      toast.success(next ? t('savedProtect') : t('savedUnprotect'), { description: f.name })
      void refresh()
    } catch (e: unknown) {
      toast.error('Update failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const startEditMeta = (f: RecordingFile) => {
    setEditingName(f.name)
    setEditTitle(f.displayTitle || '')
    setEditNotes(f.notes || '')
  }

  const saveEditMeta = async (name: string) => {
    try {
      await updateRecordingMeta(name, { displayTitle: editTitle.trim() || null, notes: editNotes.trim() })
      setEditingName(null)
      toast.success(t('settingsSaved'))
      void refresh()
    } catch (e: unknown) {
      toast.error('Update failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const exitMergeMode = () => {
    setMergeMode(false)
    setSelectedFiles([])
    setDeleteSources(false)
  }

  const toggleSelectFile = (name: string) => {
    setSelectedFiles((prev) =>
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name],
    )
  }

  const orderedSelectedFiles = useMemo(() => {
    const byName = new Map(files.map((f) => [f.name, f]))
    return [...selectedFiles]
      .filter((name) => byName.has(name))
      .sort((a, b) => {
        const diff = (byName.get(a)?.mtime || 0) - (byName.get(b)?.mtime || 0)
        return diff !== 0 ? diff : a.localeCompare(b)
      })
  }, [files, selectedFiles])

  const handleMerge = async () => {
    if (orderedSelectedFiles.length < 2) {
      toast.error(t('mergeNeedTwo'))
      return
    }
    setMerging(true)
    try {
      const res = await mergeRecordings(orderedSelectedFiles, deleteSources)
      toast.success(t('mergeSuccess'), {
        description: `${res.name} (${fmtBytes(res.sizeBytes)})`,
      })
      exitMergeMode()
      void refresh()
    } catch (e: unknown) {
      toast.error(t('mergeFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setMerging(false)
    }
  }

  const handleChatSearch = async () => {
    const q = chatQuery.trim()
    if (q.length < 2) {
      setChatSearchTooShort(true)
      setChatResults(null)
      return
    }
    setChatSearchTooShort(false)
    const reqId = ++chatReqIdRef.current
    setChatSearching(true)
    try {
      const res = await searchChatAll(q)
      if (!mountedRef.current || reqId !== chatReqIdRef.current) return
      setChatResults(res.results || [])
    } catch (e: unknown) {
      if (!mountedRef.current || reqId !== chatReqIdRef.current) return
      toast.error('Search failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      if (mountedRef.current && reqId === chatReqIdRef.current) {
        setChatSearching(false)
      }
    }
  }

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = files.filter((f) => {
      if (q) {
        const hay = `${f.name} ${f.displayTitle || ''} ${f.notes || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (filterMode === 'chat' && !f.hasEvents) return false
      if (filterMode === 'highlights' && !(f.highlightCount && f.highlightCount > 0)) return false
      if (filterMode === 'protected' && !f.protected) return false
      return true
    })
    return [...filtered].sort((a, b) => {
      if (sortMode === 'largest') return (b.sizeBytes || 0) - (a.sizeBytes || 0)
      if (sortMode === 'longest') return (b.durationSec || 0) - (a.durationSec || 0)
      return (b.mtime || 0) - (a.mtime || 0)
    })
  }, [files, query, filterMode, sortMode])

  const filterItems = useMemo(() => ({
    all: t('savedFilterAll'),
    chat: t('fChat'),
    highlights: t('highlights'),
    protected: t('savedFilterProtected'),
  }), [t])

  const sortItems = useMemo(() => ({
    newest: t('savedSortNewest'),
    largest: t('savedSortLargest'),
    longest: 'Longest',
  }), [t])

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <FolderOpen className="w-4 h-4 text-indigo-400" />
            {t('savedRec')}
            <span className="text-xs text-muted-foreground font-normal">({visibleFiles.length})</span>
          </h2>
          <div className="flex items-center gap-1.5">
            <Button
              variant={chatSearchOpen ? 'secondary' : 'outline'}
              size="xs"
              onClick={() => setChatSearchOpen((v) => !v)}
            >
              <MessageSquare className="w-3 h-3 mr-1" /> {t('chatSearchToggle')}
            </Button>
            {files.length >= 2 && (
              <Button
                variant={mergeMode ? 'secondary' : 'outline'}
                size="xs"
                onClick={() => mergeMode ? exitMergeMode() : setMergeMode(true)}
                disabled={merging}
              >
                <Layers className="w-3 h-3 mr-1" /> {t('mergeMode')}
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={refresh}>
              <RefreshCw className="w-3 h-3 mr-1" /> {t('btnRefresh')}
            </Button>
          </div>
        </div>

        {chatSearchOpen && (
          <div className="rounded-lg border border-border bg-secondary/40 p-2.5 space-y-2 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
                <Input
                  value={chatQuery}
                  onChange={(e) => {
                    const v = e.target.value
                    setChatQuery(v)
                    if (v.trim().length >= 2) setChatSearchTooShort(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleChatSearch()
                  }}
                  placeholder={t('chatSearchPlaceholder')}
                  className="h-7 pl-8 text-xs"
                />
              </div>
              <Button size="xs" onClick={() => void handleChatSearch()} disabled={chatSearching} className="h-7">
                {chatSearching ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
                {t('chatSearchToggle')}
              </Button>
            </div>
            {(chatSearchTooShort || (chatQuery.trim().length > 0 && chatQuery.trim().length < 2)) && (
              <p className="text-[11px] text-muted-foreground">{t('chatSearchMinChars')}</p>
            )}
            {chatResults !== null && (
              chatResults.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('chatSearchEmpty')}</p>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                  {chatResults.map((r, idx) => (
                    <Link
                      key={`${r.recording}:${r.ts}:${idx}`}
                      to={`/replay?file=${encodeURIComponent(r.recording)}`}
                      className="block rounded-md border border-border/60 bg-background/70 hover:bg-muted/80 px-2.5 py-1.5 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium text-foreground truncate">{r.user || 'unknown'}</span>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono shrink-0">
                          <span className="truncate max-w-[200px]">{r.recording}</span>
                          {r.ts > 0 && <span>{new Date(r.ts).toLocaleString()}</span>}
                        </div>
                      </div>
                      <p className="text-xs text-foreground/90 break-words mt-0.5">{r.comment}</p>
                    </Link>
                  ))}
                </div>
              )
            )}
          </div>
        )}

        {mergeMode && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/60 px-2.5 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="font-mono text-[11px]">
                {orderedSelectedFiles.length}
              </Badge>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox
                  checked={deleteSources}
                  onCheckedChange={(v) => setDeleteSources(!!v)}
                  disabled={merging}
                  className="w-3.5 h-3.5"
                />
                <span>{t('mergeDeleteOriginals')}</span>
              </label>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="xs"
                onClick={handleMerge}
                disabled={merging || orderedSelectedFiles.length < 2}
              >
                {merging
                  ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  : <Layers className="w-3 h-3 mr-1" />}
                {t('mergeSelected')} ({orderedSelectedFiles.length})
              </Button>
              <Button size="xs" variant="ghost" onClick={exitMergeMode} disabled={merging}>
                {t('btnCancel')}
              </Button>
            </div>
          </div>
        )}

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
            <Select items={filterItems} value={filterMode} onValueChange={(v) => v && setFilterMode(v as typeof filterMode)}>
              <SelectTrigger className="w-[130px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('savedFilterAll')}</SelectItem>
                <SelectItem value="chat">{t('fChat')}</SelectItem>
                <SelectItem value="highlights">{t('highlights')}</SelectItem>
                <SelectItem value="protected">{t('savedFilterProtected')}</SelectItem>
              </SelectContent>
            </Select>
            <Select items={sortItems} value={sortMode} onValueChange={(v) => v && setSortMode(v as typeof sortMode)}>
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
            visibleFiles.map((f) => {
              const isAudioOnly = f.vcodec === null && f.durationSec != null
              const isMp4 = f.name.toLowerCase().endsWith('.mp4')
              const isSelected = selectedFiles.includes(f.name)
              return (
              <div key={f.name} className="bg-secondary rounded-lg px-2 py-1.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                  {mergeMode && (
                    <Checkbox
                      checked={isSelected}
                      disabled={merging || !isMp4}
                      onCheckedChange={() => toggleSelectFile(f.name)}
                      aria-label={f.name}
                      className="shrink-0"
                    />
                  )}
                  {f.thumbUrl ? (
                    <img
                      src={f.thumbUrl}
                      alt=""
                      loading="lazy"
                      className="w-12 h-7 rounded object-cover bg-black shrink-0 border border-border"
                    />
                  ) : (
                    <div className="w-12 h-7 rounded bg-zinc-800/80 border border-border flex items-center justify-center text-[10px] text-muted-foreground shrink-0">
                      {isAudioOnly ? 'Audio' : 'MP4'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-foreground/90 truncate font-medium">
                      {f.displayTitle ? (
                        <>
                          <span>{f.displayTitle}</span>{' '}
                          <span className="font-mono text-[10px] text-muted-foreground">({f.name})</span>
                        </>
                      ) : (
                        <span className="font-mono">{f.name}</span>
                      )}
                    </div>
                    {f.notes && (
                      <div className="text-[10px] text-muted-foreground truncate">{f.notes}</div>
                    )}
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      {f.protected && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-emerald-700/30 text-emerald-200 border-emerald-700/40">
                          <Lock className="w-2.5 h-2.5 mr-0.5" /> {t('savedFilterProtected')}
                        </Badge>
                      )}
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
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => handleToggleProtect(f)}
                    title={f.protected ? t('savedUnprotect') : t('savedProtect')}
                    className={f.protected ? 'text-emerald-400 hover:text-emerald-300' : 'text-muted-foreground hover:text-foreground'}
                  >
                    {f.protected ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => editingName === f.name ? setEditingName(null) : startEditMeta(f)}
                    title={t('savedEditMeta')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
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
                  {!isAudioOnly && !/_(balanced|compact)\.mp4$/i.test(f.name) && (
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
                    href={recordingFileUrl(f.name)}
                    download
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-secondary hover:bg-muted border border-border text-foreground/80 rounded-md transition-colors"
                  >
                    <Download className="w-3 h-3" /> {t('btnDownload')}
                  </a>
                  <ConfirmButton
                    onConfirm={() => handleDelete(f.name)}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    title={t('savedDelete')}
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </ConfirmButton>
                </div>
                {editingName === f.name && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/50">
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      placeholder="Custom title..."
                      className="h-7 text-xs flex-1 min-w-[140px]"
                    />
                    <Input
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="Notes / tags..."
                      className="h-7 text-xs flex-1 min-w-[160px]"
                    />
                    <Button size="xs" onClick={() => saveEditMeta(f.name)} className="h-7 px-2">
                      <Check className="w-3 h-3 mr-1" /> {t('btnSave')}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditingName(null)} className="h-7 px-2">
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                )}
              </div>
              )
            })
          )}
        </div>
      </CardContent>
    </Card>
  )
})
