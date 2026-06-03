import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { CheckResult } from '@/lib/types'

interface Props {
  data: CheckResult
}

export function StatusSection({ data }: Props) {
  const owner = data.owner || {}

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      <CardContent className="pt-5">
        <div className="flex items-center gap-4">
          {data.coverUrl && (
            <img src={data.coverUrl} className="w-20 h-20 rounded-lg object-cover" alt="" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge variant={data.live ? 'destructive' : 'secondary'} className={data.live ? 'bg-red-600 text-white' : ''}>
                {data.live ? '● LIVE' : 'OFFLINE'}
              </Badge>
              <span className="font-semibold text-foreground">{owner.nickname || data.username}</span>
              {owner.verified && <span className="text-blue-400 text-xs">✔ verified</span>}
              <span className="text-muted-foreground text-sm">@{data.username}</span>
            </div>
            <div className="text-sm text-foreground/80">{data.title || ''}</div>
            <div className="text-xs text-muted-foreground mt-1 space-x-2">
              {data.live && <span>👁 {data.viewerCount?.toLocaleString() ?? '?'} viewers</span>}
              <span>followers {owner.followers?.toLocaleString() ?? '?'}</span>
              {data.startedAtUnix && (
                <span>· started {new Date(data.startedAtUnix * 1000).toLocaleString()}</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function StatusSkeleton() {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-4">
          <div className="skeleton w-20 h-20" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-3 w-1/2" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
