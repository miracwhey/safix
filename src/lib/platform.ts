import { Capacitor } from '@capacitor/core';

/** True when running inside a native iOS/Android shell (Capacitor). */
export const isNative = (): boolean => Capacitor.isNativePlatform();

/**
 * Public web origin — the canonical URL where the SaFix PWA is served AND the
 * domain Apple has verified for Universal Links (App.entitlements
 * `applinks:app.safix.digital` + public/.well-known/apple-app-site-association).
 *
 * Single source of truth for the hosted origin: the auth-redirect helper and
 * the share/deep-link helper below both read it, so if the hosted origin moves
 * they move together.
 */
const FIXUP_PUBLIC_WEB_ORIGIN = 'https://app.safix.digital';

/**
 * Returns the redirect URL for Supabase auth callbacks (sign-up confirmation,
 * magic-link, password recovery).
 *
 * - Native: returns the **Universal Link** on the Apple-verified
 *   app.safix.digital domain — deliberately NOT the `app.fixup.main://` custom
 *   URL scheme. Any other installed app can register the same custom scheme and
 *   would then intercept the single-use recovery / confirmation token carried
 *   in the redirect (token hijack). A Universal Link is cryptographically bound
 *   to this app via the AASA file, so iOS routes it straight into SaFix with no
 *   interception surface. NOTE: every auth `path` used here MUST be listed in
 *   the AASA `components` (/auth/callback, /auth/reset-password) or iOS falls
 *   back to opening the link in Safari instead of the app.
 * - Web: same-origin redirect via window.location.origin (falls back to the
 *   hosted origin during SSR / prerender where `window` is absent).
 */
export function getAuthRedirectUrl(path = '/auth/callback'): string {
  if (isNative()) {
    return `${FIXUP_PUBLIC_WEB_ORIGIN}${path}`;
  }
  return typeof window !== 'undefined'
    ? `${window.location.origin}${path}`
    : `${FIXUP_PUBLIC_WEB_ORIGIN}${path}`;
}

/**
 * Public web origin — the URL where the SaFix PWA is served. Used to build
 * share / deep-link URLs that must work for receivers OUTSIDE the current
 * device.
 *
 * - Web build: returns `window.location.origin`. The receiver opens the same
 *   site they came from.
 * - Native shell (Capacitor): `window.location.origin` is
 *   `capacitor://localhost`, which is meaningless to anyone else. We fall
 *   back to the canonical hosted PWA URL (FIXUP_PUBLIC_WEB_ORIGIN, shared with
 *   the auth-redirect helper above) so a share lands on the open web.
 */
export function getPublicWebOrigin(): string {
  if (isNative()) return FIXUP_PUBLIC_WEB_ORIGIN;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return FIXUP_PUBLIC_WEB_ORIGIN;
}

/**
 * Open a URL in the appropriate way for the current platform.
 * - Native: opens Capacitor In-App Browser (keeps user in the app).
 * - Web: standard navigation via window.location.href.
 *
 * Use `mode: 'tab'` to open in a new tab on web (preserves current page).
 * Use `mode: 'navigate'` (default) to navigate away.
 */
export async function openExternal(
  url: string,
  mode: 'navigate' | 'tab' = 'navigate',
): Promise<void> {
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else if (mode === 'tab') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.href = url;
  }
}
