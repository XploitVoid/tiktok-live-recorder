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

const ALL_PLATFORMS: Platform[] = ['tiktok', 'twitch', 'youtube', 'kick', 'soop']

const PLATFORM_LABEL_KEYS: Record<Platform, string> = {
  tiktok: 'platformTikTok',
  twitch: 'platformTwitch',
  youtube: 'platformYouTube',
  kick: 'platformKick',
  soop: 'platformSoop',
}

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
  const [stealthPending, setStealthPending] = useState(false)
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set())
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set())
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

  const resetDraft = useCallback(() => {
    setAdding(false)
    setLabel('')
    setSessionId('')
    setTtTargetIdc('')
    setAccPlatform('tiktok')
  }, [])

  const closePopover = useCallback(() => {
    setOpen(false)
    resetDraft()
  }, [resetDraft])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePopover()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover()
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, closePopover])

  const handleToggleStealth = async () => {
    if (!data || stealthPending) return
    const next = !data.stealth
    setStealthPending(true)
    try {
      await toggleStealth(next)
      await refresh()
      toast(next ? t('accStealthEnabled') : t('accStealthDisabled'), {
        description: next ? t('accStealthToastNote') : undefined,
      })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStealthPending(false)
    }
  }

  const handleTogglePlatformStealth = async (platform: Platform) => {
    if (!data || stealthPending) return
    const platLabel = t(PLATFORM_LABEL_KEYS[platform])
    setStealthPending(true)
    try {
      if (data.stealth) {
        const nextPlatforms: Partial<Record<Platform, boolean>> = {}
        for (const plat of ALL_PLATFORMS) {
          nextPlatforms[plat] = plat !== platform
        }
        await toggleStealth(false, undefined, nextPlatforms)
        await refresh()
        toast(t('accStealthPlatformDisabled').replace('{platform}', platLabel))
      } else {
        const next = !data.stealthPlatforms?.[platform]
        await toggleStealth(next, platform)
        await refresh()
        toast(
          (next ? t('accStealthPlatformEnabled') : t('accStealthPlatformDisabled')).replace(
            '{platform}',
            platLabel,
          ),
        )
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setStealthPending(false)
    }
  }

  const handleSwitch = async (id?: string, platform?: Platform, closeOnSuccess = true) => {
    try {
      await switchAccount(id, platform)
      await refresh()
      toast.success(id ? t('accSwitched') : t('accAnonSwitched'))
      if (closeOnSuccess) closePopover()
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
    setDeletingIds((prev) => new Set(prev).add(id))
    try {
      await deleteAccount(id)
      await refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleCheckOne = async (id: string) => {
    setCheckingIds((prev) => new Set(prev).add(id))
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
      setCheckingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
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

  const activeIds = new Set<string>()
  if (data?.active.id) activeIds.add(data.active.id)
  if (data?.active.byPlatform) {
    for (const val of Object.values(data.active.byPlatform)) {
      if (val) activeIds.add(val)
    }
  }
  const activeAccounts = data?.accounts.filter((a) => activeIds.has(a.id)) || []
  const isStealth = data?.stealth ?? false
  const stealthPlatforms = data?.stealthPlatforms
  const partialCount = ALL_PLATFORMS.filter((p) => Boolean(stealthPlatforms?.[p])).length
  const anyStealth = isStealth || partialCount > 0
  const hasSessionByPlatform = data?.active.hasSessionByPlatform
  const effectiveAnonByPlatform = data?.effectiveAnonByPlatform
  const hasSession = activeAccounts.length > 0 || (data?.active.hasSession ?? false)
  const effectiveActiveAccounts = activeAccounts.filter((a) => {
    const plat = a.platform || 'tiktok'
    return !isStealth && !stealthPlatforms?.[plat]
  })
  const primaryEffectiveAcc =
    effectiveActiveAccounts.find((a) => (a.platform || 'tiktok') === 'tiktok') || effectiveActiveAccounts[0]
  const effectiveHasSession = isStealth
    ? false
    : hasSessionByPlatform
      ? ALL_PLATFORMS.some((p) => hasSessionByPlatform[p] && !stealthPlatforms?.[p])
      : hasSession
  const activeExpired = effectiveActiveAccounts.some((a) => a.health?.status === 'expired')
  const expiredAcc = effectiveActiveAccounts.find((a) => a.health?.status === 'expired')
  const stealthButtonLabel = isStealth
    ? `${t('stealthOn')} (${ALL_PLATFORMS.length}/${ALL_PLATFORMS.length})`
    : partialCount > 0
      ? t('stealthPartial').replace('{count}', String(partialCount))
      : t('stealthOff')

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={handleToggleStealth}
        disabled={stealthPending}
        title={isStealth ? t('stealthOnDesc') : t('stealthOffDesc')}
        className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer disabled:opacity-60 ${
          anyStealth
            ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/20'
            : 'bg-secondary/70 border-border/80 text-muted-foreground hover:text-foreground'
        }`}
      >
        {anyStealth ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        <span>{stealthButtonLabel}</span>
      </button>

      <div className="relative" ref={panelRef}>
        <button
          type="button"
          onClick={() => (open ? closePopover() : setOpen(true))}
          aria-expanded={open}
          title={activeExpired ? (expiredAcc?.health?.reason || t('accHealthExpired')) : undefined}
          className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
            activeExpired
              ? 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/15'
              : effectiveHasSession
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15'
                : 'bg-secondary/70 border-border/80 text-muted-foreground hover:text-foreground'
          }`}
        >
          {effectiveHasSession ? (
            <UserCheck className={`w-3.5 h-3.5 ${activeExpired ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400'}`} />
          ) : (
            <User className="w-3.5 h-3.5" />
          )}
          <span className="max-w-[130px] truncate">
            {!effectiveHasSession
              ? t('accAnonymous')
              : primaryEffectiveAcc
                ? `${primaryEffectiveAcc.label}${effectiveActiveAccounts.length > 1 ? ` +${effectiveActiveAccounts.length - 1}` : ''}`
                : t('accSession')}
          </span>
          {activeExpired && (
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
          )}
        </button>

        {open && (
          <div className="fixed right-4 top-16 sm:absolute sm:right-0 sm:top-full sm:mt-1.5 w-80 sm:w-[340px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-lg bg-popover border border-border shadow-xl z-50 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">{t('accTitle')}</span>
              <div className="flex items-center gap-1.5">
                {anyStealth && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                    <ShieldAlert className="w-3 h-3" /> {stealthButtonLabel}
                  </span>
                )}
                {!!data?.accounts.length && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={checkingAll || checkingIds.size > 0}
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

            <div className="space-y-1 max-h-40 overflow-y-auto">
              <button
                type="button"
                onClick={() => handleSwitch(undefined)}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-md text-xs transition-colors cursor-pointer text-left ${
                  !hasSession
                    ? 'bg-secondary font-medium text-foreground'
                    : 'hover:bg-secondary/60 text-muted-foreground'
                }`}
              >
                <div className="flex items-center gap-2">
                  <User className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('accAnonymousAll')}</span>
                </div>
                {!hasSession && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </button>

              {data?.accounts.map((acc: AccountInfo) => {
                const plat = acc.platform || 'tiktok'
                const active = data.active.byPlatform
                  ? data.active.byPlatform[plat] === acc.id
                  : plat === 'tiktok' && data.active.id === acc.id
                const isCheckingThis = checkingIds.has(acc.id)
                const isDeletingThis = deletingIds.has(acc.id)
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
                      onClick={() => handleSwitch(active ? undefined : acc.id, plat)}
                      title={active ? t('accClickToDeactivate') : undefined}
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
                        disabled={checkingAll || isCheckingThis || isDeletingThis}
                        onClick={() => handleCheckOne(acc.id)}
                        title={t('accCheck')}
                        aria-label={t('accCheck')}
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      >
                        {isCheckingThis
                          ? <RefreshCw className="w-3 h-3 animate-spin" />
                          : <ShieldCheck className="w-3 h-3" />}
                      </Button>
                      <ConfirmButton
                        onConfirm={() => handleDelete(acc.id)}
                        disabled={isDeletingThis}
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

            <div className="pt-2 border-t border-border space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-foreground/90">{t('stealthPerPlatform')}</span>
                <button
                  type="button"
                  onClick={handleToggleStealth}
                  disabled={stealthPending}
                  aria-pressed={isStealth}
                  className={`inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-medium border transition-colors cursor-pointer disabled:opacity-60 ${
                    isStealth
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                      : 'bg-secondary/70 border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {isStealth ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                  <span>{t('stealthGlobalLabel')}</span>
                </button>
              </div>

              <div className="space-y-1">
                {ALL_PLATFORMS.map((plat) => {
                  const platStealth = isStealth || Boolean(stealthPlatforms?.[plat])
                  const activeIdForPlat = data?.active.byPlatform
                    ? data.active.byPlatform[plat]
                    : plat === 'tiktok'
                      ? data?.active.id
                      : null
                  const activeAccForPlat = activeIdForPlat
                    ? data?.accounts.find((a) => a.id === activeIdForPlat)
                    : undefined
                  const platHasSession = hasSessionByPlatform
                    ? Boolean(hasSessionByPlatform[plat])
                    : Boolean(activeAccForPlat) || (plat === 'tiktok' && Boolean(data?.active.hasSession))
                  const platEffectiveAnon = effectiveAnonByPlatform
                    ? Boolean(effectiveAnonByPlatform[plat])
                    : platStealth || !platHasSession

                  return (
                    <div
                      key={plat}
                      className="flex items-center justify-between gap-1.5 px-1.5 py-1 rounded-md bg-secondary/35 text-[11px]"
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <PlatformBadge platform={plat} className="text-[10px] px-1.5 py-0" />
                        {platStealth ? (
                          <span className="text-amber-600 dark:text-amber-300 font-medium truncate">
                            {t('modeStealth')}
                          </span>
                        ) : platEffectiveAnon || !platHasSession ? (
                          <span className="text-muted-foreground truncate">{t('modeAnon')}</span>
                        ) : (
                          <span className="text-emerald-600 dark:text-emerald-300 font-medium truncate">
                            {activeAccForPlat ? activeAccForPlat.label : t('modeAuth')}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {!platStealth && platHasSession && (
                          <button
                            type="button"
                            onClick={() => handleSwitch(undefined, plat, false)}
                            title={t('accClickToDeactivate')}
                            aria-label={t('accClickToDeactivate')}
                            className="inline-flex items-center justify-center h-5 w-5 rounded border border-border/70 bg-background/60 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
                          >
                            <User className="w-2.5 h-2.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleTogglePlatformStealth(plat)}
                          disabled={stealthPending}
                          aria-pressed={platStealth}
                          title={platStealth ? t('stealthTurnOffPlatform') : t('stealthTurnOnPlatform')}
                          aria-label={platStealth ? t('stealthTurnOffPlatform') : t('stealthTurnOnPlatform')}
                          className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[10px] font-medium border transition-colors cursor-pointer disabled:opacity-60 ${
                            platStealth
                              ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                              : 'bg-background/60 border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {platStealth ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                          <span>{platStealth ? t('stealthPillOn') : t('stealthPillOff')}</span>
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
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
                          : accPlatform === 'soop'
                            ? t('accTokenPlaceholderSoop')
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
                    onClick={resetDraft}
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
              {effectiveHasSession ? t('accHintAuth') : t('accHintAnon')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
