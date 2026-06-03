import type {
  CheckResult,
  RecordJob,
  RecordingFile,
  WatchData,
  WatchEvent,
  ChatPollResult,
  ReplayData,
  HighlightsData,
  HighlightClip,
  LeaderboardData,
  GiftEconomyData,
  WordFrequencyData,
} from './types'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data as T
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ── Check / Stream ──
export const checkStream = (username: string) =>
  json<CheckResult>(`/api/stream?u=${encodeURIComponent(username)}`)

// ── Record ──
export const startRecord = (username: string, quality?: string) =>
  post<{ file: string; reused?: boolean }>('/api/record/start', { username, quality })

export const stopRecord = (id: number) =>
  post<{
    ok: boolean
    alreadyExited?: boolean
    graceful?: boolean
    file?: string
    sizeBytes?: number | null
    username?: string
  }>('/api/record/stop', { id })

export const getJobs = () => json<RecordJob[]>('/api/record/jobs')

// ── Recordings ──
export const getRecordings = () => json<RecordingFile[]>('/api/recordings')

export const deleteRecording = (name: string) =>
  json<void>(`/api/recordings/${encodeURIComponent(name)}`, { method: 'DELETE' })

export const getReplayData = (name: string) =>
  json<ReplayData>(`/api/recordings/${encodeURIComponent(name)}`)

// ── Highlights ──
export const getHighlights = (recording: string) =>
  json<HighlightsData>(`/api/highlights/${encodeURIComponent(recording)}`)

export const analyzeHighlights = (recording: string) =>
  post<{ ok: boolean }>('/api/highlights/analyze', { recording })

export const cutHighlightClip = (recording: string, startSec: number, endSec: number) =>
  post<{ ok: boolean; clip: HighlightClip & { reused?: boolean } }>(
    '/api/highlights/cut',
    { recording, startSec, endSec },
  )

export const deleteHighlightClip = (clipName: string) =>
  json<void>(`/api/highlights/clip/${encodeURIComponent(clipName)}`, { method: 'DELETE' })

// ── Leaderboard ──
export const getLeaderboard = (recording: string) =>
  json<LeaderboardData>(`/api/leaderboard/${encodeURIComponent(recording)}`)

// ── Analytics ──
export const getGiftEconomy = (recording: string) =>
  json<GiftEconomyData>(`/api/analytics/gifts/${encodeURIComponent(recording)}`)

export const getWordFrequency = (recording: string) =>
  json<WordFrequencyData>(`/api/analytics/words/${encodeURIComponent(recording)}`)

// ── Bookmarks ──
export interface Bookmark {
  id: string
  timeSec: number
  note: string
  createdAt: number
}

export const getBookmarks = (recording: string) =>
  json<{ recording: string; bookmarks: Bookmark[] }>(`/api/bookmarks/${encodeURIComponent(recording)}`)

export const addBookmark = (recording: string, timeSec: number, note: string) =>
  post<{ ok: boolean; bookmark: Bookmark }>('/api/bookmarks', { recording, timeSec, note })

export const deleteBookmark = (recording: string, id: string) =>
  json<{ ok: boolean }>(`/api/bookmarks/${encodeURIComponent(recording)}/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ── Search ──
export interface ChatSearchResult {
  recording: string
  ts: number
  user: string
  comment: string
}

export const searchChatAll = (query: string) =>
  json<{ query: string; results: ChatSearchResult[] }>(`/api/search/chat?q=${encodeURIComponent(query)}`)

// ── Tags ──
export const getRecordingTags = (recording: string) =>
  json<{ recording: string; tags: string[] }>(`/api/tags/${encodeURIComponent(recording)}`)

// ── Watchlist ──
export const getWatch = () => json<WatchData>('/api/watch')

export const addWatch = (username: string, quality?: string | null, autoRecord?: boolean) =>
  post<WatchData>('/api/watch', { username, quality, autoRecord })

export const removeWatch = (username: string) =>
  json<void>(`/api/watch/${encodeURIComponent(username)}`, { method: 'DELETE' })

export const patchWatch = (username: string, patch: { autoRecord?: boolean }) =>
  json<void>(`/api/watch/${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

export const savePollSeconds = (seconds: number) =>
  post<void>('/api/watch/poll-seconds', { seconds })

export const pollNow = () => post<void>('/api/watch/poll-now', undefined)

export const getWatchEvents = (sinceId: number) =>
  json<WatchEvent[]>(`/api/watch/events?sinceId=${sinceId}`)

export const getLiveStreams = () =>
  json<CheckResult[]>('/api/watch/live-streams')

// ── Chat ──
export const startChat = (username: string) =>
  post<void>('/api/chat/start', { username })

export const stopChat = (username: string) =>
  post<void>('/api/chat/stop', { username })

export const getChatEvents = (username: string, sinceId: number) =>
  json<ChatPollResult>(`/api/chat/events?username=${encodeURIComponent(username)}&sinceId=${sinceId}`)

// ── Accounts ──
export interface AccountInfo {
  id: string
  label: string
  hasSession: boolean
  sessionPreview: string
}

export interface AccountsResponse {
  accounts: AccountInfo[]
  active: { id: string | null; sessionPreview: string; hasSession: boolean }
  stealth: boolean
}

export const getAccounts = () => json<AccountsResponse>('/api/accounts')

export const addAccount = (label: string, sessionId: string, ttTargetIdc?: string) =>
  post<{ ok: boolean; id: string; label: string }>('/api/accounts', { label, sessionId, ttTargetIdc })

export const deleteAccount = (id: string) =>
  json<void>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const switchAccount = (id?: string) =>
  post<{ ok: boolean; hasSession: boolean }>('/api/accounts/switch', { id })

export const toggleStealth = (enabled: boolean) =>
  post<{ ok: boolean; stealth: boolean }>('/api/accounts/stealth', { enabled })
