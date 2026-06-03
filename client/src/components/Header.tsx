import { Link, useLocation } from 'react-router-dom'
import { Monitor, Globe, ArrowLeft, Activity } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useI18n, SUPPORTED_LANGS, type LangCode } from '@/lib/i18n'
import { AccountSwitcher } from '@/components/AccountSwitcher'

export function Header() {
  const { lang, t, setLang } = useI18n()
  const location = useLocation()
  const isHome = location.pathname === '/'

  return (
    <header className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center text-lg shadow-lg shadow-pink-500/20">
          🎬
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">TikTok LIVE Tools</h1>
          <p className="text-xs text-muted-foreground">{t('localTag')}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isHome ? (
          <>
            <Link
              to="/grid"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-pink-700/40 bg-pink-700/20 hover:bg-pink-700/40 text-pink-200')}
            >
              <Monitor className="w-4 h-4 mr-1.5" />
              {t('liveGrid')}
            </Link>
            <Link
              to="/dashboard"
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-emerald-700/40 bg-emerald-700/20 hover:bg-emerald-700/40 text-emerald-200')}
            >
              <Activity className="w-4 h-4 mr-1.5" />
              {t('dashLink')}
            </Link>
          </>
        ) : (
          <Link to="/" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            {t('btnBack')}
          </Link>
        )}
        <AccountSwitcher />
        <Select value={lang} onValueChange={(v) => v && setLang(v as LangCode)}>
          <SelectTrigger
            size="sm"
            className="w-[110px] gap-1 font-semibold uppercase"
            aria-label="Language"
          >
            <Globe className="w-4 h-4 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {SUPPORTED_LANGS.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                <span className="mr-1.5">{l.flag}</span>
                <span className="font-semibold mr-1">{l.label}</span>
                <span className="text-xs text-muted-foreground">{l.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </header>
  )
}
