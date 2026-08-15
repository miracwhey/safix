/**
 * Native status-bar route policy — single shared source.
 *
 * The app runs fullscreen (`overlaysWebView: true` app-wide), so the only
 * per-screen decision left is the glyph TEXT style:
 *   - dark / immersive surfaces rendered edge-to-edge → LIGHT (white) glyphs
 *   - light default screens → DARK (black) glyphs
 *
 * Shared by `StatusBarController` (route-level default) and
 * `useImmersiveStatusBar` (component-level dark viewers) so both agree on the
 * style to apply / restore. Matched as exact path OR path-prefix
 * (`/x` also covers `/x/...`).
 */
export const DARK_ROUTES = ['/explore', '/customer/spatial/list'] as const

export function isDarkRoute(pathname: string): boolean {
  return DARK_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`))
}
