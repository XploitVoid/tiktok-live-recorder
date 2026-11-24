import type {
  Platform,
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
  SettingsResponse,
  AppSettings,
  DiskStatus,
  AccountHealth,
  SearchIndexStatus,
} from './types'

export const UNAUTHORIZED_EVENT = 'tlr:unauthorized'

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (r.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  const text = await r.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try { data = JSON.parse(text) as Record<string, unknown> } catch { data = { error: text } }
  }
  if (!r.ok) throw new Error((typeof data.error === 'string' && data.error) || `HTTP ${r.status}`)
  return data as T
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ── Auth ──
export const getAuthStatus = () =>
  json<{ authRequired: boolean; authenticated: boolean }>('/api/auth/status')

export const loginWithToken = (token: string) =>
  post<{ ok: boolean; authRequired: boolean }>('/api/auth/login', { token })

export const logoutAuth = () =>
  post<{ ok: boolean }>('/api/auth/logout')

// ── Check / Stream ──
export async function checkStream(username: string, platform?: Platform): Promise<CheckResult> {
  const params = new URLSearchParams({ u: username })
  if (platform) params.set('platform', platform)
  const url = `/api/stream?${params.toString()}`
  const r = await fetch(url)
  if (r.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  const text = await r.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try { data = JSON.parse(text) as Record<string, unknown> } catch { data = { error: text } }
  }
  if (r.status === 404 && data.live === false && typeof data.username === 'string') {
    return data as unknown as CheckResult
  }
  if (!r.ok) {
    throw new Error((typeof data.error === 'string' && data.error) || `HTTP ${r.status}`)
  }
  return data as unknown as CheckResult
}

// ── Record ──
export const startRecord = (
  username: string,
  quality?: string,
  opts?: { audioOnly?: boolean; audioBitrate?: string | null; recordChat?: boolean; platform?: Platform },
) =>
  post<{ file: string; reused?: boolean; platform?: Platform }>('/api/record/start', {
    username,
    quality,
    audioOnly: opts?.audioOnly,
    audioBitrate: opts?.audioBitrate,
    recordChat: opts?.recordChat,
    platform: opts?.platform,
  })

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

export const cutLiveClip = (id: number, seconds: number) =>
  post<{
    ok: boolean
    name: string
    url: string
    sizeBytes: number
    startSec: number
    durSec: number
    recording: string
  }>('/api/record/live-clip', { id, seconds })

// ── Recordings ──
export const getRecordings = () => json<RecordingFile[]>('/api/recordings')

export const deleteRecording = (name: string) =>
  json<void>(`/api/recordings/${encodeURIComponent(name)}`, { method: 'DELETE' })

export const getReplayData = (name: string) =>
  json<ReplayData>(`/api/recordings/${encodeURIComponent(name)}`)

export const updateRecordingMeta = (
  name: string,
  patch: { protected?: boolean; displayTitle?: string | null; notes?: string },
) =>
  json<{ ok: boolean; meta: RecordingFile }>(`/api/recordings/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

// ── Highlights ──
export const getHighlights = (recording: string) =>
  json<HighlightsData>(`/api/highlights/${encodeURIComponent(recording)}`)

export const analyzeHighlights = (recording: string) =>
  post<{ ok: boolean }>('/api/highlights/analyze', { recording })

export const cutHighlightClip = (
  recording: string,
  startSec: number,
  endSec: number,
  opts?: { vertical?: 'none' | 'crop' | 'blur' | 'pk-split'; burnSubtitles?: boolean },
) =>
  post<{ ok: boolean; clip: HighlightClip & { reused?: boolean } }>(
    '/api/highlights/cut',
    { recording, startSec, endSec, vertical: opts?.vertical, burnSubtitles: opts?.burnSubtitles },
  )

export const extractRecordingAudio = (name: string, format: 'm4a' | 'mp3' = 'm4a', bitrate?: string | null) =>
  post<{ ok: boolean; name: string; url: string; sizeBytes: number; bitrate?: string; reused: boolean }>(
    `/api/recordings/${encodeURIComponent(name)}/audio`,
    { format, bitrate: bitrate || undefined },
  )

export const compressRecording = (name: string, preset: 'balanced' | 'compact' = 'balanced') =>
  post<{ ok: boolean; name: string; sizeBytes: number; origBytes: number; preset: string; reused: boolean }>(
    `/api/recordings/${encodeURIComponent(name)}/compress`,
    { preset },
  )

export const mergeRecordings = (files: string[], deleteSources = false) =>
  post<{
    ok: boolean
    name: string
    sizeBytes: number
    parts: string[]
    hasEvents: boolean
    deletedSources: string[]
  }>('/api/recordings/merge', { files, deleteSources })

// ── Settings & Storage ──
export const getSettings = () => json<SettingsResponse>('/api/settings')

export const saveSettings = (
  patch: Partial<AppSettings> & { proxyUrl?: string; discordWebhookUrl?: string; telegramBotToken?: string },
) =>
  post<{ ok: boolean; settings: AppSettings; disk: DiskStatus }>('/api/settings', patch)

export const testWebhookSettings = () =>
  post<{ ok: boolean; results: Record<string, { ok: boolean; error?: string }> }>('/api/settings/test-webhook')

export const runStorageCleanup = () =>
  post<{ ok: boolean; deleted: string[]; disk: DiskStatus }>('/api/storage/cleanup')

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

export const getSearchIndexStatus = () => json<SearchIndexStatus>('/api/search/status')

export const reindexSearchIndex = () =>
  post<{ ok: boolean; synced: number; pruned: number } & SearchIndexStatus>('/api/search/reindex')

// ── Tags ──
export const getRecordingTags = (recording: string) =>
  json<{ recording: string; tags: string[] }>(`/api/tags/${encodeURIComponent(recording)}`)

// ── Watchlist ──
export const getWatch = () => json<WatchData>('/api/watch')

export const addWatch = (
  username: string,
  quality?: string | null,
  autoRecord?: boolean,
  opts?: {
    platform?: Platform
    audioOnly?: boolean
    audioBitrate?: string | null
    recordChat?: boolean
    priority?: 'high' | 'normal'
    accountId?: string | null
    minViewers?: number | null
    scheduleStart?: string | null
    scheduleEnd?: string | null
  },
) =>
  post<WatchData>('/api/watch', {
    username,
    quality,
    autoRecord,
    platform: opts?.platform,
    audioOnly: opts?.audioOnly,
    audioBitrate: opts?.audioBitrate,
    recordChat: opts?.recordChat,
    priority: opts?.priority,
    accountId: opts?.accountId,
    minViewers: opts?.minViewers,
    scheduleStart: opts?.scheduleStart,
    scheduleEnd: opts?.scheduleEnd,
  })

export const removeWatch = (username: string, platform?: Platform) => {
  const qs = platform ? `?platform=${encodeURIComponent(platform)}` : ''
  return json<void>(`/api/watch/${encodeURIComponent(username)}${qs}`, { method: 'DELETE' })
}

export const patchWatch = (
  username: string,
  patch: {
    platform?: Platform
    quality?: string | null
    autoRecord?: boolean
    audioOnly?: boolean
    audioBitrate?: string | null
    recordChat?: boolean
    priority?: 'high' | 'normal'
    accountId?: string | null
    minViewers?: number | null
    scheduleStart?: string | null
    scheduleEnd?: string | null
  },
) => {
  const qs = patch.platform ? `?platform=${encodeURIComponent(patch.platform)}` : ''
  return json<void>(`/api/watch/${encodeURIComponent(username)}${qs}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export const savePollSeconds = (seconds: number) =>
  post<void>('/api/watch/poll-seconds', { seconds })

export const pollNow = () => post<void>('/api/watch/poll-now', undefined)

export const getWatchEvents = (sinceId: number) =>
  json<WatchEvent[]>(`/api/watch/events?sinceId=${sinceId}`)

export const getLiveStreams = () =>
  json<CheckResult[]>('/api/watch/live-streams')

// ── Chat ──
export const startChat = (username: string, platform?: Platform) =>
  post<void>('/api/chat/start', { username, platform })

export const stopChat = (username: string, platform?: Platform) =>
  post<void>('/api/chat/stop', { username, platform })

export const getChatEvents = (username: string, sinceId: number, platform?: Platform) => {
  const params = new URLSearchParams({ username, sinceId: String(sinceId) })
  if (platform) params.set('platform', platform)
  return json<ChatPollResult>(`/api/chat/events?${params.toString()}`)
}

export const getChatDashboard = <T>() =>
  json<T>('/api/chat/dashboard')

// ── Accounts ──
export interface AccountInfo {
  id: string
  label: string
  hasSession: boolean
  sessionPreview: string
  health?: AccountHealth | null
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

export const checkAccountHealth = (id: string) =>
  post<{ ok: boolean; id: string; health: AccountHealth }>(`/api/accounts/${encodeURIComponent(id)}/check`)

export const checkAllAccountsHealth = () =>
  post<{ ok: boolean; results: Record<string, AccountHealth> }>('/api/accounts/check-all')
