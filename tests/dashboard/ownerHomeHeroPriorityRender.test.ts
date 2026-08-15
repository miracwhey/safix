/**
 * Block 7.1F — OwnerHomeHero priority-reason render contract.
 *
 * `deriveOwnerHomeState` produces `kind: 'busy'` for every payment-priority
 * reason (payout_blocked, payout_failed, release_overdue, funding_awaited)
 * as well as for the generic busy state. Before 7.1F, `OwnerHomeHero`
 * returned the generic busy hero on the first `kind === 'busy'` match,
 * silently swallowing the dedicated payout/release variants further down
 * the file.
 *
 * These tests pin the visible result for each contract priority so a future
 * branch reorder cannot regress the user-facing alert again.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import OwnerHomeHero from '../../src/components/home/OwnerHomeHero'
import type { OwnerHomeState } from '../../src/lib/viewmodel/homeState'

function render(vm: OwnerHomeState): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(OwnerHomeHero, { vm }),
    ),
  )
}

function makeVm(overrides: Partial<OwnerHomeState>): OwnerHomeState {
  return {
    kind: 'calm',
    priorityReason: null,
    severity: null,
    primaryAction: null,
    followUps: [],
    notificationDot: false,
    ...overrides,
  }
}

describe('OwnerHomeHero — payment-priority dispatch', () => {
  it('payout_failed (kind=busy) renders the bank-data alert, not the generic busy hero', () => {
    const html = render(
      makeVm({
        kind: 'busy',
        priorityReason: 'payout_failed',
        severity: 'urgent',
        primaryAction: {
          actionId: 'fix_payout_bank_data',
          label: 'Bankdaten prüfen',
          route: '/craftsman/profile/tax-bank',
        },
        notificationDot: true,
      }),
    )
    // Routes are wired via onClick handlers, which SSR does not serialise.
    // Visible text uniquely identifies the payout_failed variant — no other
    // Hero branch surfaces "Auszahlung fehlgeschlagen". The route fallback
    // is verified separately via source-inspection in the dispute test.
    expect(html).toContain('Auszahlung fehlgeschlagen')
    expect(html).toContain('Bankdaten prüfen')
    // Generic busy wording must NOT appear when payout_failed is the priority.
    expect(html).not.toContain('Pipeline füllt sich')
    expect(html).not.toContain('Neue Anfragen')
  })

  it('payout_blocked (kind=busy) renders the locked-payout hero', () => {
    const html = render(
      makeVm({
        kind: 'busy',
        priorityReason: 'payout_blocked',
        severity: 'urgent',
        primaryAction: {
          actionId: 'fix_payout',
          label: 'Auszahlung prüfen',
          route: '/craftsman/finance',
        },
        notificationDot: true,
      }),
    )
    expect(html).toContain('Auszahlung gesperrt')
    expect(html).not.toContain('Pipeline füllt sich')
  })

  it('release_overdue (kind=busy) renders the release-pending hero', () => {
    const html = render(
      makeVm({
        kind: 'busy',
        priorityReason: 'release_overdue',
        severity: 'action',
        primaryAction: {
          actionId: 'view_release_pending',
          label: 'Freigabe prüfen',
          route: '/craftsman/jobs/job-1',
        },
        notificationDot: true,
      }),
    )
    expect(html).toContain('Freigabe ausstehend')
    expect(html).toContain('Kunde muss Arbeit bestätigen')
    expect(html).not.toContain('Pipeline füllt sich')
  })

  it('funding_awaited (kind=busy) renders the funding-awaited hero', () => {
    const html = render(
      makeVm({
        kind: 'busy',
        priorityReason: 'funding_awaited',
        severity: 'action',
        primaryAction: {
          actionId: 'view_funding_awaited',
          label: 'Projekt öffnen',
          route: '/craftsman/jobs/job-2',
        },
        notificationDot: true,
      }),
    )
    expect(html).toContain('Einzahlung erwartet')
    expect(html).not.toContain('Pipeline füllt sich')
  })

  it('requests_pending (kind=busy) still renders the generic busy hero', () => {
    const html = render(
      makeVm({
        kind: 'busy',
        priorityReason: 'requests_pending',
        severity: 'action',
        primaryAction: {
          actionId: 'review_requests',
          label: 'Anfragen prüfen',
          route: '/craftsman/messages',
        },
        notificationDot: true,
      }),
    )
    expect(html).toContain('Neue Anfragen')
  })

  it('dispute kind renders the dispute hero label even without primaryAction', () => {
    const html = render(
      makeVm({
        kind: 'dispute',
        priorityReason: 'dispute_open',
        severity: 'urgent',
        primaryAction: null,
        notificationDot: true,
      }),
    )
    expect(html).toContain('Streit beantworten')
    expect(html).toContain('Streit öffnen')
  })

  it('OwnerHomeHero source uses /craftsman/disputes — never the unregistered /disputes route', async () => {
    // Block 7.1F — the prior `/disputes` fallback pointed at an unregistered
    // route. SSR cannot expose the onClick target, so we pin the source string
    // directly to prevent regressions of the dispute-fallback fix.
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/home/OwnerHomeHero.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/disputes')
    // Forbid the bare `/disputes` literal anywhere in the file.
    expect(source).not.toMatch(/['"`]\/disputes['"`]/)
  })

  it('calm kind renders the calm hero', () => {
    const html = render(makeVm({ kind: 'calm' }))
    expect(html).toContain('alles im Plan')
  })

  it('loading kind renders skeleton — no priority text', () => {
    const html = render(makeVm({ kind: 'loading' }))
    expect(html).not.toContain('Auszahlung fehlgeschlagen')
    expect(html).not.toContain('Bankdaten prüfen')
  })
})
