import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Eye, Plus, Bell, Loader2, X, RefreshCw, Save, Users, Radio, CircleOff, Circle, AlertCircle, Zap, SlidersHorizontal } from 'lucide-react'
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
import { parseChannelInput, hasExplicitPlatformHint } from '@/lib/utils'
import { PlatformBadge, PlatformSwitch } from '@/components/PlatformBadge'
import * as api from '@/lib/api'
import type { Platform, WatchData, WatchEvent } from '@/lib/types'
import { toast } from 'sonner'

interface Props {
  onJobsChanged?: () => void
}

export function Watchlist({ onJobsChanged }: Props) {
  const { t } = useI18n()
  const [watchData, setWatchData] = useState<WatchData>({ pollSeconds: 30, list: [] })
  const [events, setEvents] = useState<WatchEvent[]>([])
  const [addPlatform, setAddPlatform] = useState<Platform>('tiktok')
  const [addUsername, setAddUsername] = useState('')
  const [addQuality, setAddQuality] = useState('')
  const [addAutoRecord, setAddAutoRecord] = useState(true)
  const [adding, setAdding] = useState(false)
  const [pollSecondsInput, setPollSecondsInput] = useState('30')
  const [polling, setPolling] = useState(false)
  const [accounts, setAccounts] = useState<api.AccountInfo[]>([])
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [cfgPriority, setCfgPriority] = useState<'high' | 'normal'>('normal')
  const [cfgAccountId, setCfgAccountId] = useState('default')
  const [cfgMinViewers, setCfgMinViewers] = useState('')
  const [cfgSchedStart, setCfgSchedStart] = useState('')
  const [cfgSchedEnd, setCfgSchedEnd] = useState('')
  const [cfgRecordChat, setCfgRecordChat] = useState(true)
  const [notifsEnabled, setNotifsEnabled] = useState(
    () => typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted',
  )
  const notifsRef = useRef(notifsEnabled)
  const lastEventIdRef = useRef(0)
  const pollDirtyRef = useRef(false)
  const pollFocusedRef = useRef(false)

  useEffect(() => {
    notifsRef.current = notifsEnabled
  }, [notifsEnabled])

  const mergeWatchEvents = useCallback((incoming: WatchEvent[]) => {
    if (!incoming.length) return
    const valid = incoming.filter((ev) => ev && ev.id)
    if (!valid.length) return
    for (const ev of valid) {
      lastEventIdRef.current = Math.max(lastEventIdRef.current, ev.id)
    }
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id))
      const next = [...prev]
      for (const ev of valid) {
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
    api.getAccounts().then((r) => setAccounts(r.accounts || [])).catch(() => {})
  }, [syncMissedEvents])

  const refreshWatch = useCallback(async () => {
    try {
      const data = await api.getWatch()
      setWatchData(data)
      if (!pollDirtyRef.current && !pollFocusedRef.current) {
        setPollSecondsInput(String(data.pollSeconds))
      }
    } catch { /* ignore */ }
  }, [])

  const sseHandlers = useMemo(() => ({
    watch_list: (raw: unknown) => {
      const data = raw as WatchData
      if (data && Array.isArray(data.list)) {
        setWatchData(data)
        if (!pollDirtyRef.current && !pollFocusedRef.current) {
          setPollSecondsInput(String(data.pollSeconds))
        }
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
    if (adding) return
    const parsed = parseChannelInput(addUsername, addPlatform)
    if (!parsed.username) return
    setAdding(true)
    try {
      const quality = addQuality && addQuality !== 'auto' ? addQuality : null
      await api.addWatch(parsed.username, quality, addAutoRecord, {
        audioOnly: quality === 'ao',
        platform: parsed.platform,
      })
      toast.success(t('watchAdded'), { description: `@${parsed.username}` })
      setAddPlatform(parsed.platform)
      setAddUsername('')
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('watchAddFailed'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = async (username: string, platform?: Platform) => {
    try {
      await api.removeWatch(username, platform)
      toast.info(t('watchRemoved'), { description: '@' + username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('watchRemoveFailed'), { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleToggleAutoRecord = async (username: string, autoRecord: boolean, platform?: Platform) => {
    try {
      await api.patchWatch(username, { autoRecord, platform })
      toast.info(autoRecord ? t('watchAutoRecOn') : t('watchAutoRecOff'), { description: '@' + username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('updateFailed'), { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleToggleAudioOnly = async (entry: WatchData['list'][number], audioOnly: boolean) => {
    try {
      const patch: Parameters<typeof api.patchWatch>[1] = { audioOnly, platform: entry.platform }
      if (!audioOnly && entry.quality === 'ao') {
        patch.quality = null
      }
      await api.patchWatch(entry.username, patch)
      toast.info(audioOnly ? t('watchAudioOnlyOn') : t('watchAudioOnlyOff'), { description: '@' + entry.username })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('updateFailed'), { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const openChannelConfig = (e: WatchData['list'][number]) => {
    const key = `${e.platform || 'tiktok'}:${e.username}`
    if (editingKey === key) {
      setEditingKey(null)
      return
    }
    setEditingKey(key)
    setCfgPriority(e.priority === 'high' ? 'high' : 'normal')
    setCfgAccountId(e.accountId || 'default')
    setCfgMinViewers(e.minViewers != null ? String(e.minViewers) : '')
    setCfgSchedStart(e.scheduleStart || '')
    setCfgSchedEnd(e.scheduleEnd || '')
    setCfgRecordChat(e.recordChat !== false)
    api.getAccounts().then((r) => setAccounts(r.accounts || [])).catch(() => {})
  }

  const saveChannelConfig = async (username: string, platform?: Platform, accountIdOverride?: string) => {
    const accountIdToSave = accountIdOverride !== undefined ? accountIdOverride : cfgAccountId
    try {
      await api.patchWatch(username, {
        platform,
        priority: cfgPriority,
        accountId: accountIdToSave === 'default' ? null : accountIdToSave,
        minViewers: cfgMinViewers.trim() ? Number(cfgMinViewers) : null,
        scheduleStart: cfgSchedStart.trim() || null,
        scheduleEnd: cfgSchedEnd.trim() || null,
        recordChat: cfgRecordChat,
      })
      setEditingKey(null)
      toast.success(t('settingsSaved'), { description: '@' + username })
      void refreshWatch()
    } catch (err: unknown) {
      toast.error(t('updateFailed'), { description: err instanceof Error ? err.message : String(err) })
    }
  }

  const handleSavePoll = async () => {
    const trimmed = pollSecondsInput.trim()
    const parsed = trimmed ? Number(trimmed) : NaN
    if (!Number.isFinite(parsed) || parsed < 10) {
      toast.warning(t('watchInvalidInterval'), { description: t('watchMinInterval') })
      return
    }
    const clamped = Math.max(10, Math.round(parsed))
    setPollSecondsInput(String(clamped))
    try {
      await api.savePollSeconds(clamped)
      pollDirtyRef.current = false
      toast.success(t('watchPollSaved'), { description: clamped + 's' })
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('saveFailed'), { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handlePollNow = async () => {
    setPolling(true)
    try {
      await api.pollNow()
      void refreshWatch()
    } catch (e: unknown) {
      toast.error(t('watchPollFailed'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setPolling(false)
    }
  }

  const handleEnableNotifs = async () => {
    if (!('Notification' in window)) {
      toast.warning(t('watchNotifsUnsupported'))
      return
    }
    const perm = await Notification.requestPermission()
    const enabled = perm === 'granted'
    setNotifsEnabled(enabled)
    toast[enabled ? 'success' : 'warning'](enabled ? t('watchNotifsEnabled') : t('watchNotifsDenied'))
  }

  const addQualityItems = useMemo(() => ({
    auto: t('qAuto'),
    uhd4k_60: '4K 60fps (2160p)',
    uhd4k: '4K (2160p)',
    qhd_60: '2K 60fps (1440p)',
    qhd: '2K (1440p)',
    origin: 'origin',
    uhd_60: '1080p60',
    uhd: 'uhd (1080p)',
    hd: 'hd (720p)',
    sd: 'sd',
    ld: 'ld (360p)',
    ao: 'ao (audio only)',
  }), [t])

  const priorityItems = {
    normal: t('watchPriorityNormal'),
    high: t('watchPriorityHigh'),
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="font-semibold flex items-center gap-2 text-foreground">
            <Eye className="w-4 h-4 text-pink-400" /> {t('watchlistTitle')}
            <span className="text-xs text-muted-foreground font-normal">{t('watchlistSub')}</span>
          </h2>
          <div className="flex items-center gap-1.5 text-xs flex-wrap">
            <div className="inline-flex items-center gap-1 h-6 px-2 text-xs border border-border bg-background rounded-[min(var(--radius-md),10px)] dark:bg-input/30">
              <span className="text-muted-foreground">{t('pollEvery')}</span>
              <input
                type="number"
                min={10}
                step={5}
                value={pollSecondsInput}
                onFocus={() => { pollFocusedRef.current = true }}
                onBlur={() => {
                  pollFocusedRef.current = false
                  const trimmed = pollSecondsInput.trim()
                  if (!trimmed) {
                    setPollSecondsInput(String(watchData.pollSeconds))
                    pollDirtyRef.current = false
                    return
                  }
                  const parsed = Number(trimmed)
                  if (!Number.isFinite(parsed)) {
                    setPollSecondsInput(String(watchData.pollSeconds))
                    pollDirtyRef.current = false
                    return
                  }
                  setPollSecondsInput(String(Math.max(10, Math.round(parsed))))
                }}
                onChange={(e) => {
                  pollDirtyRef.current = true
                  setPollSecondsInput(e.target.value)
                }}
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
              {notifsEnabled ? t('watchNotifsOn') : t('btnNotif')}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <PlatformSwitch value={addPlatform} onChange={setAddPlatform} size="sm" />
          <div className="flex flex-1 min-w-[180px] items-center bg-secondary rounded-lg overflow-hidden border border-border focus-within:border-primary/60 transition">
            <span className="inline-flex items-center px-2.5 text-muted-foreground text-sm">@</span>
            <Input
              value={addUsername}
              onChange={(e) => {
                const val = e.target.value
                setAddUsername(val)
                if (hasExplicitPlatformHint(val)) {
                  const detected = parseChannelInput(val, addPlatform)
                  if (detected.platform !== addPlatform) setAddPlatform(detected.platform)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !adding) {
                  e.preventDefault()
                  void handleAdd()
                }
              }}
              placeholder={t('watchPlaceholderMulti')}
              className="border-0 bg-transparent shadow-none text-sm h-8 focus-visible:ring-0 px-1"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Select items={addQualityItems} value={addQuality} onValueChange={(v) => v !== null && setAddQuality(v)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder={t('qAuto')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('qAuto')}</SelectItem>
              <SelectItem value="uhd4k_60">4K 60fps (2160p)</SelectItem>
              <SelectItem value="uhd4k">4K (2160p)</SelectItem>
              <SelectItem value="qhd_60">2K 60fps (1440p)</SelectItem>
              <SelectItem value="qhd">2K (1440p)</SelectItem>
              <SelectItem value="origin">origin</SelectItem>
              <SelectItem value="uhd_60">1080p60</SelectItem>
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
            watchData.list.map((e) => {
              const entryKey = `${e.platform || 'tiktok'}:${e.username}`
              const entryPlatform = e.platform || 'tiktok'
              const platformAccounts = accounts.filter((a) => (a.platform || 'tiktok') === entryPlatform)
              const entryAccountItems: Record<string, string> = {
                default: t('watchActiveAccount'),
                anon: t('accAnonymous'),
              }
              for (const a of platformAccounts) entryAccountItems[a.id] = a.label
              const effectiveAccountId =
                cfgAccountId === 'default' || cfgAccountId === 'anon' || platformAccounts.some((a) => a.id === cfgAccountId)
                  ? cfgAccountId
                  : 'default'
              return (
              <div key={entryKey} className="bg-secondary/70 border border-border/50 rounded-lg px-2.5 py-1.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
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
                  {e.platform && e.platform !== 'tiktok' && <PlatformBadge platform={e.platform} />}
                  <span className="text-sm font-medium font-mono">@{e.username}</span>
                  {e.lastError?.trim() && (
                    <Badge
                      variant="secondary"
                      title={e.lastError}
                      className="text-[10px] px-1.5 py-0 gap-1 bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 max-w-[220px] shrink-0"
                    >
                      <AlertCircle className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">{e.lastError}</span>
                    </Badge>
                  )}
                  {e.priority === 'high' && (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 bg-amber-600/30 text-amber-200 border-amber-600/40" title={t('watchPriorityHigh')}>
                      <Zap className="w-2.5 h-2.5 mr-0.5" /> {t('watchFastBadge')}
                    </Badge>
                  )}
                  {e.recordChat === false && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                      {t('watchNoChat')}
                    </Badge>
                  )}
                  {(e.scheduleStart && e.scheduleEnd) && (
                    <span className="text-[10px] font-mono text-muted-foreground">{e.scheduleStart}-{e.scheduleEnd}</span>
                  )}
                  {e.minViewers != null && e.minViewers > 0 && (
                    <span className="text-[10px] text-muted-foreground">&ge;{e.minViewers}v</span>
                  )}
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
                      onCheckedChange={(v) => handleToggleAutoRecord(e.username, !!v, e.platform)}
                      className="w-3.5 h-3.5"
                    />
                    {t('autoRec')}
                  </label>
                  <label className="flex items-center gap-1 text-xs cursor-pointer text-muted-foreground" title={t('audioOnlyForce')}>
                    <Checkbox
                      checked={!!e.audioOnly || e.quality === 'ao'}
                      onCheckedChange={(v) => handleToggleAudioOnly(e, !!v)}
                      className="w-3.5 h-3.5"
                    />
                    {t('audioOnly')}
                  </label>
                  <span className="text-xs text-muted-foreground">{e.quality || 'auto'}</span>
                  {e.lastChangedAt && (
                    <span className="text-xs text-muted-foreground hidden md:inline">{t('watchSince')} {new Date(e.lastChangedAt).toLocaleTimeString()}</span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => openChannelConfig(e)}
                    title={t('watchRulesTooltip')}
                    className={editingKey === entryKey ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </Button>
                  <ConfirmButton
                    onConfirm={() => handleRemove(e.username, e.platform)}
                    confirmLabel={t('confirm')}
                    cancelLabel={t('cancel')}
                    title={t('watchRemove')}
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </ConfirmButton>
                </div>
                {editingKey === entryKey && (
                  <div className="flex flex-wrap items-center gap-2 pt-1.5 border-t border-border/50 text-xs">
                    <Select items={priorityItems} value={cfgPriority} onValueChange={(v) => v && setCfgPriority(v as 'high' | 'normal')}>
                      <SelectTrigger className="w-[125px] h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">{t('watchPriorityNormal')}</SelectItem>
                        <SelectItem value="high">{t('watchPriorityHigh')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select items={entryAccountItems} value={effectiveAccountId} onValueChange={(v) => v && setCfgAccountId(v)}>
                      <SelectTrigger className="w-[140px] h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t('watchActiveAccount')}</SelectItem>
                        <SelectItem value="anon">{t('accAnonymous')}</SelectItem>
                        {platformAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      placeholder={t('watchMinViewersPlaceholder')}
                      value={cfgMinViewers}
                      onChange={(ev) => setCfgMinViewers(ev.target.value)}
                      className="h-7 w-24 text-xs tabular-nums"
                    />
                    <div className="flex items-center gap-1">
                      <Input
                        type="time"
                        value={cfgSchedStart}
                        onChange={(ev) => setCfgSchedStart(ev.target.value)}
                        className="h-7 w-24 text-xs"
                        aria-label={t('watchScheduleStart')}
                      />
                      <span className="text-muted-foreground">-</span>
                      <Input
                        type="time"
                        value={cfgSchedEnd}
                        onChange={(ev) => setCfgSchedEnd(ev.target.value)}
                        className="h-7 w-24 text-xs"
                        aria-label={t('watchScheduleEnd')}
                      />
                    </div>
                    <label className="flex items-center gap-1.5 cursor-pointer px-1">
                      <Checkbox
                        checked={cfgRecordChat}
                        onCheckedChange={(v) => setCfgRecordChat(!!v)}
                        className="w-3.5 h-3.5"
                      />
                      <span>{t('watchRecordChat')}</span>
                    </label>
                    <Button size="xs" onClick={() => saveChannelConfig(e.username, e.platform, effectiveAccountId)} className="h-7 ml-auto">
                      <Save className="w-3 h-3 mr-1" /> {t('btnSave')}
                    </Button>
                  </div>
                )}
              </div>
              )
            })
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
                    {e.platform && e.platform !== 'tiktok' && <PlatformBadge platform={e.platform} />}
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
