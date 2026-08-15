import { useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core'

/**
 * A pinned composer that rides the keyboard via this hook. The chat composer
 * carries `.chat-composer-root`; reel bottom-sheets (comments / report / save)
 * opt in with `[data-kb-pinned-composer]`. Either gets the `resize:'none'` flip
 * while focused so the JS offset is the sole lift (no double-compensation).
 */
const COMPOSER_SELECTOR = '.chat-composer-root, [data-kb-pinned-composer]'

// The keyboard rig writes GLOBAL state (the --keyboard-height var + the native
// resize mode). When two pinned composers are mounted at once (e.g. the comments
// sheet and the report sheet hoisted inside it), the FIRST to unmount must not
// reset that global state while the other is still using it — so the reset is
// ref-counted and only runs when the last instance tears down.
let activeInstances = 0

// Native keyboard resize mode is a GLOBAL setting, so every change is funnelled
// through one serialized chain — a fast focus→blur (or mount→unmount) must not
// leave the app stuck in the wrong mode because two async calls landed out of
// order.
let resizeChain: Promise<void> = Promise.resolve()
function setResizeMode(mode: 'none' | 'body'): void {
  resizeChain = resizeChain
    .then(async () => {
      const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard')
      await Keyboard.setResizeMode({
        mode: mode === 'none' ? KeyboardResize.None : KeyboardResize.Body,
      })
    })
    .catch(() => undefined)
}

/**
 * Pins a fixed-bottom composer to the top of the on-screen keyboard.
 *
 * Publishes the live keyboard height as the CSS var `--keyboard-height` on
 * <html> and toggles the `data-keyboard-open` attribute, so a fixed composer
 * can ride the keyboard via `bottom: var(--keyboard-height)` and collapse its
 * home-indicator safe-area pad while the keyboard is up.
 *
 * Native (Capacitor): switches the keyboard resize mode to `none` **only while
 * the composer itself is focused** — body-resize plus our JS offset would
 * double-compensate, but flipping the mode for the whole screen would also
 * disable the WebView's native keyboard-avoidance for other input surfaces
 * opened from the thread (e.g. the multi-field QuoteCreationSheet). Any other
 * focused input keeps the app default (`body`, capacitor.config.ts) so its
 * fields scroll into view normally. The offset var is driven from
 * keyboardWillShow/WillHide so the bar animates in lockstep with the keyboard.
 *
 * Web / PWA: Capacitor keyboard events do not fire, so it falls back to
 * visualViewport (mirrors PortfolioCommentsPanel) to estimate the inset.
 *
 * Self-guards the platform; safe to call unconditionally from a screen.
 */
export function useKeyboardInset(onShow?: () => void): void {
  // Latest callback held in a ref so the effect's listeners stay stable (deps []).
  const onShowRef = useRef(onShow)
  onShowRef.current = onShow

  useEffect(() => {
    const root = document.documentElement

    function setHeight(px: number): void {
      const h = px > 0 ? px : 0
      root.style.setProperty('--keyboard-height', `${h}px`)
      if (h > 0) root.setAttribute('data-keyboard-open', '')
      else root.removeAttribute('data-keyboard-open')
    }

    function isComposer(node: EventTarget | null): boolean {
      return node instanceof Element && node.closest(COMPOSER_SELECTOR) !== null
    }

    if (Capacitor.isNativePlatform()) {
      activeInstances++
      let showHandle: { remove: () => Promise<void> } | null = null
      let hideHandle: { remove: () => Promise<void> } | null = null
      let cancelled = false

      // Composer focus → resize 'none' (so the JS offset is the sole lift);
      // any other input → restore the app default 'body'.
      function onFocusIn(e: FocusEvent): void {
        setResizeMode(isComposer(e.target) ? 'none' : 'body')
      }
      // Blur to nothing (keyboard dismissed) → back to the app default.
      function onFocusOut(e: FocusEvent): void {
        if (!e.relatedTarget) setResizeMode('body')
      }
      document.addEventListener('focusin', onFocusIn)
      document.addEventListener('focusout', onFocusOut)

      void (async () => {
        const { Keyboard } = await import('@capacitor/keyboard')
        if (cancelled) return
        const sh = await Keyboard.addListener('keyboardWillShow', (info) => {
          setHeight(info.keyboardHeight)
          onShowRef.current?.()
        })
        const hh = await Keyboard.addListener('keyboardWillHide', () => {
          setHeight(0)
        })
        // Unmount may have fired before the listeners resolved — drop them so
        // they don't outlive the screen.
        if (cancelled) {
          void sh.remove().catch(() => undefined)
          void hh.remove().catch(() => undefined)
          return
        }
        showHandle = sh
        hideHandle = hh
      })()

      return () => {
        cancelled = true
        document.removeEventListener('focusin', onFocusIn)
        document.removeEventListener('focusout', onFocusOut)
        if (showHandle) void showHandle.remove().catch(() => undefined)
        if (hideHandle) void hideHandle.remove().catch(() => undefined)
        // Only the LAST mounted instance resets the global rig — otherwise
        // unmounting an inner sheet would drop the keyboard offset / flip the
        // resize mode while an outer composer is still focused.
        activeInstances = Math.max(0, activeInstances - 1)
        if (activeInstances === 0) {
          setHeight(0)
          setResizeMode('body')
        }
      }
    }

    // Web / PWA fallback: visualViewport shrinks when the soft keyboard opens.
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return undefined
    activeInstances++
    let wasOpen = false
    function onResize(): void {
      if (!vv) return
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      // Ignore sub-100px deltas (mobile URL-bar collapse, not a keyboard).
      const open = inset > 100
      setHeight(open ? inset : 0)
      // Fire onShow only on the closed→open transition, not on every scroll.
      if (open && !wasOpen) onShowRef.current?.()
      wasOpen = open
    }
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    onResize()
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
      activeInstances = Math.max(0, activeInstances - 1)
      if (activeInstances === 0) setHeight(0)
    }
  }, [])
}
