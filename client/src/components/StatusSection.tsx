import { useState } from 'react'
import { Users, Radio, CircleOff, Tv } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { safeImageUrl } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import type { CheckResult } from '@/lib/types'

interface Props {
  data: CheckResult
}

export function StatusSection({ data }: Props) {
  const { t } = useI18n()
  const owner = data.owner || {}
  const coverUrl = safeImageUrl(data.coverUrl)
  const [imgError, setImgError] = useState(false)

  return (
    <Card className="border-border/80">
      <CardContent className="pt-5">
        <div className="flex items-center gap-4 flex-wrap sm:flex-nowrap">
          {coverUrl && !imgError ? (
            <img
              src={coverUrl}
              referrerPolicy="no-referrer"
              onError={() => setImgError(true)}
              className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg object-cover border border-border/70 shrink-0"
              alt=""
            />
          ) : (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg bg-secondary/70 border border-border/70 flex items-center justify-center text-muted-foreground shrink-0">
              <Tv className="w-6 h-6" />
            </div>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap mb-1.5">
              {data.live ? (
                <Badge className="bg-primary text-primary-foreground font-semibold px-2 py-0.5 text-[11px] gap-1.5">
                  <Radio className="w-3 h-3" />
                  <span>{t('liveBadge')}</span>
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-muted-foreground font-medium px-2 py-0.5 text-[11px] gap-1.5">
                  <CircleOff className="w-3 h-3" />
                  <span>{t('offline')}</span>
                </Badge>
              )}

              <span className="font-semibold text-base truncate">
                {owner.nickname || data.username}
              </span>
              <span className="text-muted-foreground text-xs font-mono">
                @{data.username}
              </span>
            </div>

            <div className="text-sm text-muted-foreground line-clamp-2">
              {data.title || (data.live ? t('noTitle') : t('offline'))}
            </div>

            {data.live && data.viewerCount != null && (
              <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5 tabular-nums">
                <Users className="w-3.5 h-3.5" />
                <span>{Number(data.viewerCount).toLocaleString()} {t('viewersLabel')}</span>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function StatusSkeleton() {
  return (
    <Card className="border-border/80">
      <CardContent className="pt-5">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg bg-secondary/80 animate-pulse shrink-0" />
          <div className="flex-1 space-y-2.5">
            <div className="h-5 w-48 rounded bg-secondary/80 animate-pulse" />
            <div className="h-4 w-72 max-w-full rounded bg-secondary/80 animate-pulse" />
            <div className="h-3 w-24 rounded bg-secondary/80 animate-pulse" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
