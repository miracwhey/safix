import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import {
  fetchSaveStatus,
  setSaveFolder as setSaveFolderApi,
  toggleSave,
  unsave as unsaveApi,
  type SaveStatus,
} from './portfolioSaveService'

type State = {
  saveCount: number
  isSaved: boolean
  /** Folder the save sits in. null = default folder OR not saved. */
  folderId: string | null
  pending: boolean
  error: string | null
  /**
   * False until the first `fetchSaveStatus` resolves (or `mediaId` flips to
   * null). Distinguishes "not yet hydrated — fall back to the seed" from
   * "really 0 saves" so a post-toggle 1→0 unsave can't lose to a stale seed.
   */
  hydrated: boolean
}

const INITIAL: State = {
  saveCount: 0,
  isSaved: false,
  folderId: null,
  pending: false,
  error: null,
  hydrated: false,
}

export type UseSaveStatusResult = State & {
  /**
   * Toggles save state. `folderId` is honoured only on transition to
   * "saved" (insert) — does not relocate an existing save. Use
   * `saveToFolder` to assign or move.
   */
  toggle: (folderId?: string | null) => Promise<void>
  /**
   * Insert-or-update the save into the given folder. null = default. Resolves
   * `true` when the write succeeded and `false` when it failed (the hook has
   * already rolled the optimistic state back) — callers gate their success /
   * error toast on this so they never claim "saved" after a failed write.
   */
  saveToFolder: (folderId: string | null) => Promise<boolean>
  /** Unconditionally remove the save. Resolves `false` on a failed write. */
  unsave: () => Promise<boolean>
}

/**
 * React hook that tracks the save (bookmark) status for a single portfolio
 * media item and keeps it cross-client-fresh via a per-item Realtime
 * subscription. Twin of `useLikeStatus`, with folder-aware extensions.
 *
 * Strategy:
 *  - On mount / `mediaId` change: fetch the canonical status, then open a
 *    `provider_media_saves` channel filtered by `media_id` and refetch on
 *    every INSERT / UPDATE / DELETE we see.
 *  - Cleanup is generation-guarded against fast swipes through reels.
 *  - `toggle()` does an optimistic mutation, calls `toggleSave`, and rolls
 *    back on failure. The Realtime echo of our own write is harmless.
 *  - `saveToFolder(id)` is the long-press path: sets folder explicitly.
 *  - `unsave()` is the explicit removal path (used by the Sheet).
 *
 * Auth: tapping save without an active session surfaces a German login
 * prompt; the caller decides whether to redirect or render inline.
 *
 * Returns a no-op shape when `mediaId` is null/undefined.
 */
export function useSaveStatus(
  mediaId: string | null | undefined,
  enabled = true,
): UseSaveStatusResult {
  const [state, setState] = useState<State>(INITIAL)
  // Commit-synced mirror so the mutation paths can read the latest state
  // directly instead of from a setState updater (which React only runs
  // synchronously via its eager-state bailout — skipped when another setState
  // already queued work on this fiber, e.g. the caller bumps a pop-key first).
  // The mutation paths run from event handlers (after commit) and also write
  // this ref optimistically before their own await, so it stays current.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const generationRef = useRef(0)
  const currentMediaIdRef = useRef<string | null>(null)

  useEffect(() => {
    currentMediaIdRef.current = mediaId ?? null
    if (!mediaId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(INITIAL)
      return
    }
    // Viewport-gating (see useLikeStatus): off-screen cards hold no channel +
    // fire no fetch, so a scrolled feed doesn't accumulate per-card subscriptions.
    if (!enabled) return

    const generation = ++generationRef.current
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false

    const refresh = async () => {
      try {
        const status = await fetchSaveStatus(mediaId)
        if (cancelled || generation !== generationRef.current) return
        applyStatus(setState, status)
      } catch {
        // Transient read errors are non-blocking; keep the last-known UI.
      }
    }

    void refresh()

    channel = supabase
      .channel(`portfolio-saves-${mediaId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'provider_media_saves',
          filter: `media_id=eq.${mediaId}`,
        },
        () => {
          void refresh()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [mediaId, enabled])

  const toggle = useCallback(async (folderId: string | null = null) => {
    const id = currentMediaIdRef.current
    if (!id) return

    // Read from the ref, not a setState updater — the updater only runs
    // synchronously via React's eager-state bailout, which is skipped when the
    // caller already queued a setState (the bookmark pop-key) on this fiber.
    // That silently dropped toggleSave(): the bookmark flipped optimistically
    // but no row was written, so saved reels never surfaced.
    const prev = stateRef.current
    if (prev.pending) return
    const fallback: State = prev
    const willBeSaved = !prev.isSaved
    const optimistic: State = {
      saveCount: willBeSaved ? prev.saveCount + 1 : Math.max(0, prev.saveCount - 1),
      isSaved: willBeSaved,
      folderId: willBeSaved ? folderId : null,
      pending: true,
      error: null,
      hydrated: true,
    }
    stateRef.current = optimistic
    setState(optimistic)

    try {
      const status = await toggleSave(id, folderId)
      if (currentMediaIdRef.current !== id) return
      applyStatus(setState, status)
    } catch (err) {
      if (currentMediaIdRef.current !== id) return
      const message =
        err instanceof Error && err.message === 'NOT_AUTHENTICATED'
          ? 'Bitte logge dich ein, um Reels zu speichern.'
          : 'Reel konnte nicht gespeichert werden.'
      setState(() => ({
        saveCount: fallback.saveCount,
        isSaved: fallback.isSaved,
        folderId: fallback.folderId,
        pending: false,
        error: message,
        hydrated: fallback.hydrated,
      }))
    }
  }, [])

  const saveToFolder = useCallback(async (folderId: string | null): Promise<boolean> => {
    const id = currentMediaIdRef.current
    if (!id) return false

    const prev = stateRef.current
    if (prev.pending) return false
    const fallback: State = prev
    const optimistic: State = {
      saveCount: prev.isSaved ? prev.saveCount : prev.saveCount + 1,
      isSaved: true,
      folderId,
      pending: true,
      error: null,
      hydrated: true,
    }
    stateRef.current = optimistic
    setState(optimistic)

    try {
      const status = await setSaveFolderApi(id, folderId)
      // The write succeeded even if the user swiped to another reel mid-flight
      // (just skip the now-stale state update); report success either way.
      if (currentMediaIdRef.current === id) applyStatus(setState, status)
      return true
    } catch (err) {
      if (currentMediaIdRef.current === id) {
        const message =
          err instanceof Error && err.message === 'NOT_AUTHENTICATED'
            ? 'Bitte logge dich ein, um Reels zu speichern.'
            : 'Reel konnte nicht gespeichert werden.'
        setState(() => ({
          saveCount: fallback.saveCount,
          isSaved: fallback.isSaved,
          folderId: fallback.folderId,
          pending: false,
          error: message,
          hydrated: fallback.hydrated,
        }))
      }
      return false
    }
  }, [])

  const unsave = useCallback(async (): Promise<boolean> => {
    const id = currentMediaIdRef.current
    if (!id) return false

    const prev = stateRef.current
    if (prev.pending) return false
    const fallback: State = prev
    const optimistic: State = {
      saveCount: Math.max(0, prev.saveCount - (prev.isSaved ? 1 : 0)),
      isSaved: false,
      folderId: null,
      pending: true,
      error: null,
      hydrated: true,
    }
    stateRef.current = optimistic
    setState(optimistic)

    try {
      const status = await unsaveApi(id)
      if (currentMediaIdRef.current === id) applyStatus(setState, status)
      return true
    } catch (err) {
      if (currentMediaIdRef.current === id) {
        const message =
          err instanceof Error && err.message === 'NOT_AUTHENTICATED'
            ? 'Bitte logge dich ein, um Reels zu speichern.'
            : 'Reel konnte nicht entfernt werden.'
        setState(() => ({
          saveCount: fallback.saveCount,
          isSaved: fallback.isSaved,
          folderId: fallback.folderId,
          pending: false,
          error: message,
          hydrated: fallback.hydrated,
        }))
      }
      return false
    }
  }, [])

  return { ...state, toggle, saveToFolder, unsave }
}

function applyStatus(
  setState: (updater: (s: State) => State) => void,
  status: SaveStatus,
): void {
  setState(() => ({
    saveCount: status.saveCount,
    isSaved: status.isSavedByCurrentUser,
    folderId: status.folderId,
    pending: false,
    error: null,
    hydrated: true,
  }))
}
