import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { fetchLikeStatus, toggleLike, type LikeStatus } from './portfolioLikeService'

type State = {
  likeCount: number
  isLiked: boolean
  pending: boolean
  error: string | null
  /**
   * False until the first `fetchLikeStatus` resolves (or the mediaId
   * changes back to null). Callers use this to distinguish "not yet
   * loaded — fall back to seed" from "really 0 likes" — without it a
   * post-toggle 1→0 unlike would let a stale seed-count win.
   */
  hydrated: boolean
}

const INITIAL: State = {
  likeCount: 0,
  isLiked: false,
  pending: false,
  error: null,
  hydrated: false,
}

export type UseLikeStatusResult = State & {
  toggle: () => Promise<void>
}

/**
 * React hook that tracks the like-status for a single portfolio media item
 * and keeps it cross-client-fresh via a per-item Realtime subscription.
 *
 * Strategy:
 *  - On mount / `mediaId` change: fetch the canonical status, then open a
 *    `provider_media_likes` channel filtered by `media_id` and refetch on
 *    every INSERT / DELETE we see (delta semantics, not state-merge — the
 *    INSERT row carries `id` only, not the new total, so a refetch is the
 *    cleanest authoritative read).
 *  - Cleanup is generation-guarded: a fast swipe through reels would
 *    otherwise have a stale fetch from item N–1 land after item N's setup.
 *  - `toggle()` does an optimistic mutation, calls the existing
 *    `toggleLike` service, and rolls back on failure. The Realtime echo
 *    that follows our own write is harmless — it just refetches the same
 *    state we already arrived at locally.
 *
 * Auth: a tap without an active session surfaces a German "Bitte einloggen"
 * error; the caller decides whether to redirect to the login route or
 * render the message inline.
 *
 * Returns a no-op shape when `mediaId` is null/undefined so the lightbox
 * can mount the same hook for an absent item without conditional dispatch.
 */
export function useLikeStatus(
  mediaId: string | null | undefined,
  enabled = true,
): UseLikeStatusResult {
  const [state, setState] = useState<State>(INITIAL)
  // Commit-synced mirror so toggle() can read the latest state directly — see
  // the comment in toggle() for why reading it inside a setState updater is
  // unreliable. toggle() runs from event handlers (after commit), so the ref is
  // current; toggle() also writes it optimistically before its own await.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const generationRef = useRef(0)
  const currentMediaIdRef = useRef<string | null>(null)

  useEffect(() => {
    currentMediaIdRef.current = mediaId ?? null
    if (!mediaId) {
      // Legitimate reset: dropping mediaId clears the cached like status.
      // The state IS the cache; resetting it is what this branch exists for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(INITIAL)
      return
    }
    // Viewport-gating: an off-screen reel card holds neither a Realtime channel
    // nor fires a status fetch. A populated feed would otherwise open 2 channels
    // + 2 fetches per card, growing unbounded as the user scrolls. The last
    // hydrated count is retained (no flicker) until the card returns to view.
    if (!enabled) return

    const generation = ++generationRef.current
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false

    const refresh = async () => {
      try {
        const status = await fetchLikeStatus(mediaId)
        if (cancelled || generation !== generationRef.current) return
        applyStatus(setState, status)
      } catch {
        // Transient read errors are non-blocking; we keep the last-known UI.
      }
    }

    void refresh()

    channel = supabase
      .channel(`portfolio-likes-${mediaId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'provider_media_likes',
          filter: `media_id=eq.${mediaId}`,
        },
        () => {
          void refresh()
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'provider_media_likes',
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

  const toggle = useCallback(async () => {
    const id = currentMediaIdRef.current
    if (!id) return

    // Read the pre-toggle state from a ref — NOT from inside a setState
    // updater. React runs an updater synchronously only via its eager-state
    // bailout, which it SKIPS when another setState already queued work on this
    // fiber (the caller bumps a pop-animation key right before toggling). The
    // old "capture snapshot inside the updater" pattern therefore left snapshot
    // null and returned early: the optimistic flip applied on the next render,
    // but toggleLike() never ran, so likes/unlikes never persisted.
    const prev = stateRef.current
    if (prev.pending) return // pending → a toggle is already in flight
    const fallback: State = prev
    const optimistic: State = {
      likeCount: prev.isLiked ? Math.max(0, prev.likeCount - 1) : prev.likeCount + 1,
      isLiked: !prev.isLiked,
      pending: true,
      error: null,
      // The optimistic toggle implies a baseline to count from — either fetch
      // already hydrated us, or it's a valid cold-start like. Treat as authoritative.
      hydrated: true,
    }
    // Mirror immediately so a same-tick second toggle sees pending:true.
    stateRef.current = optimistic
    setState(optimistic)

    try {
      const status = await toggleLike(id)
      // Ignore the result if the user swiped to a different item mid-flight.
      if (currentMediaIdRef.current !== id) return
      applyStatus(setState, status)
    } catch (err) {
      if (currentMediaIdRef.current !== id) return
      const message =
        err instanceof Error && err.message === 'NOT_AUTHENTICATED'
          ? 'Bitte logge dich ein, um Reels zu liken.'
          : 'Like konnte nicht gespeichert werden.'
      setState(() => ({
        likeCount: fallback.likeCount,
        isLiked: fallback.isLiked,
        pending: false,
        error: message,
        hydrated: fallback.hydrated,
      }))
    }
  }, [])

  return { ...state, toggle }
}

function applyStatus(
  setState: (updater: (s: State) => State) => void,
  status: LikeStatus,
): void {
  setState(() => ({
    likeCount: status.likeCount,
    isLiked: status.isLikedByCurrentUser,
    pending: false,
    error: null,
    hydrated: true,
  }))
}
