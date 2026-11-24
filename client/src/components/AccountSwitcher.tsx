import { useState, useEffect, useCallback, useRef } from 'react'
import { User, UserCheck, Plus, Trash2, Check, ShieldAlert, EyeOff, Eye, AlertTriangle, RefreshCw, ShieldCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/ConfirmButton'
import { PlatformBadge, PlatformSwitch } from '@/components/PlatformBadge'
import { getAccounts, addAccount, deleteAccount, switchAccount, toggleStealth, checkAccountHealth, checkAllAccountsHealth } from '@/lib/api'
import type { AccountInfo, AccountsResponse } from '@/lib/api'
import type { Platform } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { toast } from 'sonner'

export function AccountSwitcher() {
  const { t } = useI18n()
  const [data, setData] = useState<AccountsResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [accPlatform, setAccPlatform] = useState<Platform>('tiktok')
  const [label, setLabel] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [ttTargetIdc, setTtTargetIdc] = useState('')
  const [saving, setSaving] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await getAccounts()
      setData(res)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    let active = true
    getAccounts()
      .then((res) => { if (active) setData(res) })
      .catch(() => { /* ignore */ })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const handleToggleStealth = async () => {
    if (!data) return
    const next = !data.stealth
    try {
      await toggleStealth(next)
      await refresh()
      toast(next ? t('accStealthEnabled') : t('accStealthDisabled'), {
        description: next ? t('accStealthToastNote') : undefined,
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleSwitch = async (id?: string) => {
    try {
      await switchAccount(id)
      await refresh()
      toast.success(id ? t('accSwitched') : t('accAnonSwitched'))
      setOpen(false)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleAdd = async () => {
    if (!sessionId.trim()) {
      toast.error(t('accEnterSession'))
      return
    }
    setSaving(true)
    try {
      await addAccount(
        label.trim() || 'Account',
        sessionId.trim(),
        accPlatform === 'tiktok' ? (ttTargetIdc.trim() || undefined) : undefined,
        accPlatform,
      )
      setLabel('')
      setSessionId('')
      setTtTargetIdc('')
      setAccPlatform('tiktok')
      setAdding(false)
      await refresh()
      toast.success(t('accSaved'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteAccount(id)
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleCheckOne = async (id: string) => {
    setCheckingId(id)
    try {
      const res = await checkAccountHealth(id)
      await refresh()
      const statusLabel =
        res.health.status === 'valid'
          ? t('accHealthValid')
          : res.health.status === 'expired'
            ? t('accHealthExpired')
            : t('accHealthUnknown')
      const detail = res.health.username ? `@${res.health.username}` : res.health.reason || undefined
      toast(t('accCheckDone'), {
        description: `${statusLabel}${detail ? ` · ${detail}` : ''}`,
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCheckingId(null)
    }
  }

  const handleCheckAll = async () => {
    setCheckingAll(true)
    try {
      const res = await checkAllAccountsHealth()
      await refresh()
      const values = Object.values(res.results || {})
      const validCount = values.filter((h) => h.status === 'valid').length
      const expiredCount = values.filter((h) => h.status === 'expired').length
      toast.success(t('accCheckDone'), {
        description: `${t('accHealthValid')}: ${validCount}, ${t('accHealthExpired')}: ${expiredCount}`,
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setCheckingAll(false)
    }
  }

  const activeAcc = data?.accounts.find((a) => a.id === data.active.id)
  const isStealth = data?.stealth ?? false
  const hasSession = data?.active.hasSession ?? false
  const activeExpired = !isStealth && activeAcc?.health?.status === 'expired'

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={handleToggleStealth}
        title={isStealth ? t('stealthOnDesc') : t('stealthOffDesc')}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
          isStealth
            ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/20'
            : 'bg-secondary/70 border-border/80 text-muted-foreground hover:text-foreground'
        }`}
      >
        {isStealth ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        <span>{isStealth ? t('stealthOn') : t('stealthOff')}</span>
      </button>

      <div className="relative" ref={panelRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={activeExpired ? (activeAcc?.health?.reason || t('accHealthExpired')) : undefined}
          className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
            activeExpired
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/15'
              : hasSession && !isStealth
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15'
                : 'bg-secondary/70 border-border/80 text-muted-foreground hover:text-foreground'
          }`}
        >
          {hasSession && !isStealth ? (
            <UserCheck className={`w-3.5 h-3.5 ${activeExpired ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400'}`} />
          ) : (
            <User className="w-3.5 h-3.5" />
          )}
          <span className="max-w-[110px] truncate">
            {isStealth
              ? t('accAnonymous')
              : activeAcc
                ? activeAcc.label
                : hasSession
                  ? 'Session'
                  : t('accAnonymous')}
          </span>
          {activeExpired && (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
          )}
        </button>

        {open && (
          <div className="fixed right-4 top-16 sm:absolute sm:right-0 sm:top-full sm:mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-lg bg-popover border border-border shadow-xl z-50 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">{t('accTitle')}</span>
              <div className="flex items-center gap-1.5">
                {isStealth && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-400">
                    <ShieldAlert className="w-3 h-3" /> {t('stealthOn')}
                  </span>
                )}
                {!!data?.accounts.length && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={checkingAll || checkingId !== null}
                    onClick={handleCheckAll}
                    className="h-6 px-2 text-[11px] gap-1"
                  >
                    {checkingAll
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <ShieldCheck className="w-3 h-3" />}
                    <span>{t('accCheckAll')}</span>
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-1 max-h-48 overflow-y-auto">
              <button
                type="button"
                onClick={() => handleSwitch(undefined)}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-md text-xs transition-colors cursor-pointer text-left ${
                  !data?.active.id && !hasSession
                    ? 'bg-secondary font-medium text-foreground'
                    : 'hover:bg-secondary/60 text-muted-foreground'
                }`}
              >
                <div className="flex items-center gap-2">
                  <User className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('accAnonymous')}</span>
                </div>
                {!data?.active.id && !hasSession && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </button>

              {data?.accounts.map((acc: AccountInfo) => {
                const plat = acc.platform || 'tiktok'
                const active = plat === 'tiktok'
                  ? data.active.id === acc.id
                  : data.active.byPlatform?.[plat] === acc.id
                return (
                  <div
                    key={acc.id}
                    className={`flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors ${
                      active
                        ? 'bg-secondary font-medium text-foreground'
                        : 'hover:bg-secondary/60 text-muted-foreground'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSwitch(acc.id)}
                      className="flex-1 min-w-0 text-left cursor-pointer space-y-0.5"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <UserCheck className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
                        {plat !== 'tiktok' && <PlatformBadge platform={plat} className="text-[9px] px-1 py-0" />}
                        <span className="truncate">{acc.label}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">
                          {acc.sessionPreview}
                        </span>
                      </div>
                      {acc.health && (
                        <div className="flex items-center gap-1.5 pl-5 min-w-0">
                          {acc.health.status === 'valid' && (
                            <Badge
                              variant="secondary"
                              className="h-4 px-1.5 py-0 text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30 gap-1 max-w-full"
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 shrink-0" />
                              <span>{t('accHealthValid')}</span>
                              {acc.health.username && (
                                <span className="font-mono truncate">@{acc.health.username}</span>
                              )}
                            </Badge>
                          )}
                          {acc.health.status === 'expired' && (
                            <Badge
                              variant="destructive"
                              title={acc.health.reason || undefined}
                              className="h-4 px-1.5 py-0 text-[10px] gap-1"
                            >
                              <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                              <span>{t('accHealthExpired')}</span>
                            </Badge>
                          )}
                          {acc.health.status === 'unknown' && (
                            <Badge
                              variant="secondary"
                              title={acc.health.reason || undefined}
                              className="h-4 px-1.5 py-0 text-[10px] text-muted-foreground"
                            >
                              {t('accHealthUnknown')}
                            </Badge>
                          )}
                        </div>
                      )}
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {active && <Check className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={checkingAll || checkingId === acc.id}
                        onClick={() => handleCheckOne(acc.id)}
                        title={t('accCheck')}
                        aria-label={t('accCheck')}
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      >
                        {checkingId === acc.id
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : <ShieldCheck className="w-3 h-3" />}
                      </Button>
                      <ConfirmButton
                        onConfirm={() => handleDelete(acc.id)}
                        confirmLabel={t('confirm')}
                        cancelLabel={t('cancel')}
                        title={t('accDelete')}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </ConfirmButton>
                    </div>
                  </div>
                )
              })}
            </div>

            {adding ? (
              <div className="space-y-2 pt-2 border-t border-border">
                <PlatformSwitch value={accPlatform} onChange={setAccPlatform} size="sm" />
                <Input
                  placeholder={t('accNamePlaceholder')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="h-8 text-xs"
                />
                <Input
                  type="password"
                  placeholder={
                    accPlatform === 'twitch'
                      ? t('accTokenPlaceholderTwitch')
                      : accPlatform === 'youtube'
                        ? t('accTokenPlaceholderYouTube')
                        : accPlatform === 'kick'
                          ? t('accTokenPlaceholderKick')
                          : t('accSessionPlaceholder')
                  }
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
                {accPlatform === 'tiktok' && (
                  <Input
                    placeholder={t('accTargetIdcPlaceholder')}
                    value={ttTargetIdc}
                    onChange={(e) => setTtTargetIdc(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                )}
                <div className="flex gap-1.5">
                  <Button
                    size="xs"
                    onClick={handleAdd}
                    disabled={saving || !sessionId.trim()}
                    className="flex-1"
                  >
                    {saving ? t('loading') : t('btnSave')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => { setAdding(false); setTtTargetIdc(''); setAccPlatform('tiktok') }}
                  >
                    {t('btnCancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-dashed border-border hover:border-foreground/30 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('accAdd')}</span>
              </button>
            )}

            <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
              {hasSession && !isStealth ? t('accHintAuth') : t('accHintAnon')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
