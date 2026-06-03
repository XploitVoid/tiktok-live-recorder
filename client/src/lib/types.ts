export interface Owner {
  nickname?: string
  uniqueId?: string
  verified?: boolean
  followers?: number
  avatarThumb?: string
}

export interface StreamData {
  hls?: string
  hlsByQuality?: Record<string, string>
  flv?: Record<string, string>
  cmaf?: Record<string, string>
  hevc?: {
    hls?: Record<string, string>
    flv?: Record<string, string>
    cmaf?: Record<string, string>
  }
  qualities?: { name: string; sdkKey: string; level?: number }[]
  hevcQualities?: { name: string; sdkKey: string; level?: number }[]
}

export interface CheckResult {
  username: string
  live: boolean
  streamsAvailable?: boolean
  title?: string
  coverUrl?: string
  viewerCount?: number
  startedAtUnix?: number
  liveRoomMode?: string
  owner?: Owner
  streams?: StreamData
}

export interface RecordJob {
  id: number
  username: string
  kind: string
  quality: string
  file: string
  startedAt: number
  exited: boolean
  exitedAt?: number
  exitCode?: number
  sizeBytes?: number
  lastErr?: string
}

export interface RecordingFile {
  name: string
  sizeBytes: number
  hasEvents: boolean
  highlightCount?: number
  clipCount?: number
}

export interface WatchEntry {
  username: string
  quality?: string
  autoRecord: boolean
  lastStatus?: string
  lastChangedAt?: number
  lastViewerCount?: number
  lastTitle?: string
}

export interface WatchData {
  pollSeconds: number
  list: WatchEntry[]
}

export interface WatchEvent {
  id: number
  ts: number
  type: string
  username: string
  title?: string
  viewerCount?: number
  quality?: string
  file?: string
  error?: string
}

export interface ChatEvent {
  id: number
  ts: number
  type: string
  comment?: string
  user?: { nickname?: string; uniqueId?: string; profilePictureUrl?: string }
  giftName?: string
  repeatCount?: number
  diamondCount?: number
  likeCount?: number
  label?: string
  roomId?: string
  error?: string
  // PK / link-mic battle (from linkMicBattle / linkMicArmies)
  battleId?: string
  battleUsers?: { uniqueId?: string; nickname?: string; profilePictureUrl?: string; userId?: string }[]
  teams?: { teamId: string; score: number; hostRank: number }[]
  totalDiamondCount?: number
  // Envelope / treasure box
  treasureBoxData?: unknown
  envelopeInfo?: unknown
  // Live intro
  introText?: string
  host?: { uniqueId?: string; nickname?: string; profilePictureUrl?: string }
  // Emote
  emotes?: { emoteId: string; imageUrl: string | null }[]
  // Caption / subtitle
  text?: string
  lang?: string | null
  definite?: boolean
  // Room pin
  action?: string
  pinnedText?: string | null
  pinnedUser?: { uniqueId?: string; nickname?: string; profilePictureUrl?: string } | null
  pinId?: string | null
  displayDuration?: number | null
  // Rank update
  updates?: { rankType: string | null; ownerRank: string | null; showAnimation: boolean }[]
}

export interface ChatPollResult {
  state: string
  viewerCount?: number
  events?: ChatEvent[]
}

export interface ReplayData {
  startMs?: number
  eventCount?: number
  eventsExists?: boolean
  sizeBytes?: number
  events?: (ChatEvent & { t?: number })[]
}

export interface HighlightCandidate {
  id: string
  startSec: number
  endSec: number
  score: number
  peakScore: number
  baseline: number
  ratio: number
  reason: 'gift_spike' | 'chat_spike' | 'activity_spike' | 'pk_battle'
  pk?: {
    battleId?: string | null
    opponents: string[]
    durationSec: number
    explicitEnd: boolean
  }
  summary: {
    chats: number
    gifts: number
    likes: number
    diamonds: number
    follows: number
    shares: number
    topGift?: { name: string; count: number } | null
    topUser?: { name: string; score: number; avatar?: string | null } | null
  }
}

export interface HighlightClip {
  name: string
  sizeBytes: number
  mtime: number
  startSec: number | null
  durSec: number | null
}

export interface HighlightsData {
  recording: string
  analyzed: boolean
  analyzedAt: number | null
  candidates: HighlightCandidate[]
  stats: {
    totalEvents?: number
    durationSec?: number
    bucketCount?: number
    spikeBuckets?: number
    pkWindows?: number
    usedFallback?: boolean
  } | null
  usedFallback?: boolean
  clips: HighlightClip[]
}

// ── Leaderboard / top supporters ──
export interface LeaderboardUser {
  uniqueId: string | null
  nickname: string
  avatar: string | null
  chats: number
  gifts: number
  diamonds: number
  likes: number
  follows: number
  shares: number
  score: number
  topGiftName: { name: string; count: number } | null
}

export interface GiftBreakdown {
  name: string
  count: number
  diamonds: number
}

export interface LeaderboardData {
  ok: boolean
  recording: string
  startMs: number | null
  totals: {
    diamonds: number
    chats: number
    gifts: number
    likes: number
    follows: number
    shares: number
    uniqueUsers: number
    eventCount: number
  }
  giftSummary: GiftBreakdown[]
  overall: LeaderboardUser[]
  topGifters: LeaderboardUser[]
  topChatters: LeaderboardUser[]
  topLikers: LeaderboardUser[]
  topFollowers: LeaderboardUser[]
}

// ── Gift Economy / Analytics ──
export interface GiftEconomyData {
  ok: boolean
  recording: string
  durationSec: number
  bucketSec: number
  giftHeatmap: number[]
  chatHeatmap: number[]
  totals: {
    diamonds: number
    gifts: number
    avgDiamondPerMin: number
    peakMomentSec: number
    peakDiamonds: number
  }
  giftBreakdown: GiftBreakdown[]
}

export interface WordFrequencyData {
  ok: boolean
  recording: string
  totalMessages: number
  phrases: { word: string; count: number; pct: number }[]
}
