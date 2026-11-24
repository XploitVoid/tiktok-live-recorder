import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, Loader2, Star, Clock, X, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/lib/i18n'
import { checkStream } from '@/lib/api'
import { parseChannelInput, normalizePlatform } from '@/lib/utils'
import { PlatformBadge, PlatformSwitch } from '@/components/PlatformBadge'
import {
  getHistory, addHistory, removeHistory, clearHistory,
  getFavorites, addFavorite, removeFavorite, isFavorite,
} from '@/lib/history'
import type { CheckResult, Platform } from '@/lib/types'

interface Props {
  onLoading?: () => void
  onResult?: (data: CheckResult) => void
  onError?: (msg: string) => void
  initialUsername?: string
  initialPlatform?: Platform
}

export function SearchSection({ onLoading, onResult, onError, initialUsername, initialPlatform }: Props) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState<Platform>(initialPlatform || 'tiktok')
  const [username, setUsername] = useState(initialUsername || '')
  const [checking, setChecking] = useState(false)
  const [history, setHistory] = useState(getHistory())
  const [favorites, setFavorites] = useState(getFavorites())
  const lastInitialRef = useRef<string | null>(null)
  const lastCheckedRef = useRef<string | null>(null)
  const reqIdRef = useRef(0)

  const refreshLists = useCallback(() => {
    setHistory(getHistory())
    setFavorites(getFavorites())
  }, [])

  const runCheck = useCallback(async (rawInput: string, overridePlatform?: Platform) => {
    const raw = rawInput.trim()
    if (!raw) return
    const parsed = parseChannelInput(raw, overridePlatform ?? platform)
    if (!parsed.username) return
    const reqId = ++reqIdRef.current
    lastCheckedRef.current = `${parsed.platform}:${parsed.username}`
    setPlatform(parsed.platform)
    setUsername(parsed.username)
    setChecking(true)
    onLoading?.()
    try {
      const data = await checkStream(parsed.username, parsed.platform)
      if (reqId !== reqIdRef.current) return
      addHistory(parsed.username, parsed.platform)
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
  }, [onLoading, onResult, onError, platform, refreshLists])

  const handleCheck = useCallback(() => {
    void runCheck(username)
  }, [runCheck, username])

  const runCheckRef = useRef(runCheck)
  useEffect(() => {
    runCheckRef.current = runCheck
  }, [runCheck])

  useEffect(() => {
    const targetPlat = normalizePlatform(initialPlatform)
    const parsed = initialUsername ? parseChannelInput(initialUsername, targetPlat) : null
    const normalized = parsed?.username || null
    const initialKey = normalized ? `${parsed!.platform}:${normalized}` : null
    if (!initialKey || !normalized) {
      lastInitialRef.current = null
      return
    }
    if (lastInitialRef.current === initialKey) return
    if (lastCheckedRef.current === initialKey) {
      lastInitialRef.current = initialKey
      return
    }
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      lastInitialRef.current = initialKey
      void runCheckRef.current(normalized, parsed!.platform)
    })
    return () => {
      cancelled = true
    }
  }, [initialUsername, initialPlatform])

  const handleToggleFav = useCallback((user: string, overridePlatform?: Platform) => {
    const parsed = parseChannelInput(user, overridePlatform ?? platform)
    if (!parsed.username) return
    if (isFavorite(parsed.username, parsed.platform)) {
      removeFavorite(parsed.username, parsed.platform)
    } else {
      addFavorite(parsed.username, parsed.platform)
    }
    refreshLists()
  }, [platform, refreshLists])

  const handleClearHistory = useCallback(() => {
    clearHistory()
    refreshLists()
  }, [refreshLists])

  const handleRemoveHistory = useCallback((user: string, plat: Platform) => {
    removeHistory(user, plat)
    refreshLists()
  }, [refreshLists])

  const parsedInput = parseChannelInput(username, platform)
  const cleanedInput = parsedInput.username
  const inputIsFav = !!cleanedInput && isFavorite(cleanedInput, parsedInput.platform)
  const normEntryKey = (p: Platform, u: string) => {
    if (p === 'twitch') return `twitch:${u.toLowerCase()}`
    if (p === 'youtube') return `youtube:${/^v_|^UC/.test(u) ? u : u.toLowerCase()}`
    return `tiktok:${u}`
  }
  const favKeys = new Set(favorites.map((f) => normEntryKey(f.platform, f.username)))
  const filteredHistory = history.filter((e) => !favKeys.has(normEntryKey(e.platform, e.username)))

  const handleInputChange = (val: string) => {
    setUsername(val)
    if (/^(?:twitch|tiktok|youtube|yt):/i.test(val.trim()) || /(?:twitch\.tv|tiktok\.com|youtube\.com|youtu\.be)\//i.test(val)) {
      const detected = parseChannelInput(val, platform)
      if (detected.platform !== platform) setPlatform(detected.platform)
    }
  }

  return (
    <Card className="border-border/80">
      <CardContent className="pt-5 space-y-3.5">
        <Label
          htmlFor="uInput"
          className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground block"
        >
          {platform !== 'tiktok' ? t('usernameLabelMulti') : t('usernameLabel')}
        </Label>

        <div className="flex flex-col sm:flex-row gap-2">
          <PlatformSwitch value={platform} onChange={setPlatform} size="md" />
          <div className="relative flex-1 flex items-center">
            <span className="absolute left-3 text-muted-foreground font-mono text-sm select-none">@</span>
            <Input
              id="uInput"
              value={username}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
              placeholder={t('searchPlaceholderMulti')}
              autoComplete="off"
              className="pl-7 pr-9 h-10 bg-background/70 border-border focus-visible:border-primary/60 text-sm font-mono"
            />
            {cleanedInput && (
              <button
                type="button"
                onClick={() => handleToggleFav(username)}
                className="absolute right-2.5 text-muted-foreground hover:text-amber-400 transition-colors cursor-pointer p-1"
                title={inputIsFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-label="Toggle favorite"
              >
                <Star className={`w-4 h-4 ${inputIsFav ? 'fill-amber-400 text-amber-400' : ''}`} />
              </button>
            )}
          </div>
          <Button
            onClick={handleCheck}
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
            {favorites.map((fav) => (
              <div
                key={`fav-${fav.platform}:${fav.username}`}
                className="inline-flex items-center rounded-md text-xs font-medium bg-amber-500/10 text-amber-200 border border-amber-500/25 hover:border-amber-500/45 transition-colors overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => void runCheck(fav.username, fav.platform)}
                  className="inline-flex items-center gap-1 px-2 py-1 hover:bg-amber-500/15 transition-colors cursor-pointer font-mono"
                >
                  {fav.platform !== 'tiktok' && <PlatformBadge platform={fav.platform} className="text-[9px] px-1 py-0" />}
                  <span>@{fav.username}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleFav(fav.username, fav.platform)}
                  aria-label={`Remove ${fav.username} from favorites`}
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
                key={`hist-${entry.platform}:${entry.username}`}
                className="inline-flex items-center rounded-md text-xs bg-secondary/70 text-foreground/85 border border-border/70 hover:border-border transition-colors overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => void runCheck(entry.username, entry.platform)}
                  className="inline-flex items-center gap-1 px-2 py-1 hover:bg-secondary transition-colors cursor-pointer font-mono"
                >
                  {entry.platform !== 'tiktok' && <PlatformBadge platform={entry.platform} className="text-[9px] px-1 py-0" />}
                  <span>@{entry.username}</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleFav(entry.username, entry.platform)}
                  title="Pin to favorites"
                  aria-label={`Pin ${entry.username} to favorites`}
                  className="p-1 text-muted-foreground/70 hover:text-amber-400 transition-colors cursor-pointer"
                >
                  <Star className={`w-3 h-3 ${isFavorite(entry.username, entry.platform) ? 'fill-amber-400 text-amber-400' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveHistory(entry.username, entry.platform)}
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
