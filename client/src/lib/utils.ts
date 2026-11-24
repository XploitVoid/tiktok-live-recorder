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

/**
 * Parse a username, explicit platform prefix ("twitch:name", "tiktok:@name"),
 * or channel URL ("twitch.tv/name", "tiktok.com/@name") into { platform, username }.
 */
export function parseChannelInput(
  raw: string,
  fallback: Platform = 'tiktok',
): { platform: Platform; username: string } {
  const s = raw.trim()
  if (!s) return { platform: fallback, username: '' }

  const prefixMatch = s.match(/^(twitch|tiktok):(.*)$/i)
  if (prefixMatch) {
    const plat = prefixMatch[1].toLowerCase() as Platform
    const rest = prefixMatch[2].trim()
    return plat === 'twitch'
      ? { platform: 'twitch', username: cleanTwitchLogin(rest) }
      : { platform: 'tiktok', username: cleanUsernameInput(rest) }
  }

  if (/^https?:\/\//i.test(s) || /^(?:www\.|m\.)?(?:twitch\.tv|tiktok\.com)\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      const host = url.hostname.toLowerCase()
      if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
        return { platform: 'twitch', username: cleanTwitchLogin(s) }
      }
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
        return { platform: 'tiktok', username: cleanUsernameInput(s) }
      }
    } catch {
      // fall through
    }
  }

  return fallback === 'twitch'
    ? { platform: 'twitch', username: cleanTwitchLogin(s) }
    : { platform: 'tiktok', username: cleanUsernameInput(s) }
}
