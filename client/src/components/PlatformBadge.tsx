import { Badge } from '@/components/ui/badge'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { Platform } from '@/lib/types'

export function PlatformBadge({
  platform = 'tiktok',
  className,
}: {
  platform?: Platform
  className?: string
}) {
  const { t } = useI18n()
  const isTwitch = platform === 'twitch'
  return (
    <Badge
      variant="secondary"
      className={cn(
        'text-[10px] px-1.5 py-0 font-medium shrink-0',
        isTwitch
          ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30'
          : 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
        className,
      )}
    >
      {isTwitch ? t('platformTwitch') : t('platformTikTok')}
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
  const btnCls = size === 'sm' ? 'px-2.5 text-xs' : 'px-3 text-xs'

  return (
    <div
      role="group"
      aria-label="Platform"
      className={cn(
        'inline-flex items-center rounded-lg border border-border bg-secondary/70 p-0.5 shrink-0',
        heightCls,
      )}
    >
      <button
        type="button"
        onClick={() => onChange('tiktok')}
        aria-pressed={value === 'tiktok'}
        className={cn(
          'h-full rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap',
          btnCls,
          value === 'tiktok'
            ? 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/40 shadow-xs'
            : 'text-muted-foreground hover:text-foreground border border-transparent',
        )}
      >
        {t('platformTikTok')}
      </button>
      <button
        type="button"
        onClick={() => onChange('twitch')}
        aria-pressed={value === 'twitch'}
        className={cn(
          'h-full rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap',
          btnCls,
          value === 'twitch'
            ? 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/40 shadow-xs'
            : 'text-muted-foreground hover:text-foreground border border-transparent',
        )}
      >
        {t('platformTwitch')}
      </button>
    </div>
  )
}
