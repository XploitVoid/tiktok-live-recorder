import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/lib/i18n'
import { cn, normalizePlatform } from '@/lib/utils'
import type { Platform } from '@/lib/types'

const BADGE_STYLES: Record<Platform, string> = {
  tiktok: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  twitch: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
  youtube: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  kick: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
}

const ACTIVE_SWITCH_STYLES: Record<Platform, string> = {
  tiktok: 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/40 shadow-xs',
  twitch: 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/40 shadow-xs',
  youtube: 'bg-red-500/20 text-red-700 dark:text-red-300 border border-red-500/40 shadow-xs',
  kick: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 shadow-xs',
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
  const label =
    plat === 'twitch'
      ? t('platformTwitch')
      : plat === 'youtube'
        ? t('platformYouTube')
        : plat === 'kick'
          ? t('platformKick')
          : t('platformTikTok')
  return (
    <Badge
      variant="secondary"
      className={cn('text-[10px] px-1.5 py-0 font-medium shrink-0', BADGE_STYLES[plat], className)}
    >
      {label}
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
  const heightCls = size === 'sm' ? 'h-8' : 'h-10'
  const btnCls = size === 'sm' ? 'px-2 text-xs' : 'px-2.5 text-xs'
  const options: { id: Platform; label: string }[] = [
    { id: 'tiktok', label: t('platformTikTok') },
    { id: 'twitch', label: t('platformTwitch') },
    { id: 'youtube', label: t('platformYouTube') },
    { id: 'kick', label: t('platformKick') },
  ]

  return (
    <div
      role="group"
      aria-label="Platform"
      className={cn(
        'inline-flex items-center rounded-lg border border-border bg-secondary/70 p-0.5 shrink-0',
        heightCls,
      )}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          aria-pressed={value === opt.id}
          className={cn(
            'h-full rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap',
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
