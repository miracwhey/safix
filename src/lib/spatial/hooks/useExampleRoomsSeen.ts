/**
 * Spatial · V1.6.1 · Persisted "Beispiel-Raum gesehen" tracker.
 *
 * Mirrors `useSpatialFirstRunFlag` (Phase 4) but tracks a SET of kinds per
 * customer instead of a single boolean. We persist the set as a JSON-encoded
 * array under one localStorage key so adding a future "Schlafzimmer"-tile is
 * a one-line additon without a new flag.
 *
 * The NEW dot on the picker tiles is the ONLY UI consumer today:
 *   - First mount → every kind unseen → 3 NEW dots show.
 *   - Customer opens the Bad-tile → bath kind is added to the set →
 *     subsequent renders mark bath as seen, dot disappears.
 *   - Cross-tab sync via storage events mirrors `useSpatialFirstRunFlag`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ExampleRoomKind } from '../canonical/presets/exampleRooms'

const STORAGE_KEY = 'spatial-customer-example-rooms-seen-v1'

export interface UseExampleRoomsSeenApi {
  /** Seen-set — `O(1)` lookup so the picker can pass the negation to its tiles. */
  seen: ReadonlySet<ExampleRoomKind>
  /** Persist `kind` as seen + flip the local state. Idempotent. */
  markSeen: (kind: ExampleRoomKind) => void
  /** Convenience helper: kinds that have NOT been seen yet (drives NEW-dot). */
  unseenKinds: ReadonlySet<ExampleRoomKind>
}

const ALL_KINDS: readonly ExampleRoomKind[] = ['bath', 'kitchen', 'living']

function readSet(): Set<ExampleRoomKind> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    const out = new Set<ExampleRoomKind>()
    for (const v of parsed) {
      if (v === 'bath' || v === 'kitchen' || v === 'living') out.add(v)
    }
    return out
  } catch {
    return new Set()
  }
}

function writeSet(set: Set<ExampleRoomKind>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    // Quota / private-mode failures are silent — the local state still
    // flips so the user's current session reflects their actions.
  }
}

export function useExampleRoomsSeen(): UseExampleRoomsSeenApi {
  const [seen, setSeen] = useState<Set<ExampleRoomKind>>(readSet)

  // Cross-tab sync: when another tab updates the storage entry, mirror it
  // here so the NEW dot does not re-appear after navigating across tabs.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return
      setSeen(readSet())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const markSeen = useCallback((kind: ExampleRoomKind) => {
    setSeen(prev => {
      if (prev.has(kind)) return prev
      const next = new Set(prev)
      next.add(kind)
      writeSet(next)
      return next
    })
  }, [])

  const unseenKinds = useMemo(() => {
    const out = new Set<ExampleRoomKind>()
    for (const k of ALL_KINDS) {
      if (!seen.has(k)) out.add(k)
    }
    return out
  }, [seen])

  return { seen, markSeen, unseenKinds }
}
