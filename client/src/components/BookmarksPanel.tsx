import { useState, useEffect, useCallback } from 'react'
import { Bookmark, Plus, Trash2, Play } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/lib/i18n'
import { getBookmarks, addBookmark, deleteBookmark, type Bookmark as BM } from '@/lib/api'
import { fmtTimeSec } from '@/lib/format'
import { toast } from 'sonner'

interface Props {
  recording: string
  currentTime: number
  onJump: (sec: number) => void
}

export function BookmarksPanel({ recording, currentTime, onJump }: Props) {
  const { t } = useI18n()
  const [bookmarks, setBookmarks] = useState<BM[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await getBookmarks(recording)
      setBookmarks(data.bookmarks || [])
    } catch { /* ignore */ }
  }, [recording])

  useEffect(() => { refresh() }, [refresh])

  const handleAdd = async () => {
    if (currentTime <= 0) return
    setLoading(true)
    try {
      await addBookmark(recording, currentTime, note)
      setNote('')
      toast.success(t('bmAdded'))
      await refresh()
    } catch (e: unknown) {
      toast.error('Failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteBookmark(recording, id)
      await refresh()
    } catch { /* ignore */ }
  }

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center gap-2">
          <Bookmark className="w-4 h-4 text-orange-400" />
          <h2 className="font-semibold">{t('bmTitle')}</h2>
          <span className="text-xs text-muted-foreground">({bookmarks.length})</span>
        </div>

        {/* Add bookmark form */}
        <div className="flex gap-2 items-center">
          <span className="text-xs font-mono text-muted-foreground w-14 text-right">
            {fmtTimeSec(currentTime)}
          </span>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder={t('bmNotePlaceholder')}
            className="h-7 text-xs flex-1"
          />
          <Button size="xs" onClick={handleAdd} disabled={loading || currentTime <= 0}>
            <Plus className="w-3 h-3 mr-1" /> {t('bmAdd')}
          </Button>
        </div>

        {/* Bookmarks list */}
        {bookmarks.length > 0 && (
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {bookmarks.map((bm) => (
              <div key={bm.id} className="flex items-center gap-2 bg-secondary/60 rounded-lg px-2 py-1 text-xs border border-border">
                <Button variant="ghost" size="icon-xs" onClick={() => onJump(bm.timeSec)}>
                  <Play className="w-3 h-3" />
                </Button>
                <span className="font-mono text-orange-300 w-14">{fmtTimeSec(bm.timeSec)}</span>
                <span className="flex-1 truncate text-foreground/80">{bm.note || '—'}</span>
                <Button variant="ghost" size="icon-xs" onClick={() => handleDelete(bm.id)} className="text-destructive/60 hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
