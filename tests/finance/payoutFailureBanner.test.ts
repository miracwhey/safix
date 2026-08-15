/**
 * Block 7.1D — Payout-Failure-Banner Renderpfad (Source-Inspection)
 *
 * Verifies that:
 *   1. CraftsmanFinanceScreen wires the banner via the alert selector and
 *      renders it above the existing payout hero.
 *   2. PayoutFailureBanner.tsx short-circuits to null when no failure exists
 *      and otherwise routes to the canonical action target.
 *
 * No @testing-library/react is used here (per existing convention in
 * tests/hooks/useHomeState.test.ts) — instead we inspect the source files
 * to guard against accidental removal of the wiring.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FINANCE_SCREEN = resolve(__dirname, '../../src/screens/CraftsmanFinanceScreen.tsx')
const BANNER = resolve(__dirname, '../../src/components/finance/PayoutFailureBanner.tsx')

describe('CraftsmanFinanceScreen — payout failure banner wiring', () => {
  const src = readFileSync(FINANCE_SCREEN, 'utf-8')

  it('imports PayoutFailureBanner', () => {
    expect(src).toMatch(/import\s+PayoutFailureBanner\s+from\s+'\.\.\/components\/finance\/PayoutFailureBanner'/)
  })

  it('uses the canonical selector to derive the alert', () => {
    expect(src).toContain('derivePayoutFailureAlert')
    expect(src).toContain('getNotificationSignals')
  })

  it('subscribes to notification signals so the banner reacts to bridge updates', () => {
    expect(src).toContain('subscribeNotifications')
  })

  it('renders the banner inside the main finance section', () => {
    expect(src).toMatch(/<PayoutFailureBanner\s+alert=\{payoutFailureAlert\}\s*\/>/)
  })
})

describe('PayoutFailureBanner — render contract', () => {
  const src = readFileSync(BANNER, 'utf-8')

  it('returns null when no payout failure is present', () => {
    expect(src).toMatch(/if\s*\(!alert\.hasPayoutFailure\)\s+return\s+null/)
  })

  it('navigates to the alert action route when tapped', () => {
    expect(src).toContain('navigate(alert.actionRoute)')
  })

  it('exposes a stable test id for screen-level integration tests', () => {
    expect(src).toContain('data-testid="payout-failure-banner"')
  })

  it('renders the alert title, description and CTA label', () => {
    expect(src).toContain('alert.title')
    expect(src).toContain('alert.description')
    expect(src).toContain('alert.ctaLabel')
  })
})
