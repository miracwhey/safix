import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { isDarkRoute } from '../../lib/native/statusBarRoutes'

/**
 * Single source of truth for the native iOS status bar.
 *
 * The app runs fullscreen: `overlaysWebView: true` is set in
 * `capacitor.config.ts` AND `lib/native/bootstrap.ts` (runtime wins), so the
 * WebView extends under the status bar everywhere and the old grey OS bar is
 * gone — each screen renders its own top via `env(safe-area-inset-top)`.
 *
 * This controller owns only the per-route TEXT style: LIGHT on dark/immersive
 * surfaces (Reels feed `/explore`, Spatial hub), DARK on the light default
 * screens. It re-asserts `overlay: true` on every navigation so nothing can
 * leave the bar in a non-fullscreen state.
 *
 * Replaces the previous per-screen StatusBar toggles in ExploreFeed and
 * CustomerSpatialHub, whose mount/unmount + cleanup races left the global
 * status bar stuck (grey bar / wrong glyph color) when navigating between
 * fullscreen and normal screens. No-op on web.
 */
export default function StatusBarController() {
  const { pathname } = useLocation()

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancelled = false
    void (async () => {
      try {
        const { StatusBar, Style } = await import('@capacitor/status-bar')
        if (cancelled) return
        await StatusBar.setOverlaysWebView({ overlay: true })
        await StatusBar.setStyle({ style: isDarkRoute(pathname) ? Style.Light : Style.Dark })
      } catch {
        /* plugin unavailable (web) — ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pathname])

  return null
}
