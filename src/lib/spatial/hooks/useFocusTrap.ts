/**
 * Spatial · Hooks · useFocusTrap
 *
 * Contains keyboard focus inside a modal container while it is open. `aria-
 * modal` alone does not stop Tab from walking into the page behind a sheet —
 * the Material-Picker (Mockup 42 §5) and Lighting-Switcher (Mockup 43 §5)
 * both require a real trap.
 *
 * Wrapping Tab / Shift+Tab at the boundaries, and pulling focus back in if it
 * has escaped. No-op while `active` is false.
 */

import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusables.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement

      if (!container.contains(current)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [containerRef, active])
}
