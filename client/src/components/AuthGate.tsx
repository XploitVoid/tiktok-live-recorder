import { useEffect, useState } from 'react'
import { Lock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { getAuthStatus, loginWithToken, UNAUTHORIZED_EVENT } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<'loading' | 'ok' | 'locked'>('loading')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    getAuthStatus()
      .then((s) => {
        if (!active) return
        setStatus(!s.authRequired || s.authenticated ? 'ok' : 'locked')
      })
      .catch(() => {
        if (active) setStatus('ok')
      })
    const onUnauth = () => {
      setStatus('locked')
      setError('')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauth)
    return () => {
      active = false
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauth)
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await loginWithToken(token.trim())
      setToken('')
      setStatus('ok')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authInvalid'))
    } finally {
      setSubmitting(false)
    }
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        {t('loading')}
      </div>
    )
  }

  if (status === 'locked') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-sm border-border">
          <CardHeader className="space-y-1.5">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center text-primary">
                <Lock className="w-4 h-4" />
              </div>
              <CardTitle className="text-base">{t('authTitle')}</CardTitle>
            </div>
            <CardDescription className="text-xs leading-relaxed">
              {t('authDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-3">
              <Input
                type="password"
                autoFocus
                placeholder={t('authPlaceholder')}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={submitting}
              />
              {error && <div className="text-xs text-destructive">{error}</div>}
              <Button type="submit" className="w-full" disabled={submitting || !token.trim()}>
                {submitting ? t('authChecking') : t('authSubmit')}
              </Button>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('authHint')}
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
