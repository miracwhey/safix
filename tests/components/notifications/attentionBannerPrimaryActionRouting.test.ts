/**
 * N13 hardening — defensive routing for the inline `primaryAction`
 * CTA in `<AttentionBanner>`.
 *
 * Block 7.2.8 patched the secondary "Verlauf öffnen ›" link to honour
 * `customerLinkTo` for customer viewers. The primary CTA was left
 * pointing at the unfiltered `primaryAction.to`, which is fine today
 * because every selector that emits `primaryAction` does so on a
 * single-role item (the resolved `linkTo` already matches the role).
 *
 * The leak window opens the moment a future selector emits a
 * `primaryAction` on a multi-role item — `customerLinkTo` would be set
 * but the customer would still be routed to the craftsman path
 * (which is OwnerRouteGate-blocked → 404).
 *
 * This suite locks the defensive contract so a future change cannot
 * regress the routing without flipping a test.
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import AttentionBanner from '../../../src/components/notifications/AttentionBanner'
import type {
  AttentionItem,
  AttentionSummary,
} from '../../../src/lib/notifications/types'

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 'attn-test',
    jobId: 'job-1',
    severity: 'urgent',
    category: 'dispute',
    title: 'Streit · Bad-Sanierung',
    description: 'SaFix wartet auf deine Stellungnahme.',
    icon: '⚖️',
    roles: ['craftsman'],
    occurredAt: 1_700_000_000_000,
    linkTo: '/craftsman/jobs/job-1?focus=dispute',
    primaryAction: {
      label: 'Stellungnahme senden',
      to: '/craftsman/jobs/job-1?focus=dispute',
    },
    ...overrides,
  }
}

function buildSummary(item: AttentionItem): AttentionSummary {
  return {
    urgentCount: item.severity === 'urgent' ? 1 : 0,
    actionCount: item.severity === 'action' ? 1 : 0,
    waitingCount: item.severity === 'waiting' ? 1 : 0,
    totalCount: 1,
    items: [item],
  }
}

function render(
  summary: AttentionSummary,
  viewerRole?: 'customer' | 'craftsman' | 'admin',
): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(AttentionBanner, { summary, viewerRole }),
    ),
  )
}

describe('AttentionBanner — primary action routing', () => {
  it('craftsman single-role: primaryAction.to renders unchanged', () => {
    const item = buildItem({
      roles: ['craftsman'],
      linkTo: '/craftsman/jobs/job-1?focus=dispute',
      primaryAction: {
        label: 'Stellungnahme senden',
        to: '/craftsman/jobs/job-1?focus=dispute',
      },
    })
    const html = render(buildSummary(item), 'craftsman')
    expect(html).toContain('href="/craftsman/jobs/job-1?focus=dispute"')
  })

  it('customer single-role: linkTo IS the customer path, primaryAction.to renders as-is', () => {
    // For single-role customer items the selector writes the customer
    // path directly into `linkTo` AND `primaryAction.to`. No
    // `customerLinkTo` is set. Defensive routing must therefore
    // fall through to `primaryAction.to`.
    const item = buildItem({
      roles: ['customer'],
      linkTo: '/projects/project-1?focus=dispute',
      primaryAction: {
        label: 'Stellungnahme senden',
        to: '/projects/project-1?focus=dispute',
      },
    })
    const html = render(buildSummary(item), 'customer')
    expect(html).toContain('href="/projects/project-1?focus=dispute"')
    expect(html).not.toContain('/craftsman/jobs/')
  })

  it('multi-role with customerLinkTo: customer viewer routes via customerLinkTo, NOT primaryAction.to', () => {
    // Future-state contract: a selector emits `primaryAction` on a
    // multi-role item. Without the defensive resolve, the customer
    // would be routed to /craftsman/jobs/* which the OwnerRouteGate
    // bounces.
    const item = buildItem({
      roles: ['customer', 'craftsman'],
      linkTo: '/craftsman/jobs/job-9?focus=dispute',
      customerLinkTo: '/projects/project-9?focus=dispute',
      primaryAction: {
        label: 'Stellungnahme senden',
        to: '/craftsman/jobs/job-9?focus=dispute',
      },
    })
    const html = render(buildSummary(item), 'customer')
    expect(html).toContain('href="/projects/project-9?focus=dispute"')
    expect(html).not.toContain('href="/craftsman/jobs/job-9?focus=dispute"')
  })

  it('multi-role with customerLinkTo: craftsman viewer keeps primaryAction.to', () => {
    const item = buildItem({
      roles: ['customer', 'craftsman'],
      linkTo: '/craftsman/jobs/job-9?focus=dispute',
      customerLinkTo: '/projects/project-9?focus=dispute',
      primaryAction: {
        label: 'Stellungnahme senden',
        to: '/craftsman/jobs/job-9?focus=dispute',
      },
    })
    const html = render(buildSummary(item), 'craftsman')
    expect(html).toContain('href="/craftsman/jobs/job-9?focus=dispute"')
  })

  it('secondary "Verlauf öffnen ›" link still resolves via existing resolveLinkTo', () => {
    // Regression guard for Block 7.2.8 behaviour — the secondary link
    // must continue to honour customerLinkTo for customer viewers.
    const item = buildItem({
      roles: ['customer', 'craftsman'],
      linkTo: '/craftsman/jobs/job-9?focus=dispute',
      customerLinkTo: '/projects/project-9?focus=dispute',
    })
    const html = render(buildSummary(item), 'customer')
    expect(html).toContain('Verlauf öffnen')
    // Both links point at the customer path — primary (defensive) +
    // secondary (Block 7.2.8). The craftsman path must be absent.
    expect(html).not.toContain('href="/craftsman/jobs/job-9?focus=dispute"')
  })
})
