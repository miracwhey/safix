/**
 * useThreadAutoScroll — message-thread scroll management.
 *
 * Resume-robustness Block 3 (scroll-twofer): shared by the three thread
 * screens (MessageThreadScreen, CraftsmanNachrichtenThreadScreen,
 * WorkerNachrichtenThreadScreen). Replaces two broken behaviors:
 *   • MessageThreadScreen had NO scroll management — the thread opened on
 *     whatever scroll position the container inherited, never at the latest
 *     message.
 *   • The Nachrichten screens scrollIntoView'd on EVERY messagesLength
 *     change — a realtime arrival yanked the user out of their reading
 *     position even when they had scrolled far up.
 *
 * Contract:
 *   1. First render with messages (per `threadKey`) → instant jump to the
 *      end of the thread (no smooth animation from an inherited position).
 *   2. New trailing message:
 *        – own send → always scroll (smooth); the sender expects to see
 *          their bubble.
 *        – foreign message → scroll only when the user was near the bottom
 *          BEFORE the append (threshold guard against the pre-append
 *          scrollHeight, so a tall incoming bubble can't defeat the check).
 *   3. Same trailing message re-emitted (realtime echo, temp_→server-id
 *      swap, status update) → never scroll. Dedupe keys on clientMessageId,
 *      which is stable across the optimistic→server swap
 *      (SupabaseChatRepository.ts handleRealtimeInsert/replaceOptimistic).
 *
 * The scroll container is either passed explicitly (`scrollerRef` — the
 * Nachrichten screens own a `flex-1 overflow-y-auto` div) or resolved from
 * the anchor via `closest('[data-app-scroll]')` — the AppShell inner scroll
 * container (MessageThreadScreen scrolls the whole shell).
 */

import { useEffect, useRef, type RefObject } from 'react'

/** A trailing message is "near bottom" when the gap between the pre-append
 *  content end and the visible viewport bottom is at most this many px. */
export const NEAR_BOTTOM_THRESHOLD_PX = 120

/** Minimal message shape the hook consumes — structural subset of
 *  ChatMessageViewModel (src/lib/chat/types.ts:118-138, 197-205). */
export interface AutoScrollMessage {
  id: string
  clientMessageId: string
  senderUserId: string
}

interface UseThreadAutoScrollParams {
  /** Anchor element rendered after the last message. */
  endRef: RefObject<HTMLElement | null>
  /** Explicit scroll container. When omitted, the container is resolved via
   *  `endRef.current.closest('[data-app-scroll]')` (AppShell root). */
  scrollerRef?: RefObject<HTMLElement | null>
  messages: readonly AutoScrollMessage[]
  currentUserId: string | null
  /** Reset key: the initial instant jump re-arms when this changes
   *  (thread switch without remount). */
  threadKey: string | null
}

function resolveScroller(
  anchor: HTMLElement,
  scrollerRef?: RefObject<HTMLElement | null>,
): HTMLElement | null {
  return scrollerRef?.current ?? anchor.closest<HTMLElement>('[data-app-scroll]')
}

function scrollToEnd(
  anchor: HTMLElement,
  scroller: HTMLElement | null,
  behavior: ScrollBehavior,
): void {
  if (behavior === 'auto' && scroller) {
    // Instant jump: direct scrollTop assignment is synchronous and exact —
    // it lands on the true end including trailing padding (composer space).
    scroller.scrollTop = scroller.scrollHeight
    return
  }
  anchor.scrollIntoView({ behavior, block: 'end' })
}

export function useThreadAutoScroll({
  endRef,
  scrollerRef,
  messages,
  currentUserId,
  threadKey,
}: UseThreadAutoScrollParams): void {
  const didInitialScrollRef = useRef(false)
  const lastHandledKeyRef = useRef<string | null>(null)
  // scrollHeight as of the previous messages-effect run — the near-bottom
  // check measures against the PRE-append layout so the height of the new
  // bubble itself can't push the user outside the threshold.
  const prevScrollHeightRef = useRef<number | null>(null)

  useEffect(() => {
    didInitialScrollRef.current = false
    lastHandledKeyRef.current = null
    prevScrollHeightRef.current = null
  }, [threadKey])

  useEffect(() => {
    if (messages.length === 0) return
    const anchor = endRef.current
    if (!anchor) return
    const scroller = resolveScroller(anchor, scrollerRef)
    const last = messages[messages.length - 1]
    // clientMessageId is stable across the temp_→server-id swap; fall back to
    // id for rows where the runtime value is absent (server system messages).
    const lastKey = last.clientMessageId ?? last.id

    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true
      lastHandledKeyRef.current = lastKey
      scrollToEnd(anchor, scroller, 'auto')
      prevScrollHeightRef.current = scroller?.scrollHeight ?? null
      return
    }

    if (lastHandledKeyRef.current === lastKey) {
      // Echo / swap / status tick of the message we already handled — keep
      // the reading position, only refresh the layout baseline.
      prevScrollHeightRef.current = scroller?.scrollHeight ?? prevScrollHeightRef.current
      return
    }
    lastHandledKeyRef.current = lastKey

    const isOwnSend = currentUserId !== null && last.senderUserId === currentUserId
    let nearBottom = true
    if (scroller) {
      const referenceHeight = prevScrollHeightRef.current ?? scroller.scrollHeight
      const distance = referenceHeight - scroller.scrollTop - scroller.clientHeight
      nearBottom = distance <= NEAR_BOTTOM_THRESHOLD_PX
    }
    prevScrollHeightRef.current = scroller?.scrollHeight ?? null

    if (isOwnSend || nearBottom) {
      scrollToEnd(anchor, scroller, 'smooth')
    }
  }, [messages, currentUserId, endRef, scrollerRef])
}
