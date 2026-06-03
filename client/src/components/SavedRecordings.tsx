import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { FolderOpen, RefreshCw, Trash2, Download, Play, MessageSquare, Sparkles, Scissors } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/lib/i18n'
import { fmtBytes } from '@/lib/format'
import { getRecordings, deleteRecording } from '@/lib/api'
import type { RecordingFile } from '@/lib/types'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'

export interface SavedRecordingsRef {
  refresh: () => void
}

export const SavedRecordings = forwardRef<SavedRecordingsRef>(function SavedRecordings(_props, ref) {
  const { t } = useI18n()
  const [files, setFiles] = useState<RecordingFile[]>([])

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
    refresh()
  }, [refresh])

  const handleDelete = async (name: string) => {
    if (!confirm('Delete ' + name + '?')) return
    try {
      await deleteRecording(name)
      toast.info('Deleted', { description: name })
      refresh()
    } catch (e: unknown) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <FolderOpen className="w-4 h-4 text-indigo-400" />
            {t('savedRec')}
          </h2>
          <Button variant="ghost" size="xs" onClick={refresh}>
            <RefreshCw className="w-3 h-3 mr-1" /> {t('btnRefresh')}
          </Button>
        </div>
        <div className="space-y-1.5 text-sm">
          {files.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('emptyList')}</p>
          ) : (
            files.map((f) => (
              <div key={f.name} className="flex items-center gap-2 bg-secondary rounded-lg px-2 py-1.5">
                {f.hasEvents && (
                  <Badge variant="secondary" className="text-[10px] bg-pink-700/30 text-pink-200 border-pink-700/40">
                    <MessageSquare className="w-2.5 h-2.5 mr-0.5" /> chat
                  </Badge>
                )}
                {!!f.highlightCount && f.highlightCount > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-amber-700/30 text-amber-200 border-amber-700/40" title={`${f.highlightCount} highlight candidates`}>
                    <Sparkles className="w-2.5 h-2.5 mr-0.5" /> {f.highlightCount}
                  </Badge>
                )}
                {!!f.clipCount && f.clipCount > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-indigo-700/30 text-indigo-200 border-indigo-700/40" title={`${f.clipCount} cut clips`}>
                    <Scissors className="w-2.5 h-2.5 mr-0.5" /> {f.clipCount}
                  </Badge>
                )}
                <span className="text-xs text-foreground/80 flex-1 truncate font-mono">{f.name}</span>
                <span className="text-xs text-muted-foreground">{fmtBytes(f.sizeBytes)}</span>
                <Link
                  to={`/replay?file=${encodeURIComponent(f.name)}`}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
                >
                  <Play className="w-3 h-3" /> {t('btnReplay')}
                </Link>
                <a
                  href={`/files/${encodeURIComponent(f.name)}`}
                  download
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-secondary hover:bg-muted border border-border text-foreground/80 rounded-md transition-colors"
                >
                  <Download className="w-3 h-3" /> {t('btnDownload')}
                </a>
                <Button variant="destructive" size="icon-xs" onClick={() => handleDelete(f.name)}>
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
})
