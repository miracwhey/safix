import { useEffect } from 'react'

/**
 * Global guard against the WKWebView "synthetic click after scroll" bug:
 * when the user scrolls a container (vertical list OR horizontal carousel),
 * the touch sequence can still emit a `click` on the element under the finger
 * when it lifts — firing card onClick / navigation the user never intended
 * (e.g. tapping a reel while flicking the "Im Trend" row).
 *
 * Keyed on SCROLL, not raw pointer movement — this is deliberate so it does
 * NOT touch movement that is the *expected* interaction on a screen: 3D
 * dollhouse orbit/pan, sliders, wall/object drag in the spatial editor, and
 * swipe-between-tabs all move the pointer WITHOUT scrolling, so their clicks /
 * selections are never suppressed. Only a click produced by (or immediately
 * after) an actual scroll is cancelled.
 *
 * Installed once at the app root. `click` is intercepted in the capture phase
 * so React's synthetic onClick never runs and `<a>` default navigation is
 * prevented. Genuine taps (no scroll) pass straight through, so existing
 * onClick handlers, useDoubleTap and useLongPress keep working unchanged.
 *
 * Always allowed (never suppressed): form controls, sliders, contenteditable,
 * native draggables, <canvas> (WebGL/3D), and anything marked
 * `data-allow-move-click`.
 */

// A click landing within this window of the last scroll event is treated as a
// scroll artefact (covers momentum settling), not an intentional tap.
const SCROLL_GRACE_MS = 200

const EXEMPT_SELECTOR =
  'input,textarea,select,option,canvas,[role="slider"],[contenteditable],[draggable="true"],[data-allow-move-click]'

export function installScrollSafeClicks(doc: Document = document): () => void {
  let gestureScrolled = false
  let lastScrollAt = -Infinity

  const onPointerDown = () => {
    // A fresh touch/click sequence — forget any scroll from the previous one,
    // both the gesture flag AND the wall-clock window. Without resetting
    // lastScrollAt, a deliberate tap that lands within SCROLL_GRACE_MS of the
    // previous gesture's scroll-snap settle is wrongly swallowed as a scroll
    // artefact — exactly the core flick-to-next-reel → tap-Like/Save/Comment
    // loop, where the first tap after a reel settles silently does nothing. A
    // genuine scroll artefact has NO pointerdown between the scroll and the
    // click, so `gestureScrolled` alone still suppresses it; if the snap is
    // truly still settling, the next scroll event after this pointerdown
    // re-arms both flags.
    gestureScrolled = false
    lastScrollAt = -Infinity
  }
  const onScroll = () => {
    gestureScrolled = true
    lastScrollAt = Date.now()
  }
  const onClickCapture = (e: Event) => {
    const recentScroll = Date.now() - lastScrollAt < SCROLL_GRACE_MS
    if (!gestureScrolled && !recentScroll) return
    const el = e.target as Element | null
    if (el && typeof el.closest === 'function' && el.closest(EXEMPT_SELECTOR)) {
      gestureScrolled = false
      return
    }
    // This click is a scroll artefact — stop it before React / <a> see it.
    e.stopImmediatePropagation()
    e.preventDefault()
    gestureScrolled = false
  }

  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
  doc.addEventListener('click', onClickCapture, { capture: true })

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
    doc.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions)
    doc.removeEventListener('click', onClickCapture, { capture: true } as EventListenerOptions)
  }
}

/** Install the global scroll-safe click guard for the lifetime of the app. */
export function useScrollSafeClicks(): void {
  useEffect(() => installScrollSafeClicks(), [])
}
