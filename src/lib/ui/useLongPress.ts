import { useCallback, useEffect, useRef } from 'react'

type Options = {
  /** Threshold in ms before a press counts as long-press. Default 380. */
  thresholdMs?: number
  /** Movement (px) that cancels the long-press. Default 8. */
  moveTolerancePx?: number
  /**
   * When true the TAP is NOT handled here — the element wires its own `onClick`
   * for the tap (robust on a scroll-snap feed, where `touchcancel` would
   * otherwise drop a custom onTap). This hook then only detects the long-press
   * and suppresses the synthetic click that would follow one. Default false
   * (the hook owns the tap, legacy behavior).
   */
  clickDrivenTap?: boolean
}

type Handlers = {
  onTap?: () => void
  onLongPress: () => void
}

/**
 * Tiny long-press helper. Returns event-handler props for a button-like
 * element. Calls `onLongPress` if the user holds for `thresholdMs`
 * without moving more than `moveTolerancePx`. Otherwise calls `onTap`
 * on release.
 *
 * Notes:
 *  - We DO NOT call onTap when onLongPress fires — long-press is the
 *    sole action. This matches Instagram / TikTok bookmark long-press.
 *  - Touch + mouse paths supported. PointerEvents would be cleaner but
 *    iOS WKWebView still has edge cases that touch-events sidestep.
 *  - Gesture cancellation on scroll is NOT explicitly handled — the
 *    `moveTolerancePx` already filters most accidental triggers, and
 *    the sheet open is reversible by tapping the backdrop.
 */
export function useLongPress({ onTap, onLongPress }: Handlers, options: Options = {}) {
  const thresholdMs = options.thresholdMs ?? 380
  const moveTolerancePx = options.moveTolerancePx ?? 8
  const clickDrivenTap = options.clickDrivenTap ?? false

  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const longFiredRef = useRef<boolean>(false)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => clear(), [clear])

  const begin = useCallback(
    (x: number, y: number) => {
      clear()
      longFiredRef.current = false
      startedAtRef.current = Date.now()
      startPosRef.current = { x, y }
      timerRef.current = window.setTimeout(() => {
        longFiredRef.current = true
        onLongPress()
      }, thresholdMs)
    },
    [clear, onLongPress, thresholdMs],
  )

  const move = useCallback(
    (x: number, y: number) => {
      const start = startPosRef.current
      if (!start) return
      if (Math.abs(x - start.x) > moveTolerancePx || Math.abs(y - start.y) > moveTolerancePx) {
        clear()
      }
    },
    [clear, moveTolerancePx],
  )

  const end = useCallback(() => {
    clear()
    if (longFiredRef.current) {
      longFiredRef.current = false
      return
    }
    if (!clickDrivenTap) onTap?.()
  }, [clear, onTap, clickDrivenTap])

  const cancel = useCallback(() => {
    clear()
    longFiredRef.current = false
  }, [clear])

  return {
    onTouchStart: (event: React.TouchEvent) => {
      const t = event.touches[0]
      if (!t) return
      begin(t.clientX, t.clientY)
    },
    onTouchMove: (event: React.TouchEvent) => {
      const t = event.touches[0]
      if (!t) return
      move(t.clientX, t.clientY)
    },
    onTouchEnd: (event: React.TouchEvent) => {
      if (clickDrivenTap) {
        // The element's own onClick handles the tap. Only suppress the
        // synthetic click AFTER a long-press fired so it doesn't double-act.
        clear()
        if (longFiredRef.current) {
          event.preventDefault()
          longFiredRef.current = false
        }
        return
      }
      event.preventDefault() // suppress synthetic click that would fire onTap twice
      end()
    },
    onTouchCancel: cancel,
    // Mouse / desktop fallback. We don't use onClick to avoid the
    // duplicate-fire problem — onMouseUp gives us the symmetry of touch.
    onMouseDown: (event: React.MouseEvent) => begin(event.clientX, event.clientY),
    onMouseMove: (event: React.MouseEvent) => move(event.clientX, event.clientY),
    onMouseUp: () => end(),
    onMouseLeave: cancel,
    // Keyboard a11y: Space / Enter trigger short-press only. Long-press
    // is a touch/mouse affordance; keyboard users use the action menu.
    onKeyDown: (event: React.KeyboardEvent) => {
      // In clickDrivenTap mode the native <button> Enter/Space → onClick path
      // handles the tap; don't preventDefault it here.
      if (clickDrivenTap) return
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        onTap?.()
      }
    },
  }
}
