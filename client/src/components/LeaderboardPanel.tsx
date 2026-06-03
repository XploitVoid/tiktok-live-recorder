import { useState, useEffect, useCallback } from 'react'
import { Trophy, Gem, MessageSquare, Heart, UserPlus, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { getLeaderboard } from '@/lib/api'
import type { LeaderboardData, LeaderboardUser } from '@/lib/types'
import { Avatar } from '@/components/Avatar'

interface Props {
  recording: string
  hasEvents: boolean
}

type TabKey = 'overall' | 'gifters' | 'chatters' | 'likers' | 'followers'

const TABS: { key: TabKey; icon: typeof Trophy; field: keyof Pick<LeaderboardData, 'overall' | 'topGifters' | 'topChatters' | 'topLikers' | 'topFollowers'>; statKey: keyof LeaderboardUser }[] = [
  { key: 'overall',   icon: Trophy,        field: 'overall',      statKey: 'score' },
  { key: 'gifters',   icon: Gem,           field: 'topGifters',   statKey: 'diamonds' },
  { key: 'chatters',  icon: MessageSquare, field: 'topChatters',  statKey: 'chats' },
  { key: 'likers',    icon: Heart,         field: 'topLikers',    statKey: 'likes' },
  { key: 'followers', icon: UserPlus,      field: 'topFollowers', statKey: 'follows' },
]

const TAB_LABELS: Record<TabKey, string> = {
  overall:   'lbOverall',
  gifters:   'lbGifters',
  chatters:  'lbChatters',
  likers:    'lbLikers',
  followers: 'lbFollowers',
}

const TAB_COLORS: Record<TabKey, string> = {
  overall:   'text-amber-400',
  gifters:   'text-pink-400',
  chatters:  'text-sky-400',
  likers:    'text-rose-400',
  followers: 'text-emerald-400',
}

export function LeaderboardPanel({ recording, hasEvents }: Props) {
  const { t } = useI18n()
  const [data, setData] = useState<LeaderboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<TabKey>('overall')

  const refresh = useCallback(async () => {
    if (!hasEvents) return
    setLoading(true)
    try {
      const d = await getLeaderboard(recording)
      setData(d)
    } catch (e) {
      console.error('getLeaderboard:', e)
    } finally {
      setLoading(false)
    }
  }, [recording, hasEvents])

  useEffect(() => { refresh() }, [refresh])

  if (!hasEvents) {
    return (
      <Card>
        <CardContent className="pt-5">
          <div className="flex items-center gap-2 mb-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold">{t('lbTitle')}</h2>
          </div>
          <p className="text-xs text-muted-foreground">{t('lbNoEvents')}</p>
        </CardContent>
      </Card>
    )
  }

  const currentTab = TABS.find((x) => x.key === tab)!
  const list: LeaderboardUser[] = data ? data[currentTab.field] : []

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold">{t('lbTitle')}</h2>
            {data && (
              <span className="text-xs text-muted-foreground">
                · {data.totals.uniqueUsers.toLocaleString()} {t('lbUniqueUsers')}
              </span>
            )}
          </div>
          <Button variant="ghost" size="xs" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {t('btnRefresh')}
          </Button>
        </div>

        {/* Stream-wide totals */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat icon="💎" label={t('lbDiamonds')} value={data.totals.diamonds.toLocaleString()} color="text-pink-300" />
            <Stat icon="🎁" label={t('lbGiftsTotal')} value={data.totals.gifts.toLocaleString()} color="text-amber-300" />
            <Stat icon="💬" label={t('lbChatsTotal')} value={data.totals.chats.toLocaleString()} color="text-sky-300" />
            <Stat icon="❤️" label={t('lbLikesTotal')} value={data.totals.likes.toLocaleString()} color="text-rose-300" />
          </div>
        )}

        {/* Top gifts breakdown */}
        {data && data.giftSummary.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              {t('lbTopGifts')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.giftSummary.map((g) => (
                <span
                  key={g.name}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-200 border border-amber-500/20"
                  title={`${g.diamonds.toLocaleString()} 💎`}
                >
                  {g.name} ×{g.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 border-b border-border pb-1">
          {TABS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                tab === key
                  ? `bg-secondary ${TAB_COLORS[key]} font-semibold`
                  : 'text-muted-foreground hover:bg-secondary/60'
              }`}
            >
              <Icon className="w-3 h-3" />
              {t(TAB_LABELS[key])}
            </button>
          ))}
        </div>

        {/* List */}
        <div className="space-y-1 max-h-[320px] overflow-y-auto">
          {loading && !data ? (
            <p className="text-xs text-muted-foreground">— loading —</p>
          ) : list.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('lbEmpty')}</p>
          ) : (
            list.map((u, idx) => (
              <UserRow key={u.uniqueId || u.nickname} rank={idx + 1} user={u} statKey={currentTab.statKey} tab={tab} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({ icon, label, value, color }: { icon: string; label: string; value: string; color: string }) {
  return (
    <div className="bg-secondary/60 rounded-lg px-2 py-1.5 border border-border">
      <div className="flex items-center gap-1">
        <span>{icon}</span>
        <span className={`font-mono font-semibold ${color}`}>{value}</span>
      </div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  )
}

function UserRow({
  rank,
  user,
  statKey,
  tab,
}: {
  rank: number
  user: LeaderboardUser
  statKey: keyof LeaderboardUser
  tab: TabKey
}) {
  const { t } = useI18n()
  const primary = Number(user[statKey] || 0)
  const primaryLabel = primaryUnit(statKey)
  const primaryColor = TAB_COLORS[tab]

  // Medal coloring for top-3
  const medalBg =
    rank === 1 ? 'bg-amber-500/15 border-amber-500/40' :
    rank === 2 ? 'bg-slate-400/10 border-slate-400/30' :
    rank === 3 ? 'bg-orange-700/10 border-orange-700/30' :
    'bg-secondary/40 border-border'
  const rankIcon =
    rank === 1 ? '🥇' :
    rank === 2 ? '🥈' :
    rank === 3 ? '🥉' :
    `#${rank}`

  return (
    <div className={`flex items-center gap-2 rounded-lg px-2 py-1.5 border ${medalBg}`}>
      <span className="w-7 text-center text-xs font-mono text-foreground/70">{rankIcon}</span>
      <Avatar url={user.avatar || undefined} name={user.nickname} size={28} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate text-foreground/90">{user.nickname}</div>
        <div className="text-[10px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-0">
          {user.diamonds > 0 && <span>💎 {user.diamonds.toLocaleString()}</span>}
          {user.chats > 0 && <span>💬 {user.chats}</span>}
          {user.gifts > 0 && <span>🎁 {user.gifts}</span>}
          {user.likes > 0 && <span>❤️ {user.likes}</span>}
          {user.follows > 0 && <span>➕ {user.follows}</span>}
          {user.topGiftName && (
            <span className="text-amber-300/80" title={`${user.topGiftName.count}×`}>
              ★ {user.topGiftName.name}
            </span>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-sm font-semibold font-mono ${primaryColor}`}>
          {primary.toLocaleString()}
        </div>
        <div className="text-[10px] text-muted-foreground uppercase">{t(primaryLabel)}</div>
      </div>
    </div>
  )
}

// Map the active sort field to a translation key for the right-side stat label.
function primaryUnit(key: keyof LeaderboardUser): string {
  switch (key) {
    case 'diamonds': return 'lbDiamonds'
    case 'chats':    return 'lbChatsTotal'
    case 'likes':    return 'lbLikesTotal'
    case 'follows':  return 'lbFollowers'
    case 'score':
    default:         return 'lbScore'
  }
}
