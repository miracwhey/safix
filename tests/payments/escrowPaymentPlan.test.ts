/**
 * Escrow Payment Plan Foundation — Tests
 *
 * Validates the full escrow payment plan lifecycle created from an
 * accepted quote, including:
 *   1. Accepted quote creates a persistent payment plan
 *   2. Payment plan links to accepted quote and job
 *   3. Exactly two persisted tranches for the 25/75 model
 *   4. Tranche amounts sum to accepted quote total
 *   5. Idempotent: retries do not duplicate plans or tranches
 *   6. Reload/re-entry preserves payment plan state
 *   7. Thread/detail state derives from persisted payment basis
 *   8. No regression to quote accept/decline/locking
 *   9. No regression to relationship-thread logic
 *  10. No regression to participant scoping
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { addConversation } from '../../src/lib/messages'
import { getJobById } from '../../src/lib/jobs'
import { getOfferById } from '../../src/lib/offers'
import { getPaymentForJob } from '../../src/lib/payments'
import {
  getEscrowPlanByOfferId,
  getEscrowPlanByJobId,
  getEscrowTranches,
  ensureEscrowPlan,
  deriveEscrowPlanSummary,
  getEscrowPlanStatusLabel,
  getEscrowTrancheStatusLabel,
} from '../../src/lib/payments/escrow'
import { getEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ────────────────────────────────────────────────────────────────

let convCounter = 0

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  convCounter += 1
  return {
    id: `conv-escrow-${convCounter}`,
    projectId: `project_escrow_${convCounter}`,
    customerName: 'Max Mustermann',
    customerUserId: 'customer-escrow',
    craftsmanUserId: 'craftsman-escrow',
    projectTitle: 'Küche Renovation',
    projectLocation: 'Berlin',
    messages: [
      {
        id: `msg-escrow-${convCounter}`,
        sender: 'user',
        text: 'Anfrage',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Accepted quote creates a persistent payment plan
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — accepted quote creates a persistent payment plan', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 0
  })

  it('acceptOfferWorkflow creates an escrow payment plan', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const plan = getEscrowPlanByOfferId(offer.id)
    expect(plan).toBeDefined()
    expect(plan!.sourceOfferId).toBe(offer.id)
    expect(plan!.status).toBe('awaiting_customer_funding')
    expect(plan!.fundingMode).toBe('full_upfront_escrow')
    expect(plan!.releaseModel).toBe('start_25_completion_75')
  })

  it('plan has correct total amount from accepted quote', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '8.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const plan = getEscrowPlanByOfferId(offer.id)
    expect(plan).toBeDefined()
    expect(plan!.totalAmount).toBe(8000)
    expect(plan!.currency).toBe('EUR')
  })

  it('no plan is created for pending quotes', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.000 €',
    })

    const plan = getEscrowPlanByOfferId(offer.id)
    expect(plan).toBeUndefined()
  })

  it('no plan is created for declined quotes', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.000 €',
    })

    await declineOfferWorkflow(offer.id)

    const plan = getEscrowPlanByOfferId(offer.id)
    expect(plan).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Payment plan links to accepted quote and job
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — payment plan links to accepted quote and job', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 100
  })

  it('plan has correct sourceOfferId and jobId', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '5.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)

    expect(plan).toBeDefined()
    expect(plan!.sourceOfferId).toBe(offer.id)
    expect(plan!.jobId).toBe(accepted!.createdJobId)
  })

  it('plan is queryable by jobId', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '6.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByJobId(accepted!.createdJobId!)

    expect(plan).toBeDefined()
    expect(plan!.sourceOfferId).toBe(offer.id)
  })

  it('plan has correct customer and provider IDs', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '7.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)

    expect(plan).toBeDefined()
    expect(plan!.customerUserId).toBe('customer-escrow')
    // providerId is the resolved providers.id or craftsmanUserId fallback
    expect(plan!.providerId).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Exactly two persisted tranches for the 25/75 model
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — exactly two persisted tranches for the 25/75 model', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 200
  })

  it('creates exactly two tranches on acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '10.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)

    expect(tranches).toHaveLength(2)
  })

  it('tranche 1 is deposit_release with 25% and work_started trigger', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '10.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')

    expect(deposit).toBeDefined()
    expect(deposit!.percentage).toBe(25)
    expect(deposit!.releaseTrigger).toBe('work_started')
    expect(deposit!.status).toBe('pending_funding')
  })

  it('tranche 2 is final_release with 75% and work_completed trigger', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '10.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)
    const final = tranches.find((t) => t.kind === 'final_release')

    expect(final).toBeDefined()
    expect(final!.percentage).toBe(75)
    expect(final!.releaseTrigger).toBe('work_completed')
    expect(final!.status).toBe('pending_funding')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Tranche amounts sum to accepted quote total
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — tranche amounts sum to accepted quote total', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 300
  })

  it('deposit (25%) + final (75%) = total amount for round numbers', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!

    expect(deposit.amount).toBe(1000)
    expect(final.amount).toBe(3000)
    expect(deposit.amount + final.amount).toBe(plan.totalAmount)
  })

  it('handles non-round totals correctly', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.333 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!

    // 25% of 3333 = 833.25, final = 3333 - 833.25 = 2499.75
    expect(deposit.amount + final.amount).toBe(plan.totalAmount)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Idempotent: retries do not duplicate plans or tranches
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — idempotent: retries do not duplicate plans or tranches', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 400
  })

  it('repeated acceptOfferWorkflow does not duplicate plan', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    await acceptOfferWorkflow(offer.id)
    await acceptOfferWorkflow(offer.id)

    const allPlans = getEscrowPlanRepository().getAllPlans()
    const plansForOffer = allPlans.filter((p) => p.sourceOfferId === offer.id)
    expect(plansForOffer).toHaveLength(1)
  })

  it('repeated acceptOfferWorkflow does not duplicate tranches', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan1 = getEscrowPlanByOfferId(offer.id)!

    await acceptOfferWorkflow(offer.id)

    const tranches = getEscrowTranches(plan1.id)
    expect(tranches).toHaveLength(2)
  })

  it('ensureEscrowPlan is idempotent with same offerId', async () => {
    const plan1 = await ensureEscrowPlan({
      sourceOfferId: 'offer-idem-1',
      jobId: 'job-idem-1',
      customerUserId: 'cust-1',
      providerId: 'prov-1',
      totalAmount: 2000,
    })

    const plan2 = await ensureEscrowPlan({
      sourceOfferId: 'offer-idem-1',
      jobId: 'job-idem-1',
      customerUserId: 'cust-1',
      providerId: 'prov-1',
      totalAmount: 2000,
    })

    expect(plan1.id).toBe(plan2.id)
    expect(getEscrowPlanRepository().getAllPlans()).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Reload/re-entry preserves payment plan state
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — reload/re-entry preserves payment plan state', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 500
  })

  it('escrow plan survives simulated re-entry via acceptOfferWorkflow', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '6.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const planBefore = getEscrowPlanByOfferId(offer.id)
    expect(planBefore).toBeDefined()

    // Simulate re-entry: call accept again (idempotent path)
    await acceptOfferWorkflow(offer.id)
    const planAfter = getEscrowPlanByOfferId(offer.id)
    expect(planAfter).toBeDefined()
    expect(planAfter!.id).toBe(planBefore!.id)
    expect(planAfter!.totalAmount).toBe(planBefore!.totalAmount)
  })

  it('escrow plan data is consistent after re-entry', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '9.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)

    // Re-entry should not change the plan or tranches
    await acceptOfferWorkflow(offer.id)

    const planAfter = getEscrowPlanByOfferId(offer.id)!
    const tranchesAfter = getEscrowTranches(plan.id)

    expect(planAfter.id).toBe(plan.id)
    expect(planAfter.totalAmount).toBe(plan.totalAmount)
    expect(tranchesAfter).toHaveLength(tranches.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Thread/detail state derives from persisted payment basis
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — thread/detail state derives from persisted payment basis', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 600
  })

  it('deriveEscrowPlanSummary returns plan and tranches for accepted offer', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '4.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const summary = deriveEscrowPlanSummary(offer.id)
    expect(summary).not.toBeNull()
    expect(summary!.plan.totalAmount).toBe(4000)
    expect(summary!.tranches).toHaveLength(2)
    expect(summary!.depositTranche).toBeDefined()
    expect(summary!.depositTranche!.percentage).toBe(25)
    expect(summary!.finalTranche).toBeDefined()
    expect(summary!.finalTranche!.percentage).toBe(75)
  })

  it('deriveEscrowPlanSummary returns null for non-accepted offer', () => {
    const summary = deriveEscrowPlanSummary('nonexistent-offer')
    expect(summary).toBeNull()
  })

  it('escrow plan and payment (Payment type) coexist for same job', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '7.200 €',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    // Both the existing Payment object and the new EscrowPaymentPlan exist
    const payment = getPaymentForJob(job.id)
    const escrowPlan = getEscrowPlanByJobId(job.id)

    expect(payment).toBeDefined()
    expect(escrowPlan).toBeDefined()

    // They should have consistent amounts
    expect(payment!.amounts.totalAmount).toBe(escrowPlan!.totalAmount)
  })

  it('status labels return German strings', () => {
    expect(getEscrowPlanStatusLabel('awaiting_customer_funding')).toBe('Zahlung ausstehend')
    expect(getEscrowPlanStatusLabel('funded_in_escrow')).toBe('Vollständig über Stripe abgesichert')
    expect(getEscrowTrancheStatusLabel('pending_funding')).toBe('Einzahlung ausstehend')
    expect(getEscrowTrancheStatusLabel('released')).toBe('Freigegeben')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. No regression to quote accept/decline/locking
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — no regression to quote accept/decline/locking', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 700
  })

  it('accepted offer remains locked and immutable', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted!.status).toBe('accepted')
    expect(accepted!.acceptedAt).toBeDefined()
    expect(accepted!.lockedAt).toBeDefined()
  })

  it('declined offer cannot be accepted', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.000 €',
    })

    await declineOfferWorkflow(offer.id)

    await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow()
  })

  it('acceptance is still idempotent', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '1.500 €',
    })

    const first = await acceptOfferWorkflow(offer.id)
    const second = await acceptOfferWorkflow(offer.id)

    expect(second!.status).toBe('accepted')
    expect(second!.createdJobId).toBe(first!.createdJobId)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. No regression to relationship-thread logic
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — no regression to relationship-thread logic', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 800
  })

  it('accepted offer still creates a job linked to conversation', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '2.500 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    expect(accepted!.createdJobId).toBeDefined()

    const job = getJobById(accepted!.createdJobId!)
    expect(job).toBeDefined()
    expect(job!.sourceConversationId).toBe(conv.id)
    expect(job!.sourceOfferId).toBe(offer.id)
  })

  it('job has correct sourceOfferId linking to the accepted offer', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '3.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id)
    const job = getJobById(accepted!.createdJobId!)!

    expect(job.sourceOfferId).toBe(offer.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. No regression to participant scoping
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — no regression to participant scoping', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 900
  })

  it('escrow plan has correct customer and provider from the accepted offer', async () => {
    const conv = makeConversation({
      customerUserId: 'scoped-customer',
      craftsmanUserId: 'scoped-craftsman',
    })
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'scoped-customer',
      craftsmanUserId: 'scoped-craftsman',
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)
    const plan = getEscrowPlanByOfferId(offer.id)!

    expect(plan.customerUserId).toBe('scoped-customer')
    // providerId may be craftsmanUserId if resolveProviderId fails in test
    expect(plan.providerId).toBeDefined()
  })

  it('payment linkage still has correct offerId after escrow plan creation', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-escrow',
      craftsmanUserId: 'craftsman-escrow',
      price: '4.500 €',
    })

    await acceptOfferWorkflow(offer.id)
    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    const payment = getPaymentForJob(job.id)

    expect(payment).toBeDefined()
    expect(payment!.offerId).toBe(offer.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Forward compatibility
// ═══════════════════════════════════════════════════════════════════════════

describe('forward compatibility — state model supports future states', () => {
  beforeEach(() => {
    setupCleanRepositories()
    convCounter = 1000
  })

  it('all plan statuses have labels', () => {
    const statuses = [
      'awaiting_customer_funding',
      'funded_in_escrow',
      'partially_released',
      'fully_released',
      'disputed',
      'refunded',
      'cancelled',
    ] as const

    for (const s of statuses) {
      expect(getEscrowPlanStatusLabel(s)).toBeTruthy()
    }
  })

  it('all tranche statuses have labels', () => {
    const statuses = [
      'pending_funding',
      'funded',
      'locked',
      'eligible_for_release',
      'released',
      'blocked',
      'disputed',
      'refunded',
      'cancelled',
    ] as const

    for (const s of statuses) {
      expect(getEscrowTrancheStatusLabel(s)).toBeTruthy()
    }
  })

  it('plan model includes disputed/refunded/cancelled states', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: 'offer-fwd-1',
      jobId: 'job-fwd-1',
      customerUserId: 'cust-fwd',
      providerId: 'prov-fwd',
      totalAmount: 1000,
    })

    // The model accepts these statuses via its type system.
    // We just verify the plan can be updated to future states.
    const repo = getEscrowPlanRepository()
    repo.updatePlan(plan.id, (p) => ({ ...p, status: 'disputed' }))
    expect(repo.getPlanById(plan.id)!.status).toBe('disputed')

    repo.updatePlan(plan.id, (p) => ({ ...p, status: 'refunded' }))
    expect(repo.getPlanById(plan.id)!.status).toBe('refunded')

    repo.updatePlan(plan.id, (p) => ({ ...p, status: 'cancelled' }))
    expect(repo.getPlanById(plan.id)!.status).toBe('cancelled')
  })

  it('tranche model supports blocked/disputed/refunded states', async () => {
    await ensureEscrowPlan({
      sourceOfferId: 'offer-fwd-2',
      jobId: 'job-fwd-2',
      customerUserId: 'cust-fwd',
      providerId: 'prov-fwd',
      totalAmount: 2000,
    })

    const plan = getEscrowPlanByOfferId('offer-fwd-2')!
    const tranches = getEscrowTranches(plan.id)
    const repo = getEscrowPlanRepository()

    // Update first tranche to blocked
    repo.updateTranche(tranches[0].id, (t) => ({ ...t, status: 'blocked' }))
    const updated = getEscrowTranches(plan.id)
    const blockedTranche = updated.find((t) => t.id === tranches[0].id)
    expect(blockedTranche!.status).toBe('blocked')
  })
})
