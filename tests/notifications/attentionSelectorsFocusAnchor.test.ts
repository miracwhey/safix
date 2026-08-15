import { beforeEach, describe, expect, it } from 'vitest'

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import { addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import type { Dispute } from '../../src/lib/disputes/types'

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-focus-anchor',
    projectId: 'project-focus-anchor',
    title: 'Focus Anchor Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '€1.000',
    description: 'job for focus anchor coverage',
    paymentState: 'in_escrow',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-focus-anchor',
    jobId: 'job-focus-anchor',
    raisedBy: 'customer',
    status: 'open',
    reason: 'quality',
    title: 'Streit-Fokus-Test',
    description: 'Anker-Test',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionQueue items deep-link with `?focus=...` so JobDetail can scroll to
// the right sub-section. Unknown values must be ignored by the consumer; the
// selector itself only emits the explicit allow-list (payment, dispute,
// timeline). 'documents', 'correction', 'offer' are reserved by the shared
// AttentionFocus type but are not produced by current item categories.
// ─────────────────────────────────────────────────────────────────────────────

describe('Attention selectors – focus anchor convention', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('release_pending payment items carry focus=payment', async () => {
    const job = buildJob({
      id: 'job-release-anchor',
      paymentState: 'release_pending',
      status: 'waiting_payment',
    })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const customerItem = items.find((i) => i.id === `attn-release-${job.id}-customer`)
    const craftsmanItem = items.find((i) => i.id === `attn-release-${job.id}-craftsman`)

    // Block 7.2.8: the customer item now points at the customer project
    // surface (OwnerRouteGate would block /craftsman/jobs for customer
    // viewers); the focus anchor stays `payment` on both surfaces.
    expect(customerItem?.linkTo).toBe(`/projects/${job.projectId}?focus=payment`)
    expect(craftsmanItem?.linkTo).toBe(`/craftsman/jobs/${job.id}?focus=payment`)
  })

  it('waiting_payment job emits payment focus for craftsman', async () => {
    const job = buildJob({
      id: 'job-waitpay-anchor',
      paymentState: 'in_escrow',
      status: 'waiting_payment',
    })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const item = items.find((i) => i.id === `attn-waitpay-${job.id}`)

    expect(item?.linkTo).toBe(`/craftsman/jobs/${job.id}?focus=payment`)
  })

  it('disputed payment state carries focus=dispute', async () => {
    const job = buildJob({
      id: 'job-dispute-anchor',
      paymentState: 'disputed',
      status: 'in_progress',
    })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const item = items.find((i) => i.id === `attn-dispute-${job.id}`)

    expect(item?.linkTo).toBe(`/craftsman/jobs/${job.id}?focus=dispute`)
  })

  it('open dispute item carries focus=dispute', () => {
    // deriveAttentionItems is pure and accepts disputes as a plain array,
    // no repository registration required for dispute-derived items.
    const dispute = buildDispute({
      id: 'dispute-open-anchor',
      jobId: 'job-open-dispute-anchor',
      status: 'open',
    })

    const items = deriveAttentionItems([], [dispute], 123456)
    const item = items.find((i) => i.id === `attn-open-${dispute.id}`)

    expect(item?.linkTo).toBe(`/craftsman/jobs/${dispute.jobId}?focus=dispute`)
  })

  it('customer_waiting dispute item carries focus=dispute', () => {
    const dispute = buildDispute({
      id: 'dispute-evidence-anchor',
      jobId: 'job-evidence-anchor',
      status: 'customer_waiting',
    })

    const items = deriveAttentionItems([], [dispute], 123456)
    const item = items.find((i) => i.id === `attn-response-${dispute.id}`)

    expect(item?.linkTo).toBe(`/craftsman/jobs/${dispute.jobId}?focus=dispute`)
  })

  it('proposal accepted item carries focus=timeline (scheduling cue)', async () => {
    const job = buildJob({
      id: 'job-accepted-anchor',
      status: 'new',
      paymentState: 'none',
      proposalAcceptedAt: 1700,
    })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const item = items.find((i) => i.id === `attn-accepted-${job.id}`)

    expect(item?.linkTo).toBe(`/craftsman/jobs/${job.id}?focus=timeline`)
  })

  it('thin intake item links to JobDetail without a focus anchor (no eindeutige Sub-Aktion)', async () => {
    const job = buildJob({
      id: 'job-thin-intake',
      status: 'new',
      paymentState: 'none',
      // No proposalAcceptedAt + no specific intake hints — selector falls into
      // the readiness=thin branch which has no canonical focus target.
      description: '',
    })
    await addJob(job)

    const items = deriveAttentionItems([job], [], 123456)
    const item = items.find((i) => i.id === `attn-new-${job.id}`)

    // The item exists but does not carry ?focus=... — defensive contract: only
    // unambiguous categories anchor.
    expect(item?.linkTo).toBe(`/craftsman/jobs/${job.id}`)
    expect(item?.linkTo.includes('focus=')).toBe(false)
  })
})
