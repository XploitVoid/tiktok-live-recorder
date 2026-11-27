// lib/chatHighlight.ts — Manage chat highlight keywords stored in localStorage.

const KEYWORDS_KEY = 'tiktok_chat_keywords'

export function getKeywords(): string[] {
  try {
    const raw = localStorage.getItem(KEYWORDS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const norm = item.trim().toLowerCase()
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    }
    return out
  } catch {
    return []
  }
}

export function addKeyword(word: string): void {
  const w = word.trim().toLowerCase()
  if (!w) return
  const list = getKeywords().filter((k) => k !== w)
  list.unshift(w)
  try { localStorage.setItem(KEYWORDS_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

export function removeKeyword(word: string): void {
  const w = word.trim().toLowerCase()
  if (!w) return
  const list = getKeywords().filter((k) => k !== w)
  try { localStorage.setItem(KEYWORDS_KEY, JSON.stringify(list)) } catch { /* ignore */ }
}

export function clearKeywords(): void {
  try { localStorage.removeItem(KEYWORDS_KEY) } catch { /* ignore */ }
}

/** Check if text contains any keyword. Returns matched keywords. */
export function findMatches(text: string, keywords: string[]): string[] {
  if (!text || !keywords.length) return []
  const lower = text.toLowerCase()
  return keywords.filter((k) => !!k && lower.includes(k))
}
