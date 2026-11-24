import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Platform } from "./types"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Only allow https: URLs for untrusted remote media (avatars, covers, emotes)
 * to avoid mixed-content or non-HTTP scheme injection.
 */
export function safeImageUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize a username or pasted TikTok live URL (e.g. "user/live" or
 * "https://www.tiktok.com/@user/live") into a clean username.
 */
export function cleanUsernameInput(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?tiktok\.com\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      const host = url.hostname.toLowerCase()
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
        const m = url.pathname.match(/^\/@?([^/]+)/)
        s = m ? m[1] : ''
      }
    } catch {
      // fall through
    }
  } else {
    s = s.replace(/^@/, '').replace(/\/live(?:[/?#].*)?$/i, '')
  }
  return s.replace(/^@/, '').trim()
}

export function normalizePlatform(raw?: unknown, fallback: Platform = 'tiktok'): Platform {
  if (typeof raw !== 'string') return fallback
  const p = raw.trim().toLowerCase()
  if (p === 'twitch') return 'twitch'
  if (p === 'youtube' || p === 'yt') return 'youtube'
  if (p === 'tiktok') return 'tiktok'
  return fallback
}

function cleanTwitchLogin(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?twitch\.tv\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      const m = url.pathname.match(/^\/([^/]+)/)
      s = m ? m[1] : ''
    } catch {
      // fall through
    }
  } else {
    s = s.replace(/^@/, '').replace(/[/?#].*$/, '')
  }
  return s.replace(/^@/, '').trim().toLowerCase()
}

function cleanYouTubeInput(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.|music\.|gaming\.)?(?:youtube\.com|youtu\.be)\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      const host = url.hostname.toLowerCase()
      if (host === 'youtu.be') {
        const seg = url.pathname.replace(/^\/+/, '').split('/')[0] || ''
        return /^[A-Za-z0-9_-]{11}$/.test(seg) ? `v_${seg}` : ''
      }
      const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
      const first = parts[0] || ''
      if (first === 'watch') {
        const vid = url.searchParams.get('v') || ''
        return /^[A-Za-z0-9_-]{11}$/.test(vid) ? `v_${vid}` : ''
      }
      if ((first === 'live' || first === 'embed' || first === 'shorts') && /^[A-Za-z0-9_-]{11}$/.test(parts[1] || '')) {
        return `v_${parts[1]}`
      }
      if (first === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) {
        return parts[1]
      }
      s = (first === 'c' || first === 'user') && parts[1] ? parts[1] : first
    } catch {
      // fall through
    }
  }
  s = s.replace(/\/(?:live|streams|featured|videos|about)(?:[/?#].*)?$/i, '').replace(/[?#].*$/, '').trim()
  if (/^v_[A-Za-z0-9_-]{11}$/.test(s) || /^UC[A-Za-z0-9_-]{22}$/.test(s)) {
    return s
  }
  return s.replace(/^@/, '').trim().toLowerCase()
}

export function formatChannelUrl(platform: Platform | undefined, username: string): string {
  const plat = normalizePlatform(platform)
  if (plat === 'twitch') {
    return `https://www.twitch.tv/${encodeURIComponent(username)}`
  }
  if (plat === 'youtube') {
    const vidMatch = username.match(/^v_([A-Za-z0-9_-]{11})$/)
    if (vidMatch) return `https://www.youtube.com/watch?v=${encodeURIComponent(vidMatch[1])}`
    if (/^UC[A-Za-z0-9_-]{22}$/.test(username)) {
      return `https://www.youtube.com/channel/${encodeURIComponent(username)}/live`
    }
    return `https://www.youtube.com/@${encodeURIComponent(username)}/live`
  }
  return `https://www.tiktok.com/@${encodeURIComponent(username)}/live`
}

/**
 * Parse a username, explicit platform prefix ("twitch:name", "youtube:@name", "tiktok:@name"),
 * or channel URL into { platform, username }.
 */
export function parseChannelInput(
  raw: string,
  fallback: Platform = 'tiktok',
): { platform: Platform; username: string } {
  const s = raw.trim()
  if (!s) return { platform: fallback, username: '' }

  const prefixMatch = s.match(/^(twitch|tiktok|youtube|yt):(.*)$/i)
  if (prefixMatch) {
    const plat = normalizePlatform(prefixMatch[1])
    const rest = prefixMatch[2].trim()
    if (plat === 'twitch') return { platform: 'twitch', username: cleanTwitchLogin(rest) }
    if (plat === 'youtube') return { platform: 'youtube', username: cleanYouTubeInput(rest) }
    return { platform: 'tiktok', username: cleanUsernameInput(rest) }
  }

  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.|music\.|gaming\.)?(?:twitch\.tv|tiktok\.com|youtube\.com|youtu\.be)\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      const host = url.hostname.toLowerCase()
      if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
        return { platform: 'twitch', username: cleanTwitchLogin(s) }
      }
      if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
        return { platform: 'youtube', username: cleanYouTubeInput(s) }
      }
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
        return { platform: 'tiktok', username: cleanUsernameInput(s) }
      }
    } catch {
      // fall through
    }
  }

  if (fallback === 'twitch') return { platform: 'twitch', username: cleanTwitchLogin(s) }
  if (fallback === 'youtube') return { platform: 'youtube', username: cleanYouTubeInput(s) }
  return { platform: 'tiktok', username: cleanUsernameInput(s) }
}
