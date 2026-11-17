import { useState, useEffect } from 'react'
import { HardDrive, Settings2, Trash2, ChevronDown, ChevronUp, Save } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { getSettings, saveSettings, runStorageCleanup } from '@/lib/api'
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
  const [proxyUrl, setProxyUrl] = useState('')
  const [saving, setSaving] = useState(false)

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
      }
      if (proxyUrl.trim()) patch.proxyUrl = proxyUrl.trim()
      const res = await saveSettings(patch)
      setSettings(res.settings)
      setDisk(res.disk)
      setProxyUrl('')
      toast.success(t('settingsSaved'))
    } catch (e: unknown) {
      toast.error(t('settingsSaveFail'), { description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
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

            <div className="flex flex-wrap items-center gap-3 pt-0.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={autoRetryRecord} onCheckedChange={(v) => setAutoRetryRecord(!!v)} className="w-3.5 h-3.5" />
                <span>{t('settingsRetry')}</span>
              </label>
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
