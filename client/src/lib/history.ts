// lib/history.ts — Search history & favorites stored in localStorage.
import { normalizePlatform } from './utils'
import type { Platform } from './types'

const HISTORY_KEY = 'tiktok_search_history'
const FAVORITES_KEY = 'tiktok_favorites'
const MAX_HISTORY = 20

export interface HistoryEntry {
  username: string
  platform: Platform
  lastUsed: number // timestamp ms
}

export type HistoryItem = HistoryEntry

export interface FavoriteEntry {
  username: string
  platform: Platform
}

export type FavoriteItem = FavoriteEntry

function normPlatform(p?: unknown): Platform {
  return normalizePlatform(p)
}

function normUsername(username: string, platform: Platform): string {
  const s = username.trim()
  if (platform === 'twitch' || platform === 'kick') return s.toLowerCase()
  if (platform === 'youtube') {
    if (/^v_[A-Za-z0-9_-]{11}$/.test(s) || /^UC[A-Za-z0-9_-]{22}$/.test(s)) return s
    return s.toLowerCase()
  }
  return s
}

function sameEntry(a: { username: string; platform?: Platform }, username: string, platform: Platform): boolean {
  const ap = normPlatform(a.platform)
  if (ap !== platform) return false
  return normUsername(a.username, ap) === normUsername(username, platform)
}

// ── History ──

export function getHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const list: HistoryEntry[] = []
    for (const item of parsed) {
      let username = ''
      let platform: Platform = 'tiktok'
      let lastUsed = 0
      if (typeof item === 'string') {
        username = item.trim()
      } else if (item && typeof item === 'object' && typeof (item as { username?: unknown }).username === 'string') {
        const obj = item as { username: string; platform?: unknown; lastUsed?: unknown; ts?: unknown }
        platform = normPlatform(obj.platform)
        username = normUsername(obj.username, platform)
        lastUsed = Number(obj.lastUsed ?? obj.ts) || 0
      }
      if (!username) continue
      const key = `${platform}:${normUsername(username, platform)}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ username, platform, lastUsed })
    }
    return list.sort((a, b) => b.lastUsed - a.lastUsed)
  } catch {
    return []
  }
}

export function addHistory(username: string, platform: Platform = 'tiktok'): void {
  const p = normPlatform(platform)
  const u = normUsername(username, p)
  if (!u) return
  const list = getHistory().filter((e) => !sameEntry(e, u, p))
  list.unshift({ username: u, platform: p, lastUsed: Date.now() })
  while (list.length > MAX_HISTORY) list.pop()
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
}

export function removeHistory(username: string, platform: Platform = 'tiktok'): void {
  const p = normPlatform(platform)
  const list = getHistory().filter((e) => !sameEntry(e, username, p))
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY)
}

// ── Favorites ──

export function getFavorites(): FavoriteEntry[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const list: FavoriteEntry[] = []
    for (const item of parsed) {
      let username = ''
      let platform: Platform = 'tiktok'
      if (typeof item === 'string') {
        username = item.trim()
      } else if (item && typeof item === 'object' && typeof (item as { username?: unknown }).username === 'string') {
        const obj = item as { username: string; platform?: unknown }
        platform = normPlatform(obj.platform)
        username = normUsername(obj.username, platform)
      }
      if (!username) continue
      const key = `${platform}:${normUsername(username, platform)}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ username, platform })
    }
    return list
  } catch {
    return []
  }
}

export function addFavorite(username: string, platform: Platform = 'tiktok'): void {
  const p = normPlatform(platform)
  const u = normUsername(username, p)
  if (!u) return
  const list = getFavorites().filter((e) => !sameEntry(e, u, p))
  list.unshift({ username: u, platform: p })
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
}

export function removeFavorite(username: string, platform: Platform = 'tiktok'): void {
  const p = normPlatform(platform)
  const list = getFavorites().filter((e) => !sameEntry(e, username, p))
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
}

export function isFavorite(username: string, platform: Platform = 'tiktok'): boolean {
  const p = normPlatform(platform)
  return getFavorites().some((e) => sameEntry(e, username, p))
}
