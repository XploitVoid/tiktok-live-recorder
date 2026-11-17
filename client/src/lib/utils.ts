import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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
