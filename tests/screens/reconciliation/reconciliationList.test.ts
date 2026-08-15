/**
 * Block N13.POLISH — render contract for `<ReconciliationList>`.
 *
 * Locks the presentation behaviour that was implicit before:
 *   - empty (zero buckets) → `<EmptyState>` with the legal hint
 *   - active bucket → urgency subtitle + per-item card with route prefix
 *   - resolved bucket → "Aufbewahrung 10 Jahre" subtitle + decision summary
 *   - amount info uses canonical `formatEuro()` (no local helper sneaks back in)
 *   - awaiting-action items get the danger-tone badge + left border
 *   - role-aware route prefix is honoured per-item (customer vs craftsman path)
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ReconciliationList } from '../../../src/screens/reconciliation/ReconciliationList'
import type {
  ReconciliationListBuckets,
  ReconciliationListItem,
} from '../../../src/lib/reconciliation'

const baseItem: ReconciliationListItem = {
  disputeId: 'dispute-1',
  aktenzeichen: 'AKZ-2026-001',
  jobId: 'job-1',
  jobTitle: 'Bad-Sanierung',
  status: 'provider_waiting',
  statusLabel: 'Wartet auf Anbieter',
  summary: 'Kacheln nicht plan verlegt.',
  amountEur: 2300,
  updatedAt: '2026-04-30T12:00:00.000Z',
  createdAt: '2026-04-25T08:00:00.000Z',
  resolvedAt: null,
  deadline: { dueAt: '2026-05-05T12:00:00.000Z', urgency: 'soon' },
  requiresAction: true,
  urgencyLevel: 'critical',
  decisionSummary: null,
  refundedAmountEur: null,
}

function buildBuckets(
  overrides: Partial<ReconciliationListBuckets> = {},
): ReconciliationListBuckets {
  return {
    active: [],
    resolved: [],
    counts: { active: 0, awaitingViewer: 0, resolved: 0 },
    ...overrides,
  }
}

function render(
  buckets: ReconciliationListBuckets,
  detailRoutePrefix: string,
): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ReconciliationList, { buckets, detailRoutePrefix }),
    ),
  )
}

describe('<ReconciliationList>', () => {
  it('empty buckets render the EmptyState with legal hint', () => {
    const html = render(buildBuckets(), '/craftsman/profile/disputes')
    expect(html).toContain('Du hast keine Streitfälle')
    expect(html).toContain('DSGVO Art. 15 · Auskunftsrecht')
    expect(html).toContain('Wann öffnet sich ein Streitfall?')
  })

  it('active bucket: shows urgency subtitle when awaitingViewer > 0', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Aktive Verfahren')
    expect(html).toContain('1 warten auf dich')
  })

  it('active bucket: falls back to "Sortiert nach Dringlichkeit" when awaitingViewer === 0', () => {
    const passiveItem = { ...baseItem, requiresAction: false, status: 'under_review' as const }
    const html = render(
      buildBuckets({
        active: [passiveItem],
        counts: { active: 1, awaitingViewer: 0, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Sortiert nach Dringlichkeit')
    expect(html).not.toContain('warten auf dich')
  })

  it('resolved bucket: shows retention hint subtitle', () => {
    const resolvedItem: ReconciliationListItem = {
      ...baseItem,
      disputeId: 'dispute-2',
      aktenzeichen: 'AKZ-2026-002',
      status: 'resolved',
      requiresAction: false,
      resolvedAt: '2026-04-20T10:00:00.000Z',
      decisionSummary: 'Vollständige Freigabe',
      urgencyLevel: 'normal',
    }
    const html = render(
      buildBuckets({
        resolved: [resolvedItem],
        counts: { active: 0, awaitingViewer: 0, resolved: 1 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Abgeschlossen')
    expect(html).toContain('Aufbewahrung 10 Jahre')
    expect(html).toContain('Vollständige Freigabe')
  })

  it('amount info uses canonical formatEuro (no Intl-format-string drift)', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    // Canonical formatter renders 2300 as "2.300,00 €" (de-DE / EUR / 2 decimals).
    expect(html).toContain('2.300,00')
    expect(html).toContain('€')
  })

  it('refunded amount overrides the agreed amount in the info line', () => {
    const refundedItem = { ...baseItem, refundedAmountEur: 750 }
    const html = render(
      buildBuckets({
        active: [refundedItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('750,00')
    expect(html).toContain('erstattet')
  })

  it('awaiting-action item gets the danger-tone badge and left border', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Aktion nötig')
    expect(html).toContain('border-danger')
  })

  it('craftsman route prefix is honoured in the per-item href', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toMatch(/href="\/craftsman\/profile\/disputes\/akz-2026-001"/i)
  })

  it('customer route prefix is honoured in the per-item href', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/customer/profile/disputes',
    )
    expect(html).toMatch(/href="\/customer\/profile\/disputes\/akz-2026-001"/i)
    expect(html).not.toContain('/craftsman/profile/')
  })

  it('right-label: awaiting + deadline → "Frist DD.MM.YYYY"', () => {
    const html = render(
      buildBuckets({
        active: [baseItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Frist 05.05.2026')
  })

  it('right-label: resolved item → resolvedAt date', () => {
    const resolvedItem: ReconciliationListItem = {
      ...baseItem,
      status: 'resolved',
      requiresAction: false,
      resolvedAt: '2026-04-20T10:00:00.000Z',
      urgencyLevel: 'normal',
      decisionSummary: 'Erledigt',
    }
    const html = render(
      buildBuckets({
        resolved: [resolvedItem],
        counts: { active: 0, awaitingViewer: 0, resolved: 1 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('20.04.2026')
  })

  it('cancelled item shows the "Zurückgezogen" badge tone', () => {
    const cancelledItem: ReconciliationListItem = {
      ...baseItem,
      status: 'cancelled',
      requiresAction: false,
      resolvedAt: '2026-04-15T10:00:00.000Z',
      urgencyLevel: 'normal',
      decisionSummary: null,
    }
    const html = render(
      buildBuckets({
        resolved: [cancelledItem],
        counts: { active: 0, awaitingViewer: 0, resolved: 1 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('Zurückgezogen')
  })

  it('item without amount + no refund renders em-dash', () => {
    const noAmountItem = { ...baseItem, amountEur: null, refundedAmountEur: null }
    const html = render(
      buildBuckets({
        active: [noAmountItem],
        counts: { active: 1, awaitingViewer: 1, resolved: 0 },
      }),
      '/craftsman/profile/disputes',
    )
    expect(html).toContain('—')
  })
})
