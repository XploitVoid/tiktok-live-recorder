import type { ReactNode } from 'react'
import {
  Gift,
  Heart,
  UserPlus,
  UserCheck,
  Share2,
  CheckCircle2,
  Swords,
  Flag,
  Star,
  Sparkles,
  BarChart2,
  ShoppingBag,
  Package,
  HelpCircle,
  Megaphone,
  Mic,
  Pin,
  Trophy,
  Square,
  AlertCircle,
  Gem,
} from 'lucide-react'
import { Avatar } from '@/components/Avatar'
import { HighlightText } from '@/components/HighlightText'
import { useI18n } from '@/lib/i18n'
import { safeImageUrl } from '@/lib/utils'
import type { ChatEvent } from '@/lib/types'

interface Props {
  event: ChatEvent
  timeText: string
  keywords?: string[]
  prefix?: ReactNode
}

export function ChatEventRow({ event: ev, timeText, keywords = [], prefix }: Props) {
  const { t } = useI18n()
  const time = <span className="text-muted-foreground font-mono text-[11px] tabular-nums shrink-0">{timeText}</span>
  const name = ev.user?.nickname || ev.user?.uniqueId || '?'
  const avatar = <Avatar url={ev.user?.profilePictureUrl} name={name} size={22} className="mt-0.5 shrink-0" />

  switch (ev.type) {
    case 'chat':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          {avatar}
          <span className="flex-1 min-w-0 leading-snug break-words">
            {time} {prefix}{' '}
            <strong className="text-sky-400 font-medium">{name}</strong>:{' '}
            <HighlightText text={ev.comment || ''} keywords={keywords} className="text-foreground/90" />
          </span>
        </div>
      )

    case 'gift': {
      const repeat = ev.repeatCount || 1
      const totalDiamonds = (ev.diamondCount || 0) * repeat
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words leading-snug">
            {time} {prefix}{' '}
            <Gift className="inline w-3 h-3 text-amber-400 -mt-0.5 mr-1" />
            <strong className="text-amber-400 font-medium">{name}</strong>{' '}
            <span className="text-muted-foreground">{t('chatEventSent')}</span>{' '}
            <span className="text-amber-200">{ev.giftName}</span>{' '}
            <span className="tabular-nums text-xs">×{repeat}</span>{' '}
            <span className="inline-flex items-center gap-0.5 text-amber-300/90 text-xs tabular-nums">
              ({totalDiamonds.toLocaleString()}
              <Gem className="inline w-2.5 h-2.5" />)
            </span>
            {ev.comment && (
              <>
                {' — '}
                <HighlightText text={ev.comment} keywords={keywords} className="text-foreground/90" />
              </>
            )}
          </span>
        </div>
      )
    }

    case 'like':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix}{' '}
            <Heart className="inline w-3 h-3 text-rose-400 fill-rose-400/30 -mt-0.5 mr-1" />
            <strong className="text-rose-400 font-medium">{name}</strong>{' '}
            <span className="text-muted-foreground tabular-nums">×{ev.likeCount || 1}</span>
          </span>
        </div>
      )

    case 'member':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words text-foreground/70">
            {time} {prefix}{' '}
            <UserCheck className="inline w-3 h-3 text-muted-foreground -mt-0.5 mr-1" />
            <span>{name}</span> {t('chatEventJoined')}
          </span>
        </div>
      )

    case 'social':
    case 'follow':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix}{' '}
            <UserPlus className="inline w-3 h-3 text-emerald-400 -mt-0.5 mr-1" />
            <strong className="text-emerald-400 font-medium">{name}</strong>{' '}
            <span className="text-foreground/70">{ev.label || t('chatEventFollowed')}</span>
          </span>
        </div>
      )

    case 'share':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix}{' '}
            <Share2 className="inline w-3 h-3 text-cyan-400 -mt-0.5 mr-1" />
            <strong className="text-cyan-400 font-medium">{name}</strong> {t('chatEventShared')}
          </span>
        </div>
      )

    case 'connected':
      return (
        <div className="py-0.5 text-emerald-400 flex items-center gap-1.5">
          {time} {prefix}
          <CheckCircle2 className="w-3 h-3 shrink-0" />
          <span className="text-xs">{t('chatEventConnected')} {ev.roomId || ''}</span>
        </div>
      )

    case 'pkStart': {
      const opps = (ev.battleUsers || [])
        .map((u) => u.nickname || u.uniqueId)
        .filter(Boolean)
        .join(' vs ')
      return (
        <div className="py-0.5 text-fuchsia-400 flex items-center gap-1.5">
          {time} {prefix}
          <Swords className="w-3 h-3 shrink-0" />
          <span>{t('chatEventPkStart')}{opps ? ` — ${opps}` : ''}</span>
        </div>
      )
    }

    case 'pkUpdate': {
      const score = (ev.teams || []).map((tm) => tm.score).join(' : ')
      return (
        <div className="py-0.5 text-fuchsia-300/75 text-[11px] flex items-center gap-1.5 tabular-nums">
          {time} {prefix}
          <Swords className="w-3 h-3 shrink-0" />
          <span>{score}</span>
          {!!ev.totalDiamondCount && (
            <span className="inline-flex items-center gap-0.5">
              · {ev.totalDiamondCount}
              <Gem className="w-2.5 h-2.5" />
            </span>
          )}
        </div>
      )
    }

    case 'pkEnd': {
      const score = (ev.teams || []).map((tm) => tm.score).join(' : ')
      return (
        <div className="py-0.5 text-fuchsia-400 flex items-center gap-1.5 tabular-nums">
          {time} {prefix}
          <Flag className="w-3 h-3 shrink-0" />
          <span>{t('chatEventPkEnd')}{score ? ` — ${score}` : ''}</span>
        </div>
      )
    }

    case 'subscribe':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix}{' '}
            <Star className="inline w-3 h-3 text-yellow-400 fill-yellow-400 -mt-0.5 mr-1" />
            <strong className="text-yellow-400 font-medium">{name}</strong>{' '}
            <span className="text-foreground/85">{ev.label || t('chatEventSubscribed')}</span>
            {ev.comment && (
              <>
                {' — '}
                <HighlightText text={ev.comment} keywords={keywords} className="text-foreground/90" />
              </>
            )}
          </span>
        </div>
      )

    case 'superFan':
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix}{' '}
            <Sparkles className="inline w-3 h-3 text-amber-300 -mt-0.5 mr-1" />
            <strong className="text-amber-300 font-medium">{name}</strong>{' '}
            {ev.joined ? t('chatEventJoinedSuperFan') : t('chatEventSuperFan')}
          </span>
        </div>
      )

    case 'superFanBox':
      return (
        <div className="py-0.5 text-amber-400 flex items-center gap-1.5">
          {time} {prefix}
          <Package className="w-3 h-3 shrink-0" />
          <span>{t('chatEventSuperFanBox')}</span>
        </div>
      )

    case 'poll':
      return (
        <div className="py-0.5 text-sky-300 flex items-center gap-1.5">
          {time} {prefix}
          <BarChart2 className="w-3 h-3 shrink-0" />
          <span>{t('chatEventPoll')} {ev.title || t('chatEventLivePoll')}</span>
        </div>
      )

    case 'shopping':
      return (
        <div className="py-0.5 text-emerald-300 flex items-center gap-1.5">
          {time} {prefix}
          <ShoppingBag className="w-3 h-3 shrink-0" />
          <span>
            {ev.title || `${t('chatEventProduct')}${ev.productNumber ?? ''}`}
            {ev.price ? ` (${ev.price})` : ''}
          </span>
        </div>
      )

    case 'envelope':
      return (
        <div className="py-0.5 text-primary flex items-center gap-1.5">
          {time} {prefix}
          <Gift className="w-3 h-3 shrink-0" />
          <span>{t('chatEventTreasureBox')}</span>
        </div>
      )

    case 'question':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          {avatar}
          <span className="flex-1 min-w-0 leading-snug break-words">
            {time} {prefix}{' '}
            <HelpCircle className="inline w-3 h-3 text-violet-400 -mt-0.5 mr-1" />
            <strong className="text-violet-400 font-medium">{name}</strong>:{' '}
            <span className="text-foreground/90 italic">{ev.comment || ''}</span>
          </span>
        </div>
      )

    case 'liveIntro':
      return (
        <div className="py-0.5 text-indigo-400 flex items-center gap-1.5">
          {time} {prefix}
          <Megaphone className="w-3 h-3 shrink-0" />
          <span>{ev.introText || t('chatEventLiveIntro')}</span>
        </div>
      )

    case 'emote': {
      const emoteImgs = (ev.emotes || []).map((em, i) => {
        const safeUrl = safeImageUrl(em.imageUrl)
        return safeUrl ? (
          <img
            key={i}
            src={safeUrl}
            alt="emote"
            className="inline-block w-6 h-6 mx-0.5"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span key={i} className="text-muted-foreground">[emote]</span>
        )
      })
      return (
        <div className="flex items-center gap-1.5 py-0.5">
          {avatar}
          <span className="min-w-0 break-words">
            {time} {prefix} <strong className="text-purple-400 font-medium">{name}</strong> {emoteImgs}
          </span>
        </div>
      )
    }

    case 'caption':
      return (
        <div className="py-0.5 text-foreground/65 italic flex items-center gap-1.5">
          {time} {prefix}
          <Mic className="w-3 h-3 text-cyan-400/75 shrink-0" />
          <span>{ev.text}</span>
        </div>
      )

    case 'roomPin':
      if (ev.action === 'unpin') {
        return (
          <div className="py-0.5 text-muted-foreground flex items-center gap-1.5">
            {time} {prefix}
            <Pin className="w-3 h-3 shrink-0" />
            <span>{t('chatEventUnpinned')}</span>
          </div>
        )
      }
      return (
        <div className="py-0.5 text-indigo-400 flex items-center gap-1.5">
          {time} {prefix}
          <Pin className="w-3 h-3 shrink-0" />
          <span>
            {t('chatEventPinned')} <strong>{ev.pinnedUser?.nickname || '?'}</strong>: {ev.pinnedText || ''}
          </span>
        </div>
      )

    case 'rankUpdate': {
      const ranked = (ev.updates || [])
        .filter((u) => u.ownerRank != null && u.ownerRank !== '')
        .map((u) => `${t('chatEventRank')} ${u.ownerRank}`)
      if (ranked.length === 0) return null
      return (
        <div className="py-0.5 text-amber-400/75 flex items-center gap-1.5">
          {time} {prefix}
          <Trophy className="w-3 h-3 shrink-0" />
          <span>{ranked.join(', ')}</span>
        </div>
      )
    }

    case 'streamEnd':
      return (
        <div className="py-0.5 text-amber-500 flex items-center gap-1.5">
          {time} {prefix}
          <Square className="w-3 h-3 shrink-0" />
          <span>{t('chatEventStreamEnded')}</span>
        </div>
      )

    case 'error':
      return (
        <div className="py-0.5 text-destructive flex items-center gap-1.5">
          {time} {prefix}
          <AlertCircle className="w-3 h-3 shrink-0" />
          <span>{ev.error}</span>
        </div>
      )

    case 'roomUser':
      return null

    default:
      return (
        <div className="py-0.5 text-muted-foreground flex items-center gap-1.5">
          {time} {prefix}
          <span>{ev.type}</span>
        </div>
      )
  }
}
