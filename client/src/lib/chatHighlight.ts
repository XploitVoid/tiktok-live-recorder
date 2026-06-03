// lib/chatHighlight.ts — Manage chat highlight keywords stored in localStorage.

const KEYWORDS_KEY = 'tiktok_chat_keywords'

export function getKeywords(): string[] {
  try {
    const raw = localStorage.getItem(KEYWORDS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

export function addKeyword(word: string): void {
  const w = word.trim().toLowerCase()
  if (!w) return
  const list = getKeywords().filter((k) => k !== w)
  list.unshift(w)
  localStorage.setItem(KEYWORDS_KEY, JSON.stringify(list))
}

export function removeKeyword(word: string): void {
  const list = getKeywords().filter((k) => k !== word)
  localStorage.setItem(KEYWORDS_KEY, JSON.stringify(list))
}

export function clearKeywords(): void {
  localStorage.removeItem(KEYWORDS_KEY)
}

/** Check if text contains any keyword. Returns matched keywords. */
export function findMatches(text: string, keywords: string[]): string[] {
  if (!text || !keywords.length) return []
  const lower = text.toLowerCase()
  return keywords.filter((k) => lower.includes(k))
}
