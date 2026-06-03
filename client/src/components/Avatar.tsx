import { useState } from 'react'

interface Props {
  url?: string
  name?: string
  size?: number
  className?: string
}

// Generate a stable HSL color from a string so users without avatars still get
// a recognizable colored circle with their initial.
function colorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 60%, 45%)`
}

function initialOf(name: string): string {
  if (!name) return '?'
  // Strip leading non-alphanumeric (e.g. emoji prefixes)
  const m = name.match(/[\p{L}\p{N}]/u)
  return (m ? m[0] : name[0]).toUpperCase()
}

export function Avatar({ url, name = '', size = 18, className = '' }: Props) {
  const [errored, setErrored] = useState(false)
  const showImg = url && !errored
  const px = `${size}px`

  if (showImg) {
    return (
      <img
        src={url}
        alt={name}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setErrored(true)}
        className={`rounded-full object-cover bg-zinc-700 inline-block flex-shrink-0 ${className}`}
        style={{ width: px, height: px }}
      />
    )
  }

  return (
    <span
      className={`rounded-full inline-flex items-center justify-center text-white font-semibold flex-shrink-0 ${className}`}
      style={{
        width: px,
        height: px,
        fontSize: `${Math.round(size * 0.55)}px`,
        background: colorFor(name || '?'),
      }}
      aria-label={name}
    >
      {initialOf(name)}
    </span>
  )
}
