import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/lib/i18n'
import { cn, normalizePlatform } from '@/lib/utils'
import type { Platform } from '@/lib/types'

const BADGE_STYLES: Record<Platform, string> = {
  tiktok: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  twitch: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
  youtube: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  kick: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  soop: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
}

const ACTIVE_SWITCH_STYLES: Record<Platform, string> = {
  tiktok: 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/40 shadow-xs',
  twitch: 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/40 shadow-xs',
  youtube: 'bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/40 shadow-xs',
  kick: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 shadow-xs',
  soop: 'bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/40 shadow-xs',
}

export function PlatformBadge({
  platform = 'tiktok',
  className,
}: {
  platform?: Platform
  className?: string
}) {
  const { t } = useI18n()
  const plat = normalizePlatform(platform)
  const labelMap: Record<Platform, string> = {
    tiktok: t('platformTikTok'),
    twitch: t('platformTwitch'),
    youtube: t('platformYouTube'),
    kick: t('platformKick'),
    soop: t('platformSoop'),
  }
  return (
    <Badge
      variant="secondary"
      className={cn('text-[10px] px-1.5 py-0 font-medium shrink-0', BADGE_STYLES[plat], className)}
    >
      {labelMap[plat]}
    </Badge>
  )
}

export function PlatformSwitch({
  value,
  onChange,
  size = 'md',
}: {
  value: Platform
  onChange: (platform: Platform) => void
  size?: 'sm' | 'md'
}) {
  const { t } = useI18n()
  const containerCls = size === 'sm' ? 'min-h-8' : 'min-h-10'
  const btnCls = size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-xs'
  const options: { id: Platform; label: string }[] = [
    { id: 'tiktok', label: t('platformTikTok') },
    { id: 'twitch', label: t('platformTwitch') },
    { id: 'youtube', label: t('platformYouTube') },
    { id: 'kick', label: t('platformKick') },
    { id: 'soop', label: t('platformSoop') },
  ]

  return (
    <div
      role="group"
      aria-label="Platform"
      className={cn(
        'inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-secondary/70 p-0.5 max-w-full',
        containerCls,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          aria-pressed={value === opt.id}
          className={cn(
            'rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap',
            btnCls,
            value === opt.id
              ? ACTIVE_SWITCH_STYLES[opt.id]
              : 'text-muted-foreground hover:text-foreground border border-transparent',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
