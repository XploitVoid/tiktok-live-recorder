import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Activity, Users, Gem, MessageSquare, Radio, Filter } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Header } from '@/components/Header'
import { Avatar } from '@/components/Avatar'
import { useI18n } from '@/lib/i18n'
import { usePoll } from '@/lib/usePoll'
import { fmtTime } from '@/lib/format'
import type { ChatEvent } from '@/lib/types'

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamColor {
  bg: string
  border: string
  text: string
  badge: string
}

interface StreamHealth {
  reconnectCount: number
  lastConnectedAt: number | null
  lastDisconnectedAt: number | null
  totalEventsReceived: number
  errorsCount: number
  lastError: { message: string; at: number } | null
  lastEventAt: number | null
}

interface DashboardStream {
  username: string
  viewerCount: number
  eventCount: number
  startedAt: number | null
  recentDiamonds: number
  health?: StreamHealth | null
}

interface DashboardData {
  totalStreams: number
  totalViewers: number
  totalEvents: number
  streams: DashboardStream[]
  unifiedFeed: UnifiedChatEvent[]
}

type UnifiedChatEvent = ChatEvent & { _username?: string }

// ─── Constants ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 3000
const STALE_THRESHOLD_MS = 30_000

const STREAM_COLORS: StreamColor[] = [
  { bg: 'bg-pink-500',    border: 'border-l-pink-500',    text: 'text-pink-300',    badge: 'bg-pink-500/20 text-pink-300 border-pink-500/40' },
  { bg: 'bg-sky-500',     border: 'border-l-sky-500',     text: 'text-sky-300',     badge: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  { bg: 'bg-amber-500',   border: 'border-l-amber-500',   text: 'text-amber-300',   badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { bg: 'bg-emerald-500', border: 'border-l-emerald-500', text: 'text-emerald-300', badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  { bg: 'bg-violet-500',  border: 'border-l-violet-500',  text: 'text-violet-300',  badge: 'bg-violet-500/20 text-violet-300 border-violet-500/40' },
  { bg: 'bg-rose-500',    border: 'border-l-rose-500',    text: 'text-rose-300',    badge: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
  { bg: 'bg-cyan-500',    border: 'border-l-cyan-500',    text: 'text-cyan-300',    badge: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40' },
  { bg: 'bg-orange-500',  border: 'border-l-orange-500',  text: 'text-orange-300',  badge: 'bg-orange-500/20 text-orange-300 border-orange-500/40' },
  { bg: 'bg-indigo-500',  border: 'border-l-indigo-500',  text: 'text-indigo-300',  badge: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' },
  { bg: 'bg-teal-500',    border: 'border-l-teal-500',    text: 'text-teal-300',    badge: 'bg-teal-500/20 text-teal-300 border-teal-500/40' },
]

// ─── Utilities ───────────────────────────────────────────────────────────────

function getStreamColor(username: string, allUsernames: string[]): StreamColor {
  const index = allUsernames.indexOf(username)
  return STREAM_COLORS[index >= 0 ? index % STREAM_COLORS.length : 0]
}

function formatUptime(lastConnectedAt: number | null): string {
  if (!lastConnectedAt) return '0s'
  const seconds = Math.round((Date.now() - lastConnectedAt) / 1000)
  if (seconds > 3600) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }
  if (seconds > 60) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}

function isStreamStale(health: StreamHealth | null | undefined): boolean {
  if (!health?.lastEventAt) return false
  return Date.now() - health.lastEventAt > STALE_THRESHOLD_MS
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 flex items-center gap-3">
        {icon}
        <div>
          <div className="text-xl font-bold font-mono">{value.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function StreamCard({ stream, allUsernames }: { stream: DashboardStream; allUsernames: string[] }) {
  const { t } = useI18n()
  const color = getStreamColor(stream.username, allUsernames)
  const { health } = stream
  const stale = isStreamStale(health)
  const hasIssues = health && (health.reconnectCount > 0 || health.errorsCount > 0 || stale)

  const statusColor = stale ? 'bg-red-500' : hasIssues ? 'bg-amber-500' : 'bg-emerald-500'
  const statusTitle = stale ? t('dashStale') : hasIssues ? t('dashUnstable') : t('dashHealthy')
  const uptimeStr = formatUptime(health?.lastConnectedAt ?? null)

  return (
    <Card className="border-border/50">
      <CardContent className="pt-4 pb-3">
        {/* Stream header */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2.5 h-2.5 rounded-full ${color.bg} animate-pulse`} />
          <a
            href={`https://www.tiktok.com/@${encodeURIComponent(stream.username)}/live`}
            target="_blank"
            rel="noopener noreferrer"
            className={`font-semibold text-sm ${color.text} hover:underline`}
          >
            @{stream.username}
          </a>
          <span className="flex-1" />
          <span className={`w-2 h-2 rounded-full ${statusColor}`} title={statusTitle} />
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="text-center">
            <div className="font-mono font-semibold text-sky-300">{stream.viewerCount.toLocaleString()}</div>
            <div className="text-muted-foreground">👁 viewers</div>
          </div>
          <div className="text-center">
            <div className="font-mono font-semibold text-pink-300">{stream.recentDiamonds.toLocaleString()}</div>
            <div className="text-muted-foreground">💎 recent</div>
          </div>
          <div className="text-center">
            <div className="font-mono font-semibold text-amber-300">{stream.eventCount.toLocaleString()}</div>
            <div className="text-muted-foreground">📊 events</div>
          </div>
        </div>

        {/* Health indicators */}
        <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
          <span>⏱ {uptimeStr}</span>
          {health && health.reconnectCount > 0 && (
            <span className="text-amber-300">🔄 {health.reconnectCount}</span>
          )}
          {health && health.errorsCount > 0 && (
            <span className="text-red-300">❌ {health.errorsCount}</span>
          )}
          {stale && <span className="text-red-400 font-semibold">{t('dashStale')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function FilterChips({
  allUsernames,
  filter,
  onToggle,
  onClear,
}: {
  allUsernames: string[]
  filter: Set<string>
  onToggle: (username: string) => void
  onClear: () => void
}) {
  const { t } = useI18n()

  if (allUsernames.length <= 1) return null

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      <Filter className="w-3 h-3 text-muted-foreground" />
      <button
        onClick={onClear}
        className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
          filter.size === 0
            ? 'bg-foreground/10 text-foreground border-foreground/20 font-semibold'
            : 'bg-transparent text-muted-foreground border-border hover:bg-secondary'
        }`}
      >
        {t('fAll')}
      </button>
      {allUsernames.map((username) => {
        const color = getStreamColor(username, allUsernames)
        const active = filter.has(username)
        return (
          <button
            key={username}
            onClick={() => onToggle(username)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
              active
                ? `${color.badge} font-semibold`
                : filter.size === 0
                  ? `${color.badge} opacity-80`
                  : 'bg-transparent text-muted-foreground border-border hover:bg-secondary opacity-50'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${color.bg}`} />
            @{username}
          </button>
        )
      })}
    </div>
  )
}

function UnifiedChatLine({ event, color }: { event: UnifiedChatEvent; color: StreamColor }) {
  const name = event.user?.nickname || event.user?.uniqueId || '?'
  const time = <span className="text-muted-foreground">{fmtTime(event.ts)}</span>
  const avatar = <Avatar url={event.user?.profilePictureUrl} name={name} size={20} className="mt-0.5" />

  const streamBadge = event._username ? (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[9px] font-mono font-semibold ${color.badge} border`}>
      <span className={`w-1.5 h-1.5 rounded-full ${color.bg}`} />
      {event._username}
    </span>
  ) : null

  switch (event.type) {
    case 'chat':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          {avatar}
          <span className="flex-1 min-w-0 leading-snug break-words">
            {time} {streamBadge} <strong className="text-sky-400">{name}</strong>:{' '}
            <span className="text-foreground/90">{event.comment}</span>
          </span>
        </div>
      )
    case 'gift':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {streamBadge} 🎁 <strong className="text-amber-400">{name}</strong> sent{' '}
            <em className="not-italic text-amber-300">{event.giftName}</em> ×{event.repeatCount || 1}{' '}
            <span className="text-amber-200">({event.diamondCount || 0}💎)</span>
          </span>
        </div>
      )
    case 'like':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span>
            {time} {streamBadge} ❤️ <strong className="text-rose-400">{name}</strong> ×{event.likeCount || 1}
          </span>
        </div>
      )
    case 'subscribe':
      return (
        <div className="py-0.5">
          {time} {streamBadge} ⭐ <strong className="text-yellow-400">{name}</strong> subscribed!
        </div>
      )
    case 'pkStart':
      return (
        <div className="py-0.5">
          {time} {streamBadge} <span className="text-fuchsia-400">⚔ PK started</span>
        </div>
      )
    case 'pkEnd':
      return (
        <div className="py-0.5">
          {time} {streamBadge} <span className="text-fuchsia-400">🏁 PK ended</span>
        </div>
      )
    case 'member':
    case 'follow':
    case 'social':
      return (
        <div className="text-foreground/50 py-0.5">
          {time} {streamBadge} 👋 {name}
        </div>
      )
    case 'roomUser':
    case 'connected':
    case 'pkUpdate':
      return null
    default:
      return (
        <div className="text-foreground/40 py-0.5">
          {time} {streamBadge} {event.type}
        </div>
      )
  }
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useI18n()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Set<string>>(new Set())
  const feedRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/chat/dashboard')
      if (!response.ok) return
      const json: DashboardData = await response.json()
      setData(json)
    } catch {
      // Network errors are silently ignored — dashboard will retry on next interval
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll only while the tab is visible — Dashboard refreshes were eating
  // server CPU on dozens of background tabs otherwise.
  usePoll(refresh, REFRESH_INTERVAL_MS)

  // Auto-scroll feed to bottom on new messages
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [data?.unifiedFeed])

  const allUsernames = useMemo(() => {
    return data?.streams.map((stream) => stream.username) ?? []
  }, [data?.streams])

  const filteredFeed = useMemo(() => {
    if (!data) return []
    if (filter.size === 0) return data.unifiedFeed
    return data.unifiedFeed.filter((ev) => ev._username && filter.has(ev._username))
  }, [data, filter])

  const totalDiamonds = useMemo(() => {
    return data?.streams.reduce((sum, stream) => sum + stream.recentDiamonds, 0) ?? 0
  }, [data?.streams])

  const toggleFilter = useCallback((username: string) => {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
  }, [])

  const clearFilter = useCallback(() => setFilter(new Set()), [])

  const isLive = data && data.totalStreams > 0

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4">
      <Header />

      {/* Page title */}
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-emerald-400" />
        <h2 className="text-lg font-bold">{t('dashTitle')}</h2>
        {isLive && (
          <Badge className="bg-red-600 text-white text-[10px] animate-pulse">
            <Radio className="w-3 h-3 mr-1" /> LIVE
          </Badge>
        )}
      </div>

      {/* Global stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={<Radio className="w-4 h-4 text-red-400" />} value={data?.totalStreams ?? 0} label={t('dashStreams')} />
        <StatCard icon={<Users className="w-4 h-4 text-sky-400" />} value={data?.totalViewers ?? 0} label={t('dashViewers')} />
        <StatCard icon={<Gem className="w-4 h-4 text-pink-400" />} value={totalDiamonds} label={t('dashDiamonds')} />
        <StatCard icon={<MessageSquare className="w-4 h-4 text-amber-400" />} value={data?.totalEvents ?? 0} label={t('dashEvents')} />
      </div>

      {/* Per-stream cards */}
      {data && data.streams.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.streams.map((stream) => (
            <StreamCard key={stream.username} stream={stream} allUsernames={allUsernames} />
          ))}
        </div>
      )}

      {/* Unified chat feed */}
      <Card>
        <CardContent className="pt-4 space-y-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            {t('dashUnifiedChat')}
          </h3>

          <FilterChips
            allUsernames={allUsernames}
            filter={filter}
            onToggle={toggleFilter}
            onClear={clearFilter}
          />

          <div
            ref={feedRef}
            className="h-[400px] bg-secondary/50 border border-border rounded-lg p-2 overflow-y-auto text-xs space-y-0.5"
          >
            {loading && !data && <p className="text-muted-foreground">— loading —</p>}
            {data && filteredFeed.length === 0 && (
              <p className="text-muted-foreground">{t('dashNoChat')}</p>
            )}
            {filteredFeed.map((ev) => (
              <UnifiedChatLine
                key={`${ev._username}_${ev.id}`}
                event={ev}
                color={getStreamColor(ev._username ?? '', allUsernames)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Empty state */}
      {data && data.totalStreams === 0 && !loading && (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('dashEmpty')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('dashEmptyHint')}</p>
        </div>
      )}
    </div>
  )
}
