import { useMemo } from 'react'

interface Props {
  text: string
  keywords: string[]
  className?: string
}

/** Renders text with keyword matches highlighted in yellow. */
export function HighlightText({ text, keywords, className }: Props) {
  const parts = useMemo(() => {
    if (!keywords.length || !text) return [{ text, match: false }]
    // Build a regex that matches any keyword (case-insensitive)
    const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const re = new RegExp(`(${escaped.join('|')})`, 'gi')
    const result: { text: string; match: boolean }[] = []
    let last = 0
    for (const m of text.matchAll(re)) {
      if (m.index! > last) result.push({ text: text.slice(last, m.index!), match: false })
      result.push({ text: m[0], match: true })
      last = m.index! + m[0].length
    }
    if (last < text.length) result.push({ text: text.slice(last), match: false })
    return result
  }, [text, keywords])

  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-amber-400/30 text-amber-200 rounded-sm px-0.5">{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  )
}
