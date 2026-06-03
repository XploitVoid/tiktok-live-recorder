import { useState, useCallback } from 'react'
import { Search, Loader2, Star, Clock, X, Trash2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/lib/i18n'
import { checkStream } from '@/lib/api'
import {
  getHistory, addHistory, removeHistory, clearHistory,
  getFavorites, addFavorite, removeFavorite, isFavorite,
} from '@/lib/history'
import type { CheckResult } from '@/lib/types'

interface Props {
  onLoading?: () => void
  onResult: (data: CheckResult) => void
  onError: (err: string) => void
  initialUsername?: string
}

export function SearchSection({ onLoading, onResult, onError, initialUsername }: Props) {
  const { t } = useI18n()
  const [username, setUsername] = useState(initialUsername || '')
  const [loading, setLoading] = useState(false)
  const [favorites, setFavorites] = useState(getFavorites())
  const [history, setHistory] = useState(getHistory())

  const refreshLists = useCallback(() => {
    setFavorites(getFavorites())
    setHistory(getHistory())
  }, [])

  const doCheck = useCallback(async (overrideUser?: string) => {
    const u = (overrideUser || username).trim().replace(/^@/, '')
    if (!u) return
    setLoading(true)
    onLoading?.()
    try {
      const data = await checkStream(u)
      addHistory(u)
      refreshLists()
      if (overrideUser) setUsername(u)
      onResult(data)
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [username, onLoading, onResult, onError, refreshLists])

  const toggleFavorite = useCallback((user: string) => {
    if (isFavorite(user)) {
      removeFavorite(user)
    } else {
      addFavorite(user)
    }
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

  // Filter history to exclude items already in favorites
  const filteredHistory = history.filter((e) => !favorites.includes(e.username))

  return (
    <Card>
      <CardContent className="pt-5">
        <Label className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2 block">
          {t('usernameLabel')}
        </Label>
        <div className="flex gap-2">
          <div className="flex flex-1 items-center bg-secondary rounded-lg overflow-hidden border border-border focus-within:border-primary/70 focus-within:ring-2 ring-primary/30 transition">
            <span className="inline-flex items-center px-3 text-muted-foreground font-medium">@</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doCheck()}
              placeholder="tv_asahi_news"
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 px-1"
              autoComplete="off"
              spellCheck={false}
            />
            {username && (
              <button
                onClick={() => toggleFavorite(username.trim().replace(/^@/, ''))}
                className="px-2 text-muted-foreground hover:text-amber-400 transition-colors"
                title={isFavorite(username.trim().replace(/^@/, '')) ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star className={`w-4 h-4 ${isFavorite(username.trim().replace(/^@/, '')) ? 'fill-amber-400 text-amber-400' : ''}`} />
              </button>
            )}
          </div>
          <Button
            onClick={() => doCheck()}
            disabled={loading}
            className="bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-500 hover:to-rose-500 text-white shadow-lg shadow-pink-600/20 border-0"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4 mr-1.5" />}
            {t('btnCheck')}
          </Button>
        </div>

        {/* Favorites — always visible chips */}
        {favorites.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-3">
            <span className="text-[10px] uppercase tracking-wider text-amber-400/70 font-semibold flex items-center gap-1">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              {t('favorites')}
            </span>
            {favorites.map((user) => (
              <button
                key={`fav-${user}`}
                onClick={() => { setUsername(user); doCheck(user) }}
                className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20 hover:border-amber-500/40 transition-all"
              >
                @{user}
                <span
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(user) }}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity ml-0.5"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Recent searches — always visible chips */}
        {filteredHistory.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {t('recentSearch')}
            </span>
            {filteredHistory.slice(0, 8).map((entry) => (
              <button
                key={`hist-${entry.username}`}
                onClick={() => { setUsername(entry.username); doCheck(entry.username) }}
                className="group inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 hover:bg-zinc-700/50 hover:border-zinc-600 transition-all"
              >
                @{entry.username}
                <span
                  onClick={(e) => { e.stopPropagation(); toggleFavorite(entry.username) }}
                  className="opacity-0 group-hover:opacity-100 hover:text-amber-400 transition-opacity"
                  title="Add to favorites"
                >
                  <Star className={`w-3 h-3 ${isFavorite(entry.username) ? 'fill-amber-400 text-amber-400' : ''}`} />
                </span>
                <span
                  onClick={(e) => { e.stopPropagation(); handleRemoveHistory(entry.username) }}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            ))}
            <button
              onClick={handleClearHistory}
              className="inline-flex items-center gap-0.5 px-2 py-1 rounded-full text-[10px] text-zinc-500 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-2.5 h-2.5" /> {t('clearHistory')}
            </button>
          </div>
        )}

        {favorites.length === 0 && history.length === 0 && (
          <p className="text-xs text-muted-foreground mt-2">{t('hintText')}</p>
        )}
      </CardContent>
    </Card>
  )
}
