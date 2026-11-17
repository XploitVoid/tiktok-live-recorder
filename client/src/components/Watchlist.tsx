import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Eye, Plus, Bell, Loader2, X, RefreshCw, Save, Users, Radio, CircleOff, Circle, AlertCircle } from 'lucide-react'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { useI18n } from '@/lib/i18n'
import { useEventStream } from '@/lib/useEventStream'
import { fmtTime } from '@/lib/format'
import { cleanUsernameInput } from '@/lib/utils'
import * as api from '@/lib/api'
import type { WatchData, WatchEvent } from '@/lib/types'
import { toast } from 'sonner'

interface Props {
  onJobsChanged?: () => void
}

export function Watchlist({ onJobsChanged }: Props) {
  const { t } = useI18n()
  const [watchData, setWatchData] = useState<WatchData>({ pollSeconds: 30, list: [] })
  const [events, setEvents] = useState<WatchEvent[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [addQuality, setAddQuality] = useState('')
  const [addAutoRecord, setAddAutoRecord] = useState(true)
  const [adding, setAdding] = useState(false)
  const [pollSeconds, setPollSeconds] = useState(30)
  const [polling, setPolling] = useState(false)
  const [notifsEnabled, setNotifsEnabled] = useState(
    () => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted',
  )
  const notifsRef = useRef(notifsEnabled)
  const lastEventIdRef = useRef(0)

  useEffect(() => {
    notifsRef.current = notifsEnabled
  }, [notifsEnabled])

  const mergeWatchEvents = useCallback((incoming: WatchEvent[]) => {
    if (!incoming.length) return
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id))
      const next = [...prev]
      for (const ev of incoming) {
        if (!ev || !ev.id) continue
        lastEventIdRef.current = Math.max(lastEventIdRef.current, ev.id)
        if (!seen.has(ev.id)) {
          seen.add(ev.id)
          next.push(ev)
        }
      }
      next.sort((a, b) => a.id - b.id)
      return next.slice(-50)
    })
  }, [])

  const syncMissedEvents = useCallback(async () => {
    try {
      const missed = await api.getWatchEvents(lastEventIdRef.current)
      mergeWatchEvents(missed)
    } catch { /* ignore */ }
  }, [mergeWatchEvents])

  useEffect(() => {
    void syncMissedEvents()
  }, [syncMissedEvents])

  const refreshWatch = useCallback(async () => {
    try {
      const data = await api.getWatch()
      setWatchData(data)
      setPollSeconds(data.pollSeconds)
    } catch { /* ignore */ }
  }, [])

  const sseHandlers = useMemo(() => ({
    watch_list: (raw: unknown) => {
      const data = raw as WatchData
      if (data && Array.isArray(data.list)) {
        setWatchData(data)
        setPollSeconds(data.pollSeconds)
      }
      void syncMissedEvents()
    },
    watch_event: (raw: unknown) => {
      const ev = raw as WatchEvent
      if (!ev || !ev.id) return
      if (ev.id <= lastEventIdRef.current) return
      if (notifsRef.current) {
        if (ev.type === 'went_live') notify(`@${ev.username} is LIVE`, ev.title || 'Now streaming')
        else if (ev.type === 'record_started') notify(`Recording @${ev.username}`, `Quality: ${ev.quality} → ${ev.file}`)
        else if (ev.type === 'record_failed') notify(`Record failed: @${ev.username}`, ev.error || '')
      }
      mergeWatchEvents([ev])
      onJobsChanged?.()
    },
  }), [onJobsChanged, mergeWatchEvents, syncMissedEvents])

  useEventStream('channels=watch', sseHandlers, true, notifsEnabled)

  const handleAdd = async () => {
    const u = cleanUsernameInput(addUsername)
    if (!u) return
    setAdding(true)
    try {
      const quality = addQuality && addQuality !== 'auto' ? addQuality : null
      await api.addWatch(u, quality, addAutoRecord, { audioOnly: quality === 'ao' })
      toast.success('Added to watchlist', { description: '@' + u })
      setAddUsername('')
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Add failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (username: string) => {
    try {
      await api.removeWatch(username)
      toast.info('Removed', { description: '@' + username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Remove failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleToggleAutoRecord = async (username: string, autoRecord: boolean) => {
    try {
      await api.patchWatch(username, { autoRecord })
      toast.info(autoRecord ? 'Auto-record on' : 'Auto-record off', { description: '@' + username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Update failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleToggleAudioOnly = async (username: string, audioOnly: boolean) => {
    try {
      await api.patchWatch(username, { audioOnly })
      toast.info(audioOnly ? 'Audio-only on' : 'Audio-only off', { description: '@' + username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Update failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleSavePoll = async () => {
    if (!Number.isFinite(pollSeconds) || pollSeconds < 10) {
      toast.warning('Invalid interval', { description: 'Minimum 10 seconds' })
      return
    }
    try {
      await api.savePollSeconds(pollSeconds)
      toast.success('Poll interval saved', { description: pollSeconds + 's' })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Save failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handlePollNow = async () => {
    setPolling(true)
    try {
      await api.pollNow()
      void refreshWatch()
    } catch (e: unknown) {
      toast.error('Poll failed', { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setPolling(false)
    }
  }

  const handleEnableNotifs = async () => {
    if (!('Notification' in window)) {
      toast.warning('Notifications not supported')
      return
    }
    const perm = await Notification.requestPermission()
    const enabled = perm === 'granted'
    setNotifsEnabled(enabled)
    toast[enabled ? 'success' : 'warning'](enabled ? 'Notifications enabled' : 'Notifications denied')
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <Eye className="w-4 h-4 text-pink-400" /> Watchlist
            <span className="text-xs text-muted-foreground font-normal">{t('watchlistSub')}</span>
          </h2>
          <div className="flex items-center gap-1.5 text-xs flex-wrap">
            <div className="inline-flex items-center gap-1 h-6 px-2 text-xs border border-border bg-background rounded-[min(var(--radius-md),10px)] dark:bg-input/30">
              <span className="text-muted-foreground">{t('pollEvery')}</span>
              <input
                type="number"
                min={10}
                step={5}
                value={pollSeconds}
                onChange={(e) => setPollSeconds(Number(e.target.value))}
                className="poll-every-input w-9 h-full text-center text-xs bg-transparent border-0 p-0 m-0 outline-none leading-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span className="text-muted-foreground">{t('secLabel')}</span>
            </div>
            <Button variant="outline" size="xs" onClick={handleSavePoll}>
              <Save className="w-3 h-3 mr-1" /> {t('btnSave')}
            </Button>
            <Button variant="outline" size="xs" onClick={handlePollNow} disabled={polling}>
              {polling ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              {t('btnPollNow')}
            </Button>
            <Button variant="outline" size="xs" onClick={handleEnableNotifs}>
              <Bell className="w-3 h-3 mr-1" />
              {notifsEnabled ? 'Notifs ON' : t('btnNotif')}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <div className="flex flex-1 min-w-[180px] items-center bg-secondary rounded-lg overflow-hidden border border-border focus-within:border-primary/60 transition">
            <span className="inline-flex items-center px-2.5 text-muted-foreground text-sm">@</span>
            <Input
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="username"
              className="border-0 bg-transparent shadow-none text-sm h-8 focus-visible:ring-0 px-1"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Select value={addQuality} onValueChange={(v) => v !== null && setAddQuality(v)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder={t('qAuto')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('qAuto')}</SelectItem>
              <SelectItem value="origin">origin</SelectItem>
              <SelectItem value="uhd">uhd (1080p)</SelectItem>
              <SelectItem value="hd">hd (720p)</SelectItem>
              <SelectItem value="sd">sd</SelectItem>
              <SelectItem value="ld">ld (360p)</SelectItem>
              <SelectItem value="ao">ao (audio only)</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-sm bg-secondary border border-border rounded-lg px-2.5 py-1.5 cursor-pointer">
            <Checkbox checked={addAutoRecord} onCheckedChange={(v) => setAddAutoRecord(!!v)} className="w-3.5 h-3.5" />
            <span className="text-xs">{t('autoRecord')}</span>
          </label>
          <Button
            onClick={handleAdd}
            disabled={adding}
            size="sm"
            className="bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white border-0 shadow-md shadow-pink-600/20"
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
            {t('btnAdd')}
          </Button>
        </div>

        <div className="space-y-1 text-sm">
          {watchData.list.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('emptyList')}</p>
          ) : (
            watchData.list.map((e) => (
              <div key={e.username} className="flex items-center gap-2 bg-secondary/70 border border-border/50 rounded-lg px-2.5 py-1.5 flex-wrap sm:flex-nowrap">
                <Badge
                  variant={e.lastStatus === 'live' ? 'destructive' : 'secondary'}
                  className={e.lastStatus === 'live' ? 'bg-primary text-primary-foreground text-[10px] gap-1 shrink-0' : 'text-[10px] gap-1 shrink-0'}
                >
                  {e.lastStatus === 'live' ? (
                    <><Radio className="w-2.5 h-2.5" /> {t('liveBadge')}</>
                  ) : e.lastStatus === 'offline' ? (
                    <><CircleOff className="w-2.5 h-2.5" /> {t('offline')}</>
                  ) : (
                    <span>...</span>
                  )}
                </Badge>
                <span className="text-sm font-medium font-mono">@{e.username}</span>
                {e.lastStatus === 'live' && e.lastViewerCount != null && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                    <Users className="w-3 h-3" /> {e.lastViewerCount.toLocaleString()}
                  </span>
                )}
                {e.lastTitle && <span className="text-xs text-muted-foreground truncate">{e.lastTitle}</span>}
                <span className="flex-1" />
                <label className="flex items-center gap-1 text-xs cursor-pointer">
                  <Checkbox
                    checked={e.autoRecord}
                    onCheckedChange={(v) => handleToggleAutoRecord(e.username, !!v)}
                    className="w-3.5 h-3.5"
                  />
                  {t('autoRec')}
                </label>
                <label className="flex items-center gap-1 text-xs cursor-pointer text-muted-foreground" title={t('audioOnlyForce')}>
                  <Checkbox
                    checked={!!e.audioOnly || e.quality === 'ao'}
                    onCheckedChange={(v) => handleToggleAudioOnly(e.username, !!v)}
                    className="w-3.5 h-3.5"
                  />
                  {t('audioOnly')}
                </label>
                <span className="text-xs text-muted-foreground">{e.quality || 'auto'}</span>
                {e.lastChangedAt && (
                  <span className="text-xs text-muted-foreground">since {new Date(e.lastChangedAt).toLocaleTimeString()}</span>
                )}
                <ConfirmButton
                  onConfirm={() => handleRemove(e.username)}
                  confirmLabel={t('confirm')}
                  cancelLabel={t('cancel')}
                  title={t('btnCancel')}
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="w-3.5 h-3.5" />
                </ConfirmButton>
              </div>
            ))
          )}
        </div>

        <Separator className="my-4" />

        <div>
          <h3 className="text-xs font-semibold mb-2 text-muted-foreground uppercase tracking-wider">{t('recentEvents')}</h3>
          <div className="space-y-1 text-xs max-h-48 overflow-y-auto pr-1">
            {events.length === 0 ? (
              <p className="text-muted-foreground">{t('noneYet')}</p>
            ) : (
              [...events].reverse().map((e) => {
                let color = 'text-foreground/75'
                let EventIcon = Circle
                if (e.type === 'went_live') { color = 'text-primary'; EventIcon = Radio }
                if (e.type === 'went_offline') { color = 'text-muted-foreground'; EventIcon = CircleOff }
                if (e.type === 'record_started') { color = 'text-emerald-400'; EventIcon = Circle }
                if (e.type === 'record_failed') { color = 'text-destructive'; EventIcon = AlertCircle }
                const detail =
                  e.type === 'went_live' ? ` — ${e.title || ''} ${e.viewerCount ? `(${e.viewerCount.toLocaleString()})` : ''}` :
                  e.type === 'record_started' ? ` — ${e.quality || ''} (${e.file})` :
                  e.type === 'record_failed' ? ` — ${e.error}` : ''
                return (
                  <div key={e.id} className={`flex items-center gap-1.5 py-0.5 ${color}`}>
                    <span className="text-muted-foreground font-mono tabular-nums shrink-0">{fmtTime(e.ts)}</span>
                    <EventIcon className="w-3 h-3 shrink-0" />
                    <strong className="font-mono">@{e.username}</strong>
                    <span className="opacity-80">{e.type}</span>
                    {detail && <span className="truncate text-muted-foreground">{detail}</span>}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function notify(title: string, body: string) {
  try {
    const n = new Notification(title, { body })
    setTimeout(() => n.close(), 8000)
  } catch { /* ignore */ }
}
