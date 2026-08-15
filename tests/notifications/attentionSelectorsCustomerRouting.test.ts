/**
 * Block 7.2.8 — Customer-side linkTo routing for attention items.
 *
 * The customer surfaces are `/projects/:projectId` (gated `requiredRole=
 * "customer"`); the craftsman surfaces are `/craftsman/jobs/:jobId` (gated
 * by OwnerRouteGate). Routing a customer viewer to the craftsman path is a
 * 404 because the gate kicks them back to "/".
 *
 * Items that are emitted for multiple roles must therefore carry both a
 * craftsman-side `linkTo` and a `customerLinkTo` so the render layer can
 * pick the surface for the viewer's role. Single-role customer items can
 * write the customer path directly into `linkTo`.
 *
 * This suite locks the contract per branch.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import type { Dispute, DisputeStatus } from '../../src/lib/disputes/types'
import type { Job } from '../../src/lib/jobs/types'
import type { AttentionItem } from '../../src/lib/notifications/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-routing-1',
    jobId: 'job-routing-1',
    status: 'provider_waiting',
    reason: 'work_quality',
    title: 'Bad-Sanierung',
    description: 'desc',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T08:00:00.000Z',
    ...overrides,
  } as Dispute
}

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-routing-1',
    projectId: 'project-routing-1',
    title: 'Bad-Sanierung',
    customer: 'Kundin',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '€1.000',
    description: 'Test job',
    paymentState: 'in_escrow',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function findById(items: AttentionItem[], id: string): AttentionItem | undefined {
  return items.find((i) => i.id === id)
}

// ---------------------------------------------------------------------------
// Selector — dispute items
// ---------------------------------------------------------------------------

describe('deriveDisputeAttention — customer-side routing (Block 7.2.8)', () => {
  it('customer_waiting routes linkTo + primaryAction.to to the customer project surface', () => {
    const dispute = buildDispute({ status: 'customer_waiting' })
    const job = buildJob()
    const items = deriveAttentionItems([job], [dispute])
    const item = items.find((i) => i.category === 'dispute')

    expect(item?.linkTo).toBe('/projects/project-routing-1?focus=dispute')
    expect(item?.primaryAction?.to).toBe('/projects/project-routing-1?focus=dispute')
    expect(item?.roles).toEqual(['customer'])
  })

  it('provider_waiting routes to the profile-side reconciliation center (N13.6)', () => {
    const dispute = buildDispute({ status: 'provider_waiting' })
    const job = buildJob()
    const items = deriveAttentionItems([job], [dispute])
    const item = items.find((i) => i.category === 'dispute')

    expect(item?.linkTo).toMatch(/^\/craftsman\/profile\/disputes\/R-\d{4}_\d{2}-\d{4}$/)
    expect(item?.primaryAction?.to).toBe(item?.linkTo)
    expect(item?.roles).toEqual(['craftsman'])
  })

  it('multi-role items (under_review, open) carry customerLinkTo alongside craftsman linkTo', () => {
    const job = buildJob()
    for (const status of ['under_review', 'open'] as DisputeStatus[]) {
      const items = deriveAttentionItems([job], [buildDispute({ status })])
      const item = items.find((i) => i.category === 'dispute')

      expect(item?.linkTo).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
      expect(item?.customerLinkTo).toBe('/projects/project-routing-1?focus=dispute')
      expect(item?.roles).toContain('craftsman')
      expect(item?.roles).toContain('customer')
    }
  })

  it('falls back to the craftsman path for customer_waiting when project context is missing', () => {
    // Defensive contract: a dispute referencing an unknown job must still
    // produce a usable link (no broken /projects/undefined).
    const items = deriveAttentionItems([], [buildDispute({ status: 'customer_waiting' })])
    const item = items.find((i) => i.category === 'dispute')

    expect(item?.linkTo).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
    expect(item?.primaryAction?.to).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
  })

  it('omits customerLinkTo for multi-role items when project context is missing', () => {
    const items = deriveAttentionItems([], [buildDispute({ status: 'under_review' })])
    const item = items.find((i) => i.category === 'dispute')

    expect(item?.linkTo).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
    expect(item?.customerLinkTo).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Selector — job-level disputed/release items
// ---------------------------------------------------------------------------

describe('deriveJobAttention — disputed payment & release_pending customer routing', () => {
  it('disputed payment item carries customerLinkTo for the project surface', () => {
    const job = buildJob({ paymentState: 'disputed' })
    const items = deriveAttentionItems([job], [])
    const item = findById(items, `attn-dispute-${job.id}`)

    expect(item?.linkTo).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
    expect(item?.customerLinkTo).toBe('/projects/project-routing-1?focus=dispute')
  })

  it('disputed payment without a registered dispute object keeps the job-tab link (N13.6)', () => {
    // When `paymentState === 'disputed'` but no dispute row is in the input
    // set, `deriveJobAttention` emits the bare `attn-dispute-${job.id}`
    // item with the original job-tab routing — there is no Aktenzeichen to
    // resolve.
    const job = buildJob({ paymentState: 'disputed' })
    const items = deriveAttentionItems([job], [])
    const item = findById(items, `attn-dispute-${job.id}`)

    expect(item?.linkTo).toBe('/craftsman/jobs/job-routing-1?focus=dispute')
    expect(item?.customerLinkTo).toBe('/projects/project-routing-1?focus=dispute')
  })
})

// ---------------------------------------------------------------------------
// AttentionBanner — viewerRole-aware render contract (source-inspection)
// ---------------------------------------------------------------------------

describe('AttentionBanner — viewerRole-aware linkTo resolution', () => {
  const BANNER = resolve(__dirname, '../../src/components/notifications/AttentionBanner.tsx')
  const src = readFileSync(BANNER, 'utf-8')

  it('exposes a viewerRole prop on AttentionBanner', () => {
    expect(src).toMatch(/viewerRole\?:\s*AttentionRole/)
    expect(src).toMatch(/AttentionBanner\(\{\s*summary,\s*viewerRole\s*\}/)
  })

  it('uses customerLinkTo when viewerRole === "customer" and the override is set', () => {
    expect(src).toContain("viewerRole === 'customer'")
    expect(src).toContain('item.customerLinkTo')
  })

  it('falls back to item.linkTo when no override exists', () => {
    expect(src).toMatch(/return item\.linkTo/)
  })

  it('passes viewerRole down to every AttentionRow', () => {
    expect(src).toMatch(/AttentionRow[\s\S]*viewerRole=\{viewerRole\}/)
  })

  it('renders both the primary CTA and the secondary "Verlauf öffnen" link from the resolved target', () => {
    // Both Link targets must derive from resolveLinkTo so customer viewers
    // never hit the craftsman path on the secondary navigation either.
    expect(src).toContain('to={resolvedLinkTo}')
  })
})
