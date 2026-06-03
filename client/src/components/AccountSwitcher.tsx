import { useState, useEffect, useCallback, useRef } from 'react'
import { UserCircle, Plus, Trash2, Check, LogOut, EyeOff, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/lib/i18n'
import { getAccounts, addAccount, deleteAccount, switchAccount, toggleStealth } from '@/lib/api'
import type { AccountInfo, AccountsResponse } from '@/lib/api'
import { toast } from 'sonner'

export function AccountSwitcher() {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<AccountsResponse | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [label, setLabel] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [ttTargetIdc, setTtTargetIdc] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const d = await getAccounts()
      setData(d)
    } catch (e) {
      console.error('accounts:', e)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleAdd = async () => {
    if (!sessionId.trim()) return
    try {
      const res = await addAccount(label.trim(), sessionId.trim(), ttTargetIdc.trim())
      toast.success('Account added', { description: res.label })
      setLabel('')
      setSessionId('')
      setTtTargetIdc('')
      setShowAdd(false)
      refresh()
    } catch (e: unknown) {
      toast.error('Failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleSwitch = async (id?: string) => {
    try {
      await switchAccount(id)
      toast.success(id ? 'Switched account' : 'Switched to anonymous')
      refresh()
    } catch (e: unknown) {
      toast.error('Switch failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleStealth = async () => {
    try {
      const res = await toggleStealth(!data?.stealth)
      toast.success(res.stealth ? t('stealthOn') : t('stealthOff'))
      refresh()
    } catch (e: unknown) {
      toast.error('Stealth toggle failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleDelete = async (acc: AccountInfo) => {
    if (!confirm(`Delete "${acc.label}"?`)) return
    try {
      await deleteAccount(acc.id)
      toast.info('Deleted', { description: acc.label })
      refresh()
    } catch (e: unknown) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const activeAcc = data?.accounts?.find(a => a.id === data?.active?.id)
  const activeDisplay = activeAcc?.label || (data?.active?.hasSession ? 'Default (.env)' : '')
  const isStealth = data?.stealth ?? false

  return (
    <div className="relative" ref={panelRef}>
      {/* Stealth toggle button */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleStealth}
        className={`gap-1 mr-1 ${isStealth ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : ''}`}
        title={isStealth ? t('stealthOn') : t('stealthOff')}
      >
        {isStealth ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        {t('stealthLabel')} {isStealth ? 'ON' : 'OFF'}
      </Button>

      {/* Account button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className="gap-1"
      >
        <UserCircle className="w-3.5 h-3.5" />
        <span className="max-w-[100px] truncate">
          {activeDisplay ? activeDisplay : t('accAnonymous')}
        </span>
      </Button>

      {open && (
        <div className="absolute z-50 top-full mt-1 right-0 w-80 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl shadow-black/50 overflow-hidden">
          {/* Stealth banner */}
          <div
            onClick={handleStealth}
            className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${isStealth ? 'bg-emerald-900/40 hover:bg-emerald-900/60' : 'bg-zinc-800 hover:bg-zinc-700/50'}`}
          >
            {isStealth ? <EyeOff className="w-4 h-4 text-emerald-400" /> : <Eye className="w-4 h-4 text-zinc-500" />}
            <div className="flex-1">
              <div className={`text-sm font-medium ${isStealth ? 'text-emerald-300' : 'text-zinc-300'}`}>
                {t('stealthLabel')}
              </div>
              <div className="text-[10px] text-zinc-500">
                {isStealth ? t('stealthOnDesc') : t('stealthOffDesc')}
              </div>
            </div>
            <div className={`w-8 h-4 rounded-full transition-colors relative ${isStealth ? 'bg-emerald-500' : 'bg-zinc-600'}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${isStealth ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
          </div>

          {/* Header */}
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-zinc-400 font-semibold bg-zinc-800 flex items-center gap-1.5">
            <UserCircle className="w-3 h-3" />
            {t('accTitle')}
          </div>

          {/* Anonymous option */}
          <div
            onClick={() => handleSwitch()}
            className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 cursor-pointer transition-colors border-b border-zinc-800"
          >
            <LogOut className="w-3.5 h-3.5 text-zinc-500" />
            <span className="flex-1 text-sm text-zinc-300">{t('accAnonymous')}</span>
            {!data?.active?.hasSession && <Check className="w-3.5 h-3.5 text-emerald-400" />}
          </div>

          {/* Account list */}
          {data?.accounts.map((acc) => (
            <div
              key={acc.id}
              className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 cursor-pointer group transition-colors"
            >
              <span
                className="flex-1 text-sm text-white truncate"
                onClick={() => handleSwitch(acc.id)}
              >
                {acc.label}
                <span className="text-xs text-zinc-500 ml-2">{acc.sessionPreview}</span>
              </span>
              {data?.active?.id === acc.id && data?.active?.hasSession && (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <button
                onClick={() => handleDelete(acc)}
                className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 transition-all"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}

          {/* Add form */}
          {showAdd ? (
            <div className="p-3 border-t border-zinc-800 space-y-2">
              <Input
                placeholder={t('accLabel')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="h-7 text-xs bg-zinc-800 border-zinc-700"
              />
              <Input
                placeholder="sessionid cookie *"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="h-7 text-xs bg-zinc-800 border-zinc-700 font-mono"
              />
              <Input
                placeholder="tt_target_idc (optional)"
                value={ttTargetIdc}
                onChange={(e) => setTtTargetIdc(e.target.value)}
                className="h-7 text-xs bg-zinc-800 border-zinc-700 font-mono"
              />
              <div className="flex gap-1.5">
                <Button size="xs" onClick={handleAdd} className="flex-1 bg-pink-600 hover:bg-pink-500 text-white border-0">
                  {t('btnSave')}
                </Button>
                <Button size="xs" variant="secondary" onClick={() => setShowAdd(false)}>
                  {t('btnCancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-2 border-t border-zinc-800">
              <Button
                size="xs"
                variant="ghost"
                className="w-full justify-center gap-1 text-zinc-400 hover:text-white"
                onClick={() => setShowAdd(true)}
              >
                <Plus className="w-3 h-3" /> {t('accAdd')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
