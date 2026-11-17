import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ConfirmButtonProps {
  onConfirm: () => void | Promise<void>
  children: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  title?: string
  ariaLabel?: string
  disabled?: boolean
  size?: 'xs' | 'sm' | 'default' | 'icon' | 'icon-xs' | 'icon-sm'
  variant?: 'ghost' | 'destructive' | 'outline' | 'secondary'
  className?: string
}

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  title,
  ariaLabel,
  disabled,
  size = 'xs',
  variant = 'ghost',
  className = '',
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmed(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [armed])

  if (armed) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1 py-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setArmed(false)
            void onConfirm()
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors cursor-pointer"
          aria-label={confirmLabel}
        >
          <Check className="w-3 h-3" />
          <span>{confirmLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="inline-flex items-center justify-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
          aria-label={cancelLabel}
          title={cancelLabel}
        >
          <X className="w-3 h-3" />
        </button>
      </span>
    )
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel || title}
      onClick={(e) => {
        e.stopPropagation()
        setArmed(true)
      }}
      className={className}
    >
      {children}
    </Button>
  )
}
