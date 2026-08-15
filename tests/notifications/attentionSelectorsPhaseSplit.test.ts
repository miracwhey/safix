/**
 * Attention Selectors — Phase Split (25 % Auto-Release vs. 75 % Customer Approval)
 *
 * Guards the actor/phase contract for payment attention items:
 *
 *  1. During the 25 % auto-release phase (job in_progress, plan
 *     partially_released, Payment.state work_in_progress) neither customer
 *     nor craftsman must see an urgent attention — the auto-release is a
 *     fully system-driven event without any required user action.
 *
 *  2. During the 75 % customer-approval phase (job waiting_payment,
 *     Payment.state release_pending) the customer sees an urgent
 *     "Freigabe erforderlich", while the craftsman sees a non-urgent
 *     waiting state "Wartet auf Kundenfreigabe".
 *
 *  3. Phase-consistent dedup — per phase exactly one customer-scoped item
 *     and one craftsman-scoped item; the legacy waiting_payment branch
 *     must not produce a second craftsman item when release_pending has
 *     already fired.
 *
 * These tests also pin the releaseOperations.ts contract: partial plan
 * release must NOT flip Payment.state to 'release_pending'.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  deriveAttentionItems,
  getAttentionItemsForRole,
} from '../../src/lib/notifications/attentionSelectors'
import { addJob } from '../../src/lib/jobs'
import {
  ensurePaymentForJob,
  updatePaymentState,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import { applyLocalSideEffectsAfterServerRelease } from '../../src/lib/workflow/releaseOperations'
import {
  ensureEscrowPlan,
  confirmFunding,
  recordWorkStarted,
  getEscrowTranches,
} from '../../src/lib/payments/escrow'
import type { Job } from '../../src/lib/jobs/types'

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-phase-1',
    projectId: 'project-phase-1',
    title: 'Badsanierung',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '€4.000',
    description: '',
    paymentState: 'work_in_progress',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craft-1',
    customerUserId: 'customer-1',
    ...overrides,
  }
}

describe('Attention selectors — 25 % auto-release phase', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('no urgent attention is emitted while work is in progress with partial release', async () => {
    const job = buildJob({
      status: 'in_progress',
      paymentState: 'work_in_progress',
    })
    await addJob(job)
    // Canonical payment truth aligns with the job mirror — the 25 % phase
    // must leave Payment.state at 'work_in_progress', not release_pending.
    await ensurePaymentForJob(job.id, 4000)
    await updatePaymentState(job.id, 'deposit_paid')
    await updatePaymentState(job.id, 'in_escrow')
    await updatePaymentState(job.id, 'work_in_progress')

    const items = deriveAttentionItems([job], [], 1_700_000_000_000)

    const urgentForJob = items.filter(
      (item) => item.jobId === job.id && item.severity === 'urgent'
    )
    expect(urgentForJob).toHaveLength(0)

    const customerItems = getAttentionItemsForRole(items, 'customer')
    expect(customerItems.filter((i) => i.jobId === job.id)).toHaveLength(0)

    const craftsmanItems = getAttentionItemsForRole(items, 'craftsman')
    expect(craftsmanItems.filter((i) => i.jobId === job.id)).toHaveLength(0)
  })

  it('applyLocalSideEffectsAfterServerRelease does NOT flip Payment.state to release_pending on partial release', async () => {
    const job = buildJob({
      id: 'job-partial-release',
      status: 'in_progress',
      paymentState: 'work_in_progress',
    })
    await addJob(job)
    await ensurePaymentForJob(job.id, 4000)
    await updatePaymentState(job.id, 'deposit_paid')
    await updatePaymentState(job.id, 'in_escrow')
    await updatePaymentState(job.id, 'work_in_progress')

    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-partial-${job.id}`,
      jobId: job.id,
      customerUserId: 'customer-1',
      providerId: 'craft-1',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!

    // Simulate the server-authoritative release returning 'partially_released'.
    await applyLocalSideEffectsAfterServerRelease(
      depositTranche.id,
      plan.id,
      'partially_released',
      job.id
    )

    const payment = getPaymentForJob(job.id)
    expect(payment?.state).toBe('work_in_progress')
    expect(payment?.state).not.toBe('release_pending')
  })
})

describe('Attention selectors — 75 % customer approval phase', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('customer sees urgent "Freigabe erforderlich", craftsman sees waiting "Wartet auf Kundenfreigabe"', async () => {
    const job = buildJob({
      id: 'job-approval-1',
      status: 'waiting_payment',
      paymentState: 'release_pending',
    })
    await addJob(job)
    await ensurePaymentForJob(job.id, 4000)
    await updatePaymentState(job.id, 'deposit_paid')
    await updatePaymentState(job.id, 'in_escrow')
    await updatePaymentState(job.id, 'work_in_progress')
    await updatePaymentState(job.id, 'release_pending')

    const items = deriveAttentionItems([job], [], 1_700_000_000_000)

    const customerItems = getAttentionItemsForRole(items, 'customer').filter(
      (i) => i.jobId === job.id
    )
    expect(customerItems).toHaveLength(1)
    expect(customerItems[0].severity).toBe('urgent')
    expect(customerItems[0].title).toBe('Freigabe erforderlich')

    const craftsmanItems = getAttentionItemsForRole(items, 'craftsman').filter(
      (i) => i.jobId === job.id
    )
    expect(craftsmanItems).toHaveLength(1)
    expect(craftsmanItems[0].severity).toBe('waiting')
    expect(craftsmanItems[0].title).toBe('Wartet auf Kundenfreigabe')
  })

  it('no doubled attention: release_pending suppresses the legacy waiting_payment craftsman branch', async () => {
    const job = buildJob({
      id: 'job-approval-dedup',
      status: 'waiting_payment',
      paymentState: 'release_pending',
    })
    await addJob(job)
    await ensurePaymentForJob(job.id, 4000)
    await updatePaymentState(job.id, 'deposit_paid')
    await updatePaymentState(job.id, 'in_escrow')
    await updatePaymentState(job.id, 'work_in_progress')
    await updatePaymentState(job.id, 'release_pending')

    const items = deriveAttentionItems([job], [], 1_700_000_000_000)

    const craftsmanItems = getAttentionItemsForRole(items, 'craftsman').filter(
      (i) => i.jobId === job.id
    )
    // Exactly one craftsman-facing attention item per phase — the
    // release_pending branch, never the legacy 'attn-waitpay-*' card.
    expect(craftsmanItems).toHaveLength(1)
    expect(craftsmanItems[0].id).not.toMatch(/^attn-waitpay-/)
    expect(craftsmanItems[0].id).toMatch(/^attn-release-/)
  })
})
