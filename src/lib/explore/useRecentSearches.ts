/**
 * Recent-search history backed by localStorage.
 *
 * - cap 6, most-recent-first, case-insensitive dedupe
 * - fully guarded: any storage failure (private mode / quota / SSR) degrades to
 *   an in-memory no-op rather than throwing.
 */

import { useCallback, useState } from 'react'

const STORAGE_KEY = 'fixup.search.recent'
const CAP = 6

function readStore(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, CAP)
  } catch {
    return []
  }
}

function writeStore(list: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* ignore: storage unavailable / quota exceeded */
  }
}

export function useRecentSearches(): {
  recent: string[]
  push: (query: string) => void
  clear: () => void
} {
  const [recent, setRecent] = useState<string[]>(readStore)

  const push = useCallback((query: string) => {
    const value = query.trim()
    if (!value) return
    setRecent((prev) => {
      const next = [value, ...prev.filter((x) => x.toLowerCase() !== value.toLowerCase())].slice(0, CAP)
      writeStore(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setRecent([])
    writeStore([])
  }, [])

  return { recent, push, clear }
}
