// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDoubleTap } from '../../src/lib/ui/useDoubleTap'

/**
 * Gesture hardening (Block 3): the reel pause/play tap must be instant and a
 * rapid second tap must like — NOT silently lose the single-tap. These lock the
 * `immediateSingle` semantics + the legacy deferred path + the iOS guards.
 */

let clock = 0
const tick = (ms: number) => {
  clock += ms
}

// Minimal React-event shims — the hook only reads touches/changedTouches/coords.
const touchStart = (x: number, y: number) =>
  ({ touches: [{ clientX: x, clientY: y }] }) as unknown as React.TouchEvent
const touchEnd = (x: number, y: number) =>
  ({ changedTouches: [{ clientX: x, clientY: y }] }) as unknown as React.TouchEvent
const click = (x: number, y: number) =>
  ({ clientX: x, clientY: y }) as unknown as React.MouseEvent

function tap(h: ReturnType<typeof useDoubleTap>, x = 50, y = 50) {
  h.onTouchStart(touchStart(x, y))
  h.onTouchEnd(touchEnd(x, y))
}

beforeEach(() => {
  clock = 10_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDoubleTap — immediateSingle (reel pause/play)', () => {
  it('fires the single tap immediately (no defer)', () => {
    const onSingleTap = vi.fn()
    const onDoubleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap, onDoubleTap }, { windowMs: 300, immediateSingle: true }),
    )
    tap(result.current)
    expect(onSingleTap).toHaveBeenCalledTimes(1) // synchronous, no timer
    expect(onDoubleTap).not.toHaveBeenCalled()
  })

  it('a rapid second tap likes (double) — the single is NOT lost', () => {
    const onSingleTap = vi.fn()
    const onDoubleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap, onDoubleTap }, { windowMs: 300, immediateSingle: true }),
    )
    tap(result.current) // tap 1 → single (pause toggles instantly)
    tick(120)
    tap(result.current) // tap 2 within window → double (like)
    expect(onSingleTap).toHaveBeenCalledTimes(1)
    expect(onDoubleTap).toHaveBeenCalledTimes(1)
  })

  it('two taps OUTSIDE the window are two independent single taps', () => {
    const onSingleTap = vi.fn()
    const onDoubleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap, onDoubleTap }, { windowMs: 300, immediateSingle: true }),
    )
    tap(result.current)
    tick(400)
    tap(result.current)
    expect(onSingleTap).toHaveBeenCalledTimes(2)
    expect(onDoubleTap).not.toHaveBeenCalled()
  })

  it('triple rapid tap resolves to single, double, single (consumed guard)', () => {
    const onSingleTap = vi.fn()
    const onDoubleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap, onDoubleTap }, { windowMs: 300, immediateSingle: true }),
    )
    tap(result.current) // single
    tick(100)
    tap(result.current) // double
    tick(100)
    tap(result.current) // single (the consumed double can't pair again)
    expect(onSingleTap).toHaveBeenCalledTimes(2)
    expect(onDoubleTap).toHaveBeenCalledTimes(1)
  })

  it('a flick-scroll that ends on the target is not a tap', () => {
    const onSingleTap = vi.fn()
    const onDoubleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap, onDoubleTap }, { immediateSingle: true, moveThresholdPx: 10 }),
    )
    result.current.onTouchStart(touchStart(50, 50))
    result.current.onTouchEnd(touchEnd(50, 90)) // moved 40px > 10
    expect(onSingleTap).not.toHaveBeenCalled()
    expect(onDoubleTap).not.toHaveBeenCalled()
  })

  it('suppresses the iOS synthetic click that follows a touchend', () => {
    const onSingleTap = vi.fn()
    const { result } = renderHook(() =>
      useDoubleTap({ onSingleTap }, { immediateSingle: true, ghostClickSuppressMs: 600 }),
    )
    tap(result.current) // touchend → single (1)
    tick(50)
    result.current.onClick(click(50, 50)) // ghost click → ignored
    expect(onSingleTap).toHaveBeenCalledTimes(1)
    tick(700)
    result.current.onClick(click(50, 50)) // real mouse click later → fires
    expect(onSingleTap).toHaveBeenCalledTimes(2)
  })
})

describe('useDoubleTap — deferred (legacy) default', () => {
  it('defers the single tap and cancels it when a double arrives', () => {
    // Drop the Date.now spy first; vitest fake timers control Date themselves,
    // so the two synchronous taps share one fake "now" (= within the window).
    vi.restoreAllMocks()
    vi.useFakeTimers()
    try {
      const onSingleTap = vi.fn()
      const onDoubleTap = vi.fn()
      const { result } = renderHook(() => useDoubleTap({ onSingleTap, onDoubleTap }, { windowMs: 280 }))
      // single tap: nothing until the timer elapses
      tap(result.current)
      expect(onSingleTap).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(onSingleTap).toHaveBeenCalledTimes(1)
      // double tap: the deferred single is cancelled
      onSingleTap.mockClear()
      tap(result.current)
      tap(result.current) // same fake "now" → inside the window → double
      vi.advanceTimersByTime(300)
      expect(onSingleTap).not.toHaveBeenCalled()
      expect(onDoubleTap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
