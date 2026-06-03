// lib/history.ts — Search history & favorites stored in localStorage.

const HISTORY_KEY = 'tiktok_search_history'
const FAVORITES_KEY = 'tiktok_favorites'
const MAX_HISTORY = 20

export interface HistoryEntry {
  username: string
  lastUsed: number // timestamp ms
}

// ── History ──

export function getHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as HistoryEntry[]
    return list.sort((a, b) => b.lastUsed - a.lastUsed)
  } catch {
    return []
  }
}

export function addHistory(username: string): void {
  const list = getHistory().filter((e) => e.username !== username)
  list.unshift({ username, lastUsed: Date.now() })
  while (list.length > MAX_HISTORY) list.pop()
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
}

export function removeHistory(username: string): void {
  const list = getHistory().filter((e) => e.username !== username)
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY)
}

// ── Favorites ──

export function getFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

export function addFavorite(username: string): void {
  const list = getFavorites().filter((u) => u !== username)
  list.unshift(username)
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
}

export function removeFavorite(username: string): void {
  const list = getFavorites().filter((u) => u !== username)
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
}

export function isFavorite(username: string): boolean {
  return getFavorites().includes(username)
}
