import { useState, useEffect, useCallback, useRef } from 'react'
import { HardDrive, Settings2, Trash2, ChevronDown, ChevronUp, Save, BellRing, Database, RefreshCw, AlertTriangle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getSettings, saveSettings, runStorageCleanup, testWebhookSettings, getSearchIndexStatus, reindexSearchIndex } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { AppSettings, DiskStatus, SearchIndexStatus } from '@/lib/types'
import { toast } from 'sonner'

export function SettingsPanel({ onCleanup }: { onCleanup?: () => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [disk, setDisk] = useState<DiskStatus | null>(null)
  const [minFreeGb, setMinFreeGb] = useState('2')
  const [maxRecordingsGb, setMaxRecordingsGb] = useState('0')
  const [retentionDays, setRetentionDays] = useState('0')
  const [segmentMinutes, setSegmentMinutes] = useState('0')
  const [autoRetryRecord, setAutoRetryRecord] = useState(true)
  const [autoMergeParts, setAutoMergeParts] = useState(true)
  const [stalledTimeoutSec, setStalledTimeoutSec] = useState('25')
  const [defaultAudioBitrate, setDefaultAudioBitrate] = useState('copy')
  const [organizeByCreator, setOrganizeByCreator] = useState(false)
  const [filenameTemplate, setFilenameTemplate] = useState('{username}_{date}_{time}')
  const [recordFormat, setRecordFormat] = useState<'mp4' | 'ts'>('mp4')
  const [searchIndex, setSearchIndex] = useState<SearchIndexStatus | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryingLoad, setRetryingLoad] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingWebhook, setTestingWebhook] = useState(false)
  const mountedRef = useRef(true)
  const loadSeqRef = useRef(0)

  const applySettingsToForm = useCallback((s: AppSettings) => {
    setSettings(s)
    setMinFreeGb(String(s.minFreeGb))
    setMaxRecordingsGb(String(s.maxRecordingsGb))
    setRetentionDays(String(s.retentionDays))
    setSegmentMinutes(String(s.segmentMinutes))
    setAutoRetryRecord(s.autoRetryRecord)
    setAutoMergeParts(s.autoMergeParts ?? true)
    setStalledTimeoutSec(String(s.stalledTimeoutSec ?? 25))
    setDefaultAudioBitrate(s.defaultAudioBitrate || 'copy')
    setOrganizeByCreator(!!s.organizeByCreator)
    setFilenameTemplate(s.filenameTemplate || '{username}_{date}_{time}')
    setRecordFormat(s.recordFormat === 'ts' ? 'ts' : 'mp4')
    setTelegramChatId(s.telegramChatId || '')
  }, [])

  const parseNumericField = (raw: string, fallback: number): number => {
    const trimmed = raw.trim()
    if (!trimmed) return fallback
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : fallback
  }

  const runSettingsFetch = useCallback(() => {
    const seq = ++loadSeqRef.current
    return getSettings()
      .then((res) => {
        if (!mountedRef.current || seq !== loadSeqRef.current) return
        setDisk(res.disk)
        applySettingsToForm(res.settings)
        setLoaded(true)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        if (!mountedRef.current || seq !== loadSeqRef.current) return
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (mountedRef.current && seq === loadSeqRef.current) {
          setRetryingLoad(false)
        }
      })
  }, [applySettingsToForm])

  const handleRetryLoad = () => {
    setRetryingLoad(true)
    void runSettingsFetch()
  }

  useEffect(() => {
    mountedRef.current = true
    void runSettingsFetch()
    getSearchIndexStatus()
      .then((s) => { if (mountedRef.current) setSearchIndex(s) })
      .catch(() => { /* ignore */ })
    return () => { mountedRef.current = false }
  }, [runSettingsFetch])

  useEffect(() => {
    if (!open) return
    let active = true
    getSearchIndexStatus()
      .then((s) => { if (active) setSearchIndex(s) })
      .catch(() => { /* ignore */ })
    return () => { active = false }
  }, [open])

  const handleSave = async () => {
    if (!loaded || saving) return
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        minFreeGb: parseNumericField(minFreeGb, settings?.minFreeGb ?? 2),
        maxRecordingsGb: parseNumericField(maxRecordingsGb, settings?.maxRecordingsGb ?? 0),
        retentionDays: parseNumericField(retentionDays, settings?.retentionDays ?? 0),
        segmentMinutes: parseNumericField(segmentMinutes, settings?.segmentMinutes ?? 0),
        autoRetryRecord,
        autoMergeParts,
        stalledTimeoutSec: parseNumericField(stalledTimeoutSec, settings?.stalledTimeoutSec ?? 25),
        defaultAudioBitrate: defaultAudioBitrate === 'copy' ? null : defaultAudioBitrate,
        organizeByCreator,
        filenameTemplate: filenameTemplate.trim() || '{username}_{date}_{time}',
        recordFormat,
        telegramChatId: telegramChatId.trim(),
      }
      if (proxyUrl.trim()) patch.proxyUrl = proxyUrl.trim()
      if (discordWebhookUrl.trim()) patch.discordWebhookUrl = discordWebhookUrl.trim()
      if (telegramBotToken.trim()) patch.telegramBotToken = telegramBotToken.trim()
      const res = await saveSettings(patch)
      setDisk(res.disk)
      applySettingsToForm(res.settings)
      setProxyUrl('')
      setDiscordWebhookUrl('')
      setTelegramBotToken('')
      toast.success(t('settingsSaved'))
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const handleClearWebhook = async (which: 'discord' | 'telegram') => {
    setSaving(true)
    try {
      const patch = which === 'discord'
        ? { discordWebhookUrl: '' }
        : { telegramBotToken: '', telegramChatId: '' }
      const res = await saveSettings(patch)
      setDisk(res.disk)
      applySettingsToForm(res.settings)
      if (which === 'discord') setDiscordWebhookUrl('')
      else { setTelegramBotToken(''); setTelegramChatId('') }
      toast.info(t('settingsSaved'))
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const handleTestWebhook = async () => {
    setTestingWebhook(true)
    try {
      await testWebhookSettings()
      toast.success(t('settingsWebhookSent'))
    } catch (e: unknown) {
      toast.error(t('settingsWebhookFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setTestingWebhook(false)
    }
  }

  const handleClearProxy = async () => {
    setSaving(true)
    try {
      const res = await saveSettings({ proxyUrl: '' })
      setDisk(res.disk)
      applySettingsToForm(res.settings)
      setProxyUrl('')
      toast.info(t('settingsSaved'))
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const handleCleanup = async () => {
    try {
      const res = await runStorageCleanup()
      setDisk(res.disk)
      toast.success(`${t('settingsCleanupDone')} (${res.deleted.length})`)
      onCleanup?.()
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleReindex = async () => {
    setReindexing(true)
    try {
      const res = await reindexSearchIndex()
      setSearchIndex(res)
      toast.success(t('settingsReindexDone'), {
        description: `${res.recordingsIndexed} rec / ${res.chatMessagesIndexed.toLocaleString()} msg (+${res.synced}, -${res.pruned})`,
      })
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setReindexing(false)
    }
  }

  const audioBitrateItems = {
    copy: t('audioBitrateCopy'),
    '64k': '64 kbps',
    '96k': '96 kbps',
    '128k': '128 kbps',
    '192k': '192 kbps',
  }

  const recordFormatItems = {
    mp4: t('settingsFormatMp4'),
    ts: t('settingsFormatTs'),
  }

  return (
    <Card className="border-border/80">
      <CardContent className="pt-4 pb-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left cursor-pointer group"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <HardDrive className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            <span className="font-semibold text-sm">{t('settingsTitle')}</span>
            {disk && (
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                {fmtBytes(disk.recordingsBytes)}
                {disk.freeBytes != null ? ` / ${t('settingsFreeLabel')} ${fmtBytes(disk.freeBytes)}` : ''}
              </span>
            )}
            {disk?.lowSpace && (
              <Badge variant="destructive" className="text-[10px]">{t('settingsLowDisk')}</Badge>
            )}
            {settings?.hasProxy && (
              <Badge variant="secondary" className="text-[10px] border border-border">
                {t('settingsProxyOn')}
              </Badge>
            )}
            {(settings?.hasDiscordWebhook || settings?.hasTelegram) && (
              <Badge variant="secondary" className="text-[10px] border border-border">
                {t('settingsAlertsOn')}
              </Badge>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
            <Settings2 className="w-3.5 h-3.5" />
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </span>
        </button>

        {open && (
          <div className="mt-4 pt-3 border-t border-border/70 space-y-3.5 text-xs">
            {loadError && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{t('settingsLoadFailed')}: {loadError}</span>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={handleRetryLoad}
                  disabled={retryingLoad}
                  className="h-7 shrink-0"
                >
                  <RefreshCw className={retryingLoad ? 'w-3 h-3 mr-1 animate-spin' : 'w-3 h-3 mr-1'} />
                  {t('retry')}
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsMinFreeGb')}</label>
                <Input type="number" min={0} step={0.5} value={minFreeGb} onChange={(e) => setMinFreeGb(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsMaxQuotaGb')}</label>
                <Input type="number" min={0} step={1} value={maxRecordingsGb} onChange={(e) => setMaxRecordingsGb(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsRetentionDays')}</label>
                <Input type="number" min={0} step={1} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsSegmentMinutes')}</label>
                <Input type="number" min={0} step={5} value={segmentMinutes} onChange={(e) => setSegmentMinutes(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsStalledSec')}</label>
                <Input type="number" min={0} max={600} step={5} value={stalledTimeoutSec} onChange={(e) => setStalledTimeoutSec(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsDefaultAudioBitrate')}</label>
                <Select items={audioBitrateItems} value={defaultAudioBitrate} onValueChange={(v) => v && setDefaultAudioBitrate(v)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="copy">{t('audioBitrateCopy')}</SelectItem>
                    <SelectItem value="64k">64 kbps</SelectItem>
                    <SelectItem value="96k">96 kbps</SelectItem>
                    <SelectItem value="128k">128 kbps</SelectItem>
                    <SelectItem value="192k">192 kbps</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col justify-end gap-1.5 pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={autoRetryRecord} onCheckedChange={(v) => setAutoRetryRecord(!!v)} className="w-3.5 h-3.5" />
                  <span>{t('settingsRetry')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={autoMergeParts} onCheckedChange={(v) => setAutoMergeParts(!!v)} className="w-3.5 h-3.5" />
                  <span>{t('settingsAutoMerge')}</span>
                </label>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3 items-start pt-0.5">
              <div>
                <label className="text-muted-foreground block mb-1">{t('settingsRecordFormat')}</label>
                <Select items={recordFormatItems} value={recordFormat} onValueChange={(v) => v && setRecordFormat(v as 'mp4' | 'ts')}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mp4">{t('settingsFormatMp4')}</SelectItem>
                    <SelectItem value="ts">{t('settingsFormatTs')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-2 space-y-1.5">
                <div>
                  <label className="text-muted-foreground block mb-1">{t('settingsFilenameTemplate')}</label>
                  <Input
                    value={filenameTemplate}
                    onChange={(e) => setFilenameTemplate(e.target.value)}
                    placeholder="{username}_{date}_{time}"
                    className="h-8 text-xs font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">{t('settingsFilenameHint')}</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer pt-0.5">
                  <Checkbox checked={organizeByCreator} onCheckedChange={(v) => setOrganizeByCreator(!!v)} className="w-3.5 h-3.5" />
                  <span>{t('settingsOrganizeByCreator')}</span>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-secondary/40 px-2.5 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium text-foreground">{t('settingsSearchIndex')}</span>
                {searchIndex && (
                  searchIndex.available ? (
                    <span className="text-muted-foreground font-mono tabular-nums">
                      {searchIndex.recordingsIndexed} rec / {searchIndex.chatMessagesIndexed.toLocaleString()} msg ({fmtBytes(searchIndex.dbBytes)})
                    </span>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">N/A</Badge>
                  )
                )}
              </div>
              <Button
                size="xs"
                variant="outline"
                onClick={handleReindex}
                disabled={reindexing || searchIndex?.available === false}
                className="h-7"
              >
                <RefreshCw className={reindexing ? 'w-3 h-3 mr-1 animate-spin' : 'w-3 h-3 mr-1'} />
                {t('settingsReindex')}
              </Button>
            </div>

            <div className="grid sm:grid-cols-2 gap-2 pt-0.5">
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  value={discordWebhookUrl}
                  onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                  placeholder={settings?.hasDiscordWebhook ? `Discord: ${settings.discordWebhookPreview}` : t('settingsDiscordPlaceholder')}
                  autoComplete="off"
                  className="h-8 text-xs flex-1 font-mono"
                />
                {settings?.hasDiscordWebhook && (
                  <Button size="xs" variant="outline" onClick={() => handleClearWebhook('discord')} disabled={saving} className="h-8">
                    {t('btnClear')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  placeholder={(settings?.hasTelegram || settings?.hasTelegramToken) ? `Telegram: ${settings.telegramBotPreview}` : t('settingsTelegramTokenPlaceholder')}
                  autoComplete="off"
                  className="h-8 text-xs flex-1 font-mono"
                />
                <Input
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder={t('settingsTelegramChatIdPlaceholder')}
                  autoComplete="off"
                  className="h-8 text-xs w-28 font-mono"
                />
                {(settings?.hasTelegram || settings?.hasTelegramToken) && (
                  <Button size="xs" variant="outline" onClick={() => handleClearWebhook('telegram')} disabled={saving} className="h-8">
                    {t('btnClear')}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Input
                type="password"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder={settings?.hasProxy ? `${t('settingsCurrentProxy')} ${settings.proxyPreview}` : `${t('settingsProxyPlaceholder')} ${t('settingsProxyFailoverHint')}`}
                autoComplete="off"
                className="h-8 text-xs flex-1 min-w-[220px] font-mono"
              />
              {settings?.hasProxy && (
                <Button size="xs" variant="outline" onClick={handleClearProxy} disabled={saving} className="h-8">
                  {t('settingsClearProxy')}
                </Button>
              )}
              {(settings?.hasDiscordWebhook || settings?.hasTelegram) && (
                <Button size="xs" variant="outline" onClick={handleTestWebhook} disabled={testingWebhook} className="h-8">
                  <BellRing className="w-3 h-3 mr-1" /> {t('settingsTestWebhook')}
                </Button>
              )}
              <Button size="xs" variant="outline" onClick={handleCleanup} className="h-8">
                <Trash2 className="w-3 h-3 mr-1" /> {t('settingsRunCleanup')}
              </Button>
              <Button size="xs" onClick={handleSave} disabled={saving || !loaded} className="h-8 cursor-pointer">
                <Save className="w-3 h-3 mr-1" /> {t('btnSave')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
