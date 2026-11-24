import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, Loader2, Star, Clock, X, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/lib/i18n'
import { checkStream } from '@/lib/api'
import { cleanUsernameInput } from '@/lib/utils'
import {
  getHistory, addHistory, removeHistory, clearHistory,
  getFavorites, addFavorite, removeFavorite, isFavorite,
} from '@/lib/history'
import type { CheckResult } from '@/lib/types'

interface Props {
  onLoading?: () => void
  onResult?: (data: CheckResult) => void
  onError?: (msg: string) => void
  initialUsername?: string
}

export function SearchSection({ onLoading, onResult, onError, initialUsername }: Props) {
  const { t } = useI18n()
  const [username, setUsername] = useState(initialUsername || '')
  const [checking, setChecking] = useState(false)
  const [history, setHistory] = useState(getHistory())
  const [favorites, setFavorites] = useState(getFavorites())
  const autoCheckedRef = useRef<string | null>(null)
  const reqIdRef = useRef(0)

  const refreshLists = useCallback(() => {
    setHistory(getHistory())
    setFavorites(getFavorites())
  }, [])

  const doCheck = useCallback(async (targetUser?: string) => {
    const raw = (targetUser ?? username).trim()
    if (!raw) return
    const u = cleanUsernameInput(raw)
    if (!u) return
    const reqId = ++reqIdRef.current
    autoCheckedRef.current = u
    setUsername(u)
    setChecking(true)
    onLoading?.()
    try {
      const data = await checkStream(u)
      if (reqId !== reqIdRef.current) return
      addHistory(u)
      refreshLists()
      onResult?.(data)
    } catch (e) {
      if (reqId !== reqIdRef.current) return
      onError?.((e as Error).message)
    } finally {
      if (reqId === reqIdRef.current) {
        setChecking(false)
      }
    }
  }, [username, onLoading, onResult, onError, refreshLists])

  useEffect(() => {
    if (!initialUsername) return
    const normalized = cleanUsernameInput(initialUsername)
    if (!normalized || autoCheckedRef.current === normalized) return
    autoCheckedRef.current = normalized
    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) void doCheck(normalized)
    })
    return () => {
      cancelled = true
    }
  }, [initialUsername, doCheck])

  const handleToggleFav = useCallback((user: string) => {
    const u = cleanUsernameInput(user)
    if (!u) return
    if (isFavorite(u)) removeFavorite(u)
    else addFavorite(u)
    refreshLists()
  }, [refreshLists])

  const handleClearHistory = useCallback(() => {
    clearHistory()
    refreshLists()
  }, [refreshLists])

  const handleRemoveHistory = useCallback((user: string) => {
    removeHistory(user)
    refreshLists()
  }, [refreshLists])

  const cleanedInput = cleanUsernameInput(username)
  const filteredHistory = history.filter((e) => !favorites.includes(e.username))

  return (
    <Card className="border-border/80">
      <CardContent className="pt-5 space-y-3.5">
        <Label
          htmlFor="uInput"
          className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground block"
        >
          {t('usernameLabel')}
        </Label>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 flex items-center">
            <span className="absolute left-3 text-muted-foreground font-mono text-sm select-none">@</span>
            <Input
              id="uInput"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doCheck()}
              placeholder="username / tiktok.com/@user"
              autoComplete="off"
              className="pl-7 pr-9 h-10 bg-background/70 border-border focus-visible:border-primary/60 text-sm font-mono"
            />
            {cleanedInput && (
              <button
                type="button"
                onClick={() => handleToggleFav(username)}
                className="absolute right-2.5 text-muted-foreground hover:text-amber-400 transition-colors cursor-pointer p-1"
                title={isFavorite(cleanedInput) ? 'Remove from favorites' : 'Add to favorites'}
                aria-label="Toggle favorite"
              >
                <Star className={`w-4 h-4 ${isFavorite(cleanedInput) ? 'fill-amber-400 text-amber-400' : ''}`} />
              </button>
            )}
          </div>
          <Button
            onClick={() => doCheck()}
            disabled={checking || !cleanedInput}
            className="h-10 px-5 font-medium shrink-0 cursor-pointer"
          >
            {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span>{t('btnCheck')}</span>
          </Button>
        </div>

        {favorites.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400/90 mr-1">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span>{t('favorites')}</span>
            </span>
            {favorites.map((user) => (
              <div
                key={`fav-${user}`}
                className="inline-flex items-center rounded-md text-xs font-medium bg-amber-500/10 text-amber-200 border border-amber-500/25 hover:border-amber-500/45 transition-colors overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => {
                    setUsername(user)
                    void doCheck(user)
                  }}
                  className="px-2 py-1 hover:bg-amber-500/15 transition-colors cursor-pointer font-mono"
                >
                  @{user}
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleFav(user)}
                  aria-label={`Remove ${user} from favorites`}
                  className="px-1.5 py-1 text-amber-300/60 hover:text-destructive hover:bg-amber-500/15 transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {filteredHistory.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground mr-1">
              <Clock className="w-3 h-3" />
              <span>{t('recentSearch')}</span>
            </span>
            {filteredHistory.slice(0, 8).map((entry) => (
              <div
                key={`hist-${entry.username}`}
                className="inline-flex items-center rounded-md text-xs bg-secondary/70 text-foreground/85 border border-border/70 hover:border-border transition-colors overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => {
                    setUsername(entry.username)
                    void doCheck(entry.username)
                  }}
                  className="px-2 py-1 hover:bg-secondary transition-colors cursor-pointer font-mono"
                >
                  @{entry.username}
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleFav(entry.username)}
                  title="Pin to favorites"
                  aria-label={`Pin ${entry.username} to favorites`}
                  className="p-1 text-muted-foreground/70 hover:text-amber-400 transition-colors cursor-pointer"
                >
                  <Star className={`w-3 h-3 ${isFavorite(entry.username) ? 'fill-amber-400 text-amber-400' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveHistory(entry.username)}
                  aria-label={`Remove ${entry.username} from history`}
                  className="pr-1.5 pl-0.5 py-1 text-muted-foreground/60 hover:text-destructive transition-colors cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={handleClearHistory}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-destructive ml-1 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>{t('clearHistory')}</span>
            </button>
          </div>
        )}

        {favorites.length === 0 && history.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('hintText')}</p>
        )}
      </CardContent>
    </Card>
  )
}
