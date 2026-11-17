import { useState, useEffect, useCallback, useRef } from 'react'
import { User, UserCheck, Plus, Trash2, Check, ShieldAlert, EyeOff, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/ConfirmButton'
import { getAccounts, addAccount, deleteAccount, switchAccount, toggleStealth } from '@/lib/api'
import type { AccountInfo, AccountsResponse } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { toast } from 'sonner'

export function AccountSwitcher() {
  const { t } = useI18n()
  const [data, setData] = useState<AccountsResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [ttTargetIdc, setTtTargetIdc] = useState('')
  const [saving, setSaving] = useState(false)
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
      await addAccount(label.trim() || 'Account', sessionId.trim(), ttTargetIdc.trim() || undefined)
      setLabel('')
      setSessionId('')
      setTtTargetIdc('')
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

  const activeAcc = data?.accounts.find((a) => a.id === data.active.id)
  const isStealth = data?.stealth ?? false
  const hasSession = data?.active.hasSession ?? false

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
          className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
            hasSession && !isStealth
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15'
              : 'bg-secondary/70 border-border/80 text-muted-foreground hover:text-foreground'
          }`}
        >
          {hasSession && !isStealth ? (
            <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
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
        </button>

        {open && (
          <div className="fixed right-4 top-16 sm:absolute sm:right-0 sm:top-full sm:mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-lg bg-popover border border-border shadow-xl z-50 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">{t('accTitle')}</span>
              {isStealth && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                  <ShieldAlert className="w-3 h-3" /> {t('stealthOn')}
                </span>
              )}
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
                const active = data.active.id === acc.id
                return (
                  <div
                    key={acc.id}
                    className={`flex items-center justify-between gap-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
                      active
                        ? 'bg-secondary font-medium text-foreground'
                        : 'hover:bg-secondary/60 text-muted-foreground'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSwitch(acc.id)}
                      className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                    >
                      <UserCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span className="truncate">{acc.label}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0 tabular-nums">
                        {acc.sessionPreview}
                      </span>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      {active && <Check className="w-3.5 h-3.5 text-emerald-400" />}
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
                <Input
                  placeholder={t('accNamePlaceholder')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="h-8 text-xs"
                />
                <Input
                  type="password"
                  placeholder={t('accSessionPlaceholder')}
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
                <Input
                  placeholder={t('accTargetIdcPlaceholder')}
                  value={ttTargetIdc}
                  onChange={(e) => setTtTargetIdc(e.target.value)}
                  className="h-8 text-xs font-mono"
                />
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
                    onClick={() => { setAdding(false); setTtTargetIdc('') }}
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
