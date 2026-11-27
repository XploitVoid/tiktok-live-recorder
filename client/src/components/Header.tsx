import { Link, useLocation } from 'react-router-dom'
import { Radio, LayoutGrid, Activity, Disc, Globe } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useI18n, SUPPORTED_LANGS } from '@/lib/i18n'
import { AccountSwitcher } from './AccountSwitcher'

const NAV_ITEMS = [
  { to: '/', labelKey: 'navRecorder', icon: Disc },
  { to: '/grid', labelKey: 'navGrid', icon: LayoutGrid },
  { to: '/dashboard', labelKey: 'navDashboard', icon: Activity },
] as const

export function Header() {
  const { lang, setLang, t } = useI18n()
  const { pathname } = useLocation()

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-border/80">
      <div className="flex items-center gap-5 flex-wrap">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors shrink-0">
            <Radio className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight leading-tight">
              Live Stream Recorder
            </div>
            <div className="text-[11px] text-muted-foreground font-mono leading-tight">
              {t('localTag')}
            </div>
          </div>
        </Link>

        <nav
          aria-label="Primary navigation"
          className="inline-flex items-center rounded-lg bg-secondary/70 border border-border/70 p-0.5 gap-0.5"
        >
          {NAV_ITEMS.map(({ to, labelKey, icon: Icon }) => {
            const active = pathname === to
            return (
              <Link
                key={to}
                to={to}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-background text-foreground shadow-xs border border-border/80'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t(labelKey)}</span>
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <AccountSwitcher />

        <Select value={lang} onValueChange={(v) => setLang(v as typeof lang)}>
          <SelectTrigger className="w-auto min-w-[104px] h-8 text-xs bg-secondary/70 border-border/80" size="sm">
            <Globe className="w-3.5 h-3.5 text-muted-foreground mr-1.5" />
            <span>{SUPPORTED_LANGS.find((l) => l.code === lang)?.label ?? lang}</span>
          </SelectTrigger>
          <SelectContent align="end">
            {SUPPORTED_LANGS.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </header>
  )
}
