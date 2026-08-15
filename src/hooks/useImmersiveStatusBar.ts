/**
 * Spatial · useImmersiveStatusBar
 *
 * Full-bleed 3D needs the native status-bar glyphs in Light-Style so they stay
 * legible over the dark viewer background. The app already runs fullscreen
 * (`overlaysWebView: true` app-wide via capacitor.config + bootstrap), so this
 * hook only flips the glyph STYLE for a component-level dark viewer that can
 * open on top of an otherwise-light screen.
 *
 * Mount → Light style (overlay re-asserted, stays on). Cleanup → hand the
 * style back to the CURRENT ROUTE's default (Light on dark/immersive routes,
 * Dark on light screens) — it never turns the fullscreen overlay off, so the
 * old grey OS bar can't reappear. Self-guards `Capacitor.isNativePlatform()`
 * so it is a no-op on web.
 *
 * ── Multi-instance coordination ─────────────────────────────────────────────
 * A single screen can hold TWO immersive viewers that hand over in the SAME
 * React commit (e.g. a presales scanned room: the GLB `SpatialFullscreenViewer`
 * unmounts while the parametric `SpatialMultiModeViewer` mounts once the blob
 * hydrates). React runs the outgoing cleanup BEFORE the incoming setup, so a
 * naive per-instance "restore on unmount" would race the incoming "arm" on the
 * single global StatusBar and could leave Dark glyphs over the dark scene. We
 * therefore ref-count: arm only on the 0→1 transition and restore only once the
 * LAST viewer is gone — and we defer the restore decision by a microtask so a
 * same-commit sibling mount re-increments before we conclude the app is leaving
 * immersive mode. All native calls run through a single serialized promise chain
 * so the two async sequences can never interleave.
 *
 * Call once inside any fullscreen spatial viewer (mount-on / unmount-off).
 */

import { useEffect } from 'react'
import { isDarkRoute } from '../lib/native/statusBarRoutes'

let activeCount = 0
let applyChain: Promise<void> = Promise.resolve()

function enqueue(op: () => Promise<void>): void {
  applyChain = applyChain.then(op).catch(() => {
    /* plugin unavailable / native call failed — ignore, never break the chain */
  })
}

async function armImmersive(): Promise<void> {
  const { Capacitor } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  await StatusBar.setOverlaysWebView({ overlay: true })
  await StatusBar.setStyle({ style: Style.Light })
}

async function restoreDefault(): Promise<void> {
  const { Capacitor } = await import('@capacitor/core')
  if (!Capacitor.isNativePlatform()) return
  const { StatusBar, Style } = await import('@capacitor/status-bar')
  // App is fullscreen app-wide (overlay stays ON) — only hand the glyph style
  // back to the current route's default instead of flipping the overlay off.
  const dark = isDarkRoute(window.location.pathname)
  await StatusBar.setStyle({ style: dark ? Style.Light : Style.Dark })
}

export function useImmersiveStatusBar(): void {
  useEffect(() => {
    activeCount += 1
    if (activeCount === 1) enqueue(armImmersive)
    return () => {
      activeCount -= 1
      // Defer so a same-commit sibling mount can re-increment first — only the
      // genuine last-viewer-gone restores the app default.
      void Promise.resolve().then(() => {
        if (activeCount === 0) enqueue(restoreDefault)
      })
    }
  }, [])
}

/** Test-only: reset the module-level coordination between tests. */
export function __resetImmersiveStatusBarForTests(): void {
  activeCount = 0
  applyChain = Promise.resolve()
}
