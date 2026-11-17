import { useState, useEffect } from 'react'
import { HardDrive, Settings2, Trash2, ChevronDown, ChevronUp, Save, BellRing } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getSettings, saveSettings, runStorageCleanup, testWebhookSettings } from '@/lib/api'
import { fmtBytes } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { AppSettings, DiskStatus } from '@/lib/types'
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
  const [stalledTimeoutSec, setStalledTimeoutSec] = useState('25')
  const [defaultAudioBitrate, setDefaultAudioBitrate] = useState('copy')
  const [proxyUrl, setProxyUrl] = useState('')
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('')
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [saving, setSaving] = useState(false)
  const [testingWebhook, setTestingWebhook] = useState(false)

  useEffect(() => {
    let active = true
    getSettings()
      .then((res) => {
        if (!active) return
        setSettings(res.settings)
        setDisk(res.disk)
        setMinFreeGb(String(res.settings.minFreeGb))
        setMaxRecordingsGb(String(res.settings.maxRecordingsGb))
        setRetentionDays(String(res.settings.retentionDays))
        setSegmentMinutes(String(res.settings.segmentMinutes))
        setAutoRetryRecord(res.settings.autoRetryRecord)
        setStalledTimeoutSec(String(res.settings.stalledTimeoutSec ?? 25))
        setDefaultAudioBitrate(res.settings.defaultAudioBitrate || 'copy')
        setTelegramChatId(res.settings.telegramChatId || '')
      })
      .catch(() => { /* ignore */ })
    return () => { active = false }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        minFreeGb: Number(minFreeGb),
        maxRecordingsGb: Number(maxRecordingsGb),
        retentionDays: Number(retentionDays),
        segmentMinutes: Number(segmentMinutes),
        autoRetryRecord,
        stalledTimeoutSec: Number(stalledTimeoutSec),
        defaultAudioBitrate: defaultAudioBitrate === 'copy' ? null : defaultAudioBitrate,
        telegramChatId: telegramChatId.trim(),
      }
      if (proxyUrl.trim()) patch.proxyUrl = proxyUrl.trim()
      if (discordWebhookUrl.trim()) patch.discordWebhookUrl = discordWebhookUrl.trim()
      if (telegramBotToken.trim()) patch.telegramBotToken = telegramBotToken.trim()
      const res = await saveSettings(patch)
      setSettings(res.settings)
      setDisk(res.disk)
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
      setSettings(res.settings)
      setDisk(res.disk)
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
      setSettings(res.settings)
      setDisk(res.disk)
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
                {disk.freeBytes != null ? ` / Free ${fmtBytes(disk.freeBytes)}` : ''}
              </span>
            )}
            {disk?.lowSpace && (
              <Badge variant="destructive" className="text-[10px]">LOW DISK</Badge>
            )}
            {settings?.hasProxy && (
              <Badge variant="secondary" className="text-[10px] border border-border">
                Proxy ON
              </Badge>
            )}
            {(settings?.hasDiscordWebhook || settings?.hasTelegram) && (
              <Badge variant="secondary" className="text-[10px] border border-border">
                Alerts ON
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="text-muted-foreground block mb-1">Min Free Disk (GB)</label>
                <Input type="number" min={0} step={0.5} value={minFreeGb} onChange={(e) => setMinFreeGb(e.target.value)} className="h-8 text-xs tabular-nums" />
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">Max Quota (GB, 0=off)</label>
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
                <Select value={defaultAudioBitrate} onValueChange={(v) => v && setDefaultAudioBitrate(v)}>
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
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={autoRetryRecord} onCheckedChange={(v) => setAutoRetryRecord(!!v)} className="w-3.5 h-3.5" />
                  <span>{t('settingsRetry')}</span>
                </label>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-2 pt-0.5">
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  value={discordWebhookUrl}
                  onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                  placeholder={settings?.hasDiscordWebhook ? `Discord: ${settings.discordWebhookPreview}` : 'Discord Webhook URL (https://discord.com/api/webhooks/...)'}
                  autoComplete="off"
                  className="h-8 text-xs flex-1 font-mono"
                />
                {settings?.hasDiscordWebhook && (
                  <Button size="xs" variant="outline" onClick={() => handleClearWebhook('discord')} disabled={saving} className="h-8">
                    {t('btnCancel')}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="password"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  placeholder={settings?.hasTelegram ? `Telegram: ${settings.telegramBotPreview}` : 'Telegram Bot Token'}
                  autoComplete="off"
                  className="h-8 text-xs flex-1 font-mono"
                />
                <Input
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="Chat ID"
                  autoComplete="off"
                  className="h-8 text-xs w-28 font-mono"
                />
                {settings?.hasTelegram && (
                  <Button size="xs" variant="outline" onClick={() => handleClearWebhook('telegram')} disabled={saving} className="h-8">
                    {t('btnCancel')}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Input
                type="password"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder={settings?.hasProxy ? `Current: ${settings.proxyPreview}` : t('settingsProxyPlaceholder')}
                autoComplete="off"
                className="h-8 text-xs flex-1 min-w-[220px] font-mono"
              />
              {settings?.hasProxy && (
                <Button size="xs" variant="outline" onClick={handleClearProxy} disabled={saving} className="h-8">
                  {t('btnCancel')} Proxy
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
              <Button size="xs" onClick={handleSave} disabled={saving} className="h-8 cursor-pointer">
                <Save className="w-3 h-3 mr-1" /> {t('btnSave')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
