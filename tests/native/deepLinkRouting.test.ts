// @vitest-environment jsdom
/**
 * Deep-link routing — custom-scheme normalisation.
 *
 * Covers the regression where `app.fixup.main:/path` (single slash) was never
 * explicitly handled and only routed by accident. Both `://`, `:/`, and bare
 * `:` forms must normalise to the same SPA path with query + hash preserved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { __test__ } from '../../src/lib/native/bootstrap'

const { routeDeepLink, customSchemePathFromUrl } = __test__

let assignSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Stub window.location.assign — routeDeepLink navigates the SPA via it.
  assignSpy = vi.fn()
  Object.defineProperty(window, 'location', {
    value: { assign: assignSpy, href: 'capacitor://localhost/', origin: 'capacitor://localhost' },
    writable: true,
    configurable: true,
  })
  // jsdom provides sessionStorage; clear it between cases.
  window.sessionStorage.clear()
})

describe('customSchemePathFromUrl — pure normalisation', () => {
  it('strips 0, 1, or 2 leading slashes and re-prepends exactly one', () => {
    expect(customSchemePathFromUrl('app.fixup.main://auth/x')).toBe('/auth/x')
    expect(customSchemePathFromUrl('app.fixup.main:/auth/x')).toBe('/auth/x')
    expect(customSchemePathFromUrl('app.fixup.main:auth/x')).toBe('/auth/x')
  })

  it('preserves query + hash', () => {
    expect(customSchemePathFromUrl('app.fixup.main://auth/x?a=1#b=2')).toBe('/auth/x?a=1#b=2')
  })
})

describe('routeDeepLink — custom-scheme normalisation', () => {
  it('routes the double-slash form (://) for reset-password', () => {
    routeDeepLink('app.fixup.main://auth/reset-password#type=recovery&access_token=abc')
    expect(assignSpy).toHaveBeenCalledWith('/auth/reset-password#type=recovery&access_token=abc')
  })

  it('routes the single-slash form (:/) for reset-password (the accidental case)', () => {
    routeDeepLink('app.fixup.main:/auth/reset-password#type=recovery&access_token=abc')
    expect(assignSpy).toHaveBeenCalledWith('/auth/reset-password#type=recovery&access_token=abc')
  })

  it('routes the bare/opaque form (:) for reset-password', () => {
    routeDeepLink('app.fixup.main:auth/reset-password#type=recovery&access_token=abc')
    expect(assignSpy).toHaveBeenCalledWith('/auth/reset-password#type=recovery&access_token=abc')
  })

  it('routes /auth/callback for all three forms identically', () => {
    routeDeepLink('app.fixup.main://auth/callback?code=x')
    routeDeepLink('app.fixup.main:/auth/callback?code=x')
    routeDeepLink('app.fixup.main:auth/callback?code=x')
    expect(assignSpy).toHaveBeenNthCalledWith(1, '/auth/callback?code=x')
    expect(assignSpy).toHaveBeenNthCalledWith(2, '/auth/callback?code=x')
    expect(assignSpy).toHaveBeenNthCalledWith(3, '/auth/callback?code=x')
  })

  it('does NOT lose the first path segment for double-slash (new URL host trap)', () => {
    // Regression guard: `new URL('app.fixup.main://auth/x')` parses host="auth"
    // and pathname="/x". String normalisation must keep the full /auth/x path.
    routeDeepLink('app.fixup.main://auth/callback')
    expect(assignSpy).toHaveBeenCalledWith('/auth/callback')
  })

  it('stashes the recovery hash + flag before navigating (reset-password handoff)', () => {
    routeDeepLink('app.fixup.main:/auth/reset-password#type=recovery&access_token=abc')
    expect(window.sessionStorage.getItem('fixup.auth.password_recovery')).toBe('1')
    expect(window.sessionStorage.getItem('fixup.auth.recovery_hash')).toBe(
      '#type=recovery&access_token=abc',
    )
  })

  it('rejects a path outside the allow-list (no navigation)', () => {
    routeDeepLink('app.fixup.main:/evil/redirect')
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('still routes universal (https) links via the URL parser', () => {
    routeDeepLink('https://app.fixup.de/auth/callback?code=y')
    expect(assignSpy).toHaveBeenCalledWith('/auth/callback?code=y')
  })

  it('routes allow-listed prefix paths (e.g. /payout-return) for single-slash', () => {
    routeDeepLink('app.fixup.main:/payout-return?session=1')
    expect(assignSpy).toHaveBeenCalledWith('/payout-return?session=1')
  })

  it('does not crash on a malformed custom-scheme URL', () => {
    expect(() => routeDeepLink('app.fixup.main:')).not.toThrow()
    // bare scheme → rest='' → spaPath='/' → early-return (no navigation)
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('rejects an unknown / garbage non-scheme string without navigating or crashing', () => {
    // Not a custom scheme and not a parseable URL → new URL() throws → caught,
    // logged as malformed, no navigation.
    expect(() => routeDeepLink('not-a-url-just-garbage')).not.toThrow()
    expect(assignSpy).not.toHaveBeenCalled()
  })
})
