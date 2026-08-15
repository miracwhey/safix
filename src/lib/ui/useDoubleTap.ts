import { useCallback, useEffect, useRef } from 'react'

type Options = {
  /** Maximum interval (ms) between two taps to count as a double-tap. */
  windowMs?: number
  /**
   * Suppression window for synthetic-click after a touchend. iOS
   * WKWebView fires touchend → click ~0–500ms later; without this
   * dedupe every single-tap is registered twice and detected as a
   * double-tap. Default 600ms (covers 99 % of real devices).
   */
  ghostClickSuppressMs?: number
  /**
   * Movement (px) between touchstart and touchend above which the gesture is
   * treated as a scroll/drag, NOT a tap. Without this a vertical flick-scroll
   * that starts and ends on the target registers as a tap (e.g. toggling
   * pause on a reel mid-scroll). Default 10px.
   */
  moveThresholdPx?: number
  /**
   * Fire `onSingleTap` IMMEDIATELY on the first tap instead of deferring it by
   * `windowMs`. Use for actions that must feel instant (reel pause/play): the
   * deferred mode adds perceptible lag AND turns an impatient second tap into a
   * double-tap, so rapid taps never reach the single-tap action. In immediate
   * mode a following second tap still fires `onDoubleTap`; the caller is then
   * responsible for reconciling the already-applied single (e.g. reverting the
   * pause toggle before liking). Default false (deferred, legacy behavior).
   */
  immediateSingle?: boolean
}

type Handlers = {
  onSingleTap?: (event: { x: number; y: number }) => void
  onDoubleTap?: (event: { x: number; y: number }) => void
}

/**
 * Lightweight double-tap detector. Returns event-handler props for any
 * touch / mouse target. By default the single-tap callback is *deferred* by
 * `windowMs` so it can be cancelled if a second tap arrives — this prevents
 * the toggle-pause / open-something single-tap from firing when the user
 * really meant a double-tap-like. With `immediateSingle` the single fires at
 * once (instant pause/play) and a following second tap still fires
 * `onDoubleTap` for the caller to reconcile.
 *
 * iOS Capacitor synthetic-click guard: WKWebView dispatches a synthetic
 * `click` after every `touchend`. Without dedupe, that registers as a
 * second tap and incorrectly triggers the double-tap handler on every
 * single tap. We track `lastTouchEndAt` and skip onClick within
 * `ghostClickSuppressMs`. Mouse-only targets (desktop) keep working
 * because no touchend happened.
 */
export function useDoubleTap({ onSingleTap, onDoubleTap }: Handlers, options: Options = {}) {
  const windowMs = options.windowMs ?? 280
  const ghostMs = options.ghostClickSuppressMs ?? 600
  const moveThreshold = options.moveThresholdPx ?? 10
  const immediateSingle = options.immediateSingle ?? false
  const lastTapRef = useRef<{ at: number; x: number; y: number; consumed: boolean } | null>(null)
  const singleTimerRef = useRef<number | null>(null)
  const lastTouchEndAtRef = useRef<number>(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const cancelSingle = useCallback(() => {
    if (singleTimerRef.current !== null) {
      window.clearTimeout(singleTimerRef.current)
      singleTimerRef.current = null
    }
  }, [])

  // Clear a pending deferred single-tap timer on unmount so it never fires
  // onSingleTap on an unmounted component (stale closure / setState-after-
  // unmount). Dormant in immediateSingle mode (no timer armed), live for any
  // deferred consumer.
  useEffect(() => cancelSingle, [cancelSingle])

  const fire = useCallback(
    (x: number, y: number) => {
      const now = Date.now()
      const last = lastTapRef.current
      // Second tap inside the window → double-tap. `consumed` stops a 3rd rapid
      // tap from immediately pairing with the just-consumed second tap.
      if (last && !last.consumed && now - last.at <= windowMs) {
        cancelSingle()
        lastTapRef.current = { at: now, x, y, consumed: true }
        onDoubleTap?.({ x, y })
        return
      }
      lastTapRef.current = { at: now, x, y, consumed: false }
      if (immediateSingle) {
        // Instant feedback: no defer, no "tapped twice → nothing happened".
        onSingleTap?.({ x, y })
        return
      }
      cancelSingle()
      singleTimerRef.current = window.setTimeout(() => {
        singleTimerRef.current = null
        onSingleTap?.({ x, y })
      }, windowMs)
    },
    [cancelSingle, immediateSingle, onDoubleTap, onSingleTap, windowMs],
  )

  return {
    onTouchStart: (event: React.TouchEvent) => {
      const t = event.touches[0]
      if (t) touchStartRef.current = { x: t.clientX, y: t.clientY }
    },
    onTouchEnd: (event: React.TouchEvent) => {
      const t = event.changedTouches[0]
      if (!t) return
      lastTouchEndAtRef.current = Date.now()
      const start = touchStartRef.current
      touchStartRef.current = null
      // A flick-scroll that starts and ends on the target moved far → not a
      // tap. Bail (and keep the synthetic-click suppressed via lastTouchEndAt).
      if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > moveThreshold) {
        return
      }
      fire(t.clientX, t.clientY)
    },
    onTouchCancel: () => {
      // iOS WKWebView fires touchcancel (not touchend) when a touch turns into
      // a scroll/drag or is interrupted. Drop the pending gesture and refresh
      // the synthetic-click suppression window so a click dispatched after the
      // cancel is still deduped instead of registering as a spurious tap.
      touchStartRef.current = null
      lastTouchEndAtRef.current = Date.now()
    },
    onClick: (event: React.MouseEvent) => {
      // iOS synthetic-click guard: skip if a touchend just fired.
      if (Date.now() - lastTouchEndAtRef.current < ghostMs) return
      fire(event.clientX, event.clientY)
    },
  }
}
