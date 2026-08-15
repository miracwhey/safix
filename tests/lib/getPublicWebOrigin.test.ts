/**
 * `getPublicWebOrigin` — cross-platform origin resolver for share / deep-link
 * URLs (review-fix follow-up).
 *
 * On native (Capacitor) the live `window.location.origin` is
 * `capacitor://localhost`, which the share recipient cannot open. The helper
 * substitutes the canonical hosted PWA origin so a share lands on the open
 * web. On web builds it just returns the live origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const isNativeMock = vi.fn(() => false)

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativeMock(),
  },
}))

import { getPublicWebOrigin } from '../../src/lib/platform'

const originalWindow = globalThis.window

afterEach(() => {
  isNativeMock.mockReset()
  // Restore the original window in case a test stubbed it.
  Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
})

describe('getPublicWebOrigin: web build', () => {
  beforeEach(() => {
    isNativeMock.mockReturnValue(false)
  })

  it('returns the live window.location.origin on web', () => {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://staging.safix.digital' } },
      configurable: true,
    })
    expect(getPublicWebOrigin()).toBe('https://staging.safix.digital')
  })

  it('falls back to the hosted PWA origin when window is unavailable (SSR / node)', () => {
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true })
    expect(getPublicWebOrigin()).toBe('https://app.safix.digital')
  })

  it('falls back to the hosted PWA origin when window.location is missing', () => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
    expect(getPublicWebOrigin()).toBe('https://app.safix.digital')
  })
})

describe('getPublicWebOrigin: native (Capacitor) build', () => {
  beforeEach(() => {
    isNativeMock.mockReturnValue(true)
  })

  it('does NOT return capacitor://localhost — substitutes the hosted PWA origin', () => {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'capacitor://localhost' } },
      configurable: true,
    })
    expect(getPublicWebOrigin()).toBe('https://app.safix.digital')
  })

  it('returns the hosted PWA origin even when the live origin happens to be valid (defensive on native)', () => {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://something-else.example' } },
      configurable: true,
    })
    expect(getPublicWebOrigin()).toBe('https://app.safix.digital')
  })
})
