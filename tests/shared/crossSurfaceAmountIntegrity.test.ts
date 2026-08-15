/**
 * Cross-Surface Amount Integrity — Integration Tests
 *
 * Validates that the same accepted/funded project/order context shows one
 * consistent amount everywhere. Uses the real acceptance workflow to create
 * the full chain: offer → job → escrow → funding request.
 *
 * Covers:
 *   1. Accepted offer + booked job + escrow all resolve to same canonical amount
 *   2. Job completion summary uses correct euro formatting (not cents/100 bug)
 *   3. Payment prep amounts are consistent with canonical amount
 *   4. No decimal/comma regression
 *   5. No regression to funding/payment flows
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingForJob,
} from '../../src/lib/workflow'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { getJobById } from '../../src/lib/jobs'
import { getEscrowPlanByJobId } from '../../src/lib/payments/escrow'
import { getFundingRequestByJobId } from '../../src/lib/payments/fundingRequest'
import { getPaymentForJob } from '../../src/lib/payments'
import { resolveCanonicalAmount } from '../../src/lib/shared/canonicalAmountResolver'
import { resolveCanonicalProjectFacts } from '../../src/lib/shared/canonicalProjectFacts'
import { formatEuro } from '../../src/lib/shared/formatters'
import { deriveJobCompletionSummary } from '../../src/lib/jobs/jobCompletionSelectors'
import { derivePaymentPrepReadiness } from '../../src/lib/jobs/paymentPrepSelectors'
import { deriveQuotePaymentBasis } from '../../src/lib/offers/quotePaymentGating'
import { getOfferById } from '../../src/lib/offers/service'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-cross-1',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-cross-1',
    projectTitle: 'Cross-Surface Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

describe('Cross-Surface Amount Integrity — Full Workflow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('accepted offer, job, escrow, and funding request all carry the same amount', async () => {
    const conv = makeConversation('conv-integrity-1')
    addConversation(conv)

    // Create and accept offer for 5.000 €
    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '5.000 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    expect(accepted).toBeDefined()
    const jobId = accepted!.createdJobId!

    // Request funding (owner)
    installSessionForJobOwner({ craftsmanUserId: conv.craftsmanUserId })
    const fundingResult = await requestFundingForJob(jobId)
    expect(fundingResult.ok).toBe(true)

    // Get all entities
    const _job = getJobById(jobId)!
    const escrow = getEscrowPlanByJobId(jobId)!
    const funding = getFundingRequestByJobId(jobId)!
    const payment = getPaymentForJob(jobId)!

    // All must carry 5000 as amount
    expect(escrow.totalAmount).toBe(5000)
    expect(funding.amount).toBe(5000)
    expect(payment.amounts.totalAmount).toBe(5000)

    // Canonical resolver must agree
    const canonical = resolveCanonicalAmount(jobId)
    expect(canonical.amount).toBe(5000)
    expect(canonical.formatted).toBe(formatEuro(5000))
  })

  it('payment prep amounts are consistent with canonical amount', async () => {
    const conv = makeConversation('conv-integrity-2')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '3.200 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const jobId = accepted!.createdJobId!
    const job = getJobById(jobId)!
    const payment = getPaymentForJob(jobId)

    const prep = derivePaymentPrepReadiness(job, payment)
    expect(prep).not.toBeNull()

    // Canonical amount
    const canonical = resolveCanonicalAmount(jobId)

    // Payment prep must align with canonical
    if (prep!.agreedAmount !== null) {
      expect(prep!.agreedAmount).toBe(canonical.amount)
    }
  })

  it('quote payment basis uses same amount as canonical resolver', async () => {
    const conv = makeConversation('conv-integrity-3')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '1.850 €',
    })

    await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const acceptedOffer = getOfferById(offer.id)!
    const jobId = acceptedOffer.createdJobId!

    const basis = deriveQuotePaymentBasis(acceptedOffer)
    expect(basis).not.toBeNull()

    const canonical = resolveCanonicalAmount(jobId)

    expect(basis!.totalAmount).toBe(canonical.amount)
    // Both formatted amounts should be the canonical format
    expect(basis!.totalAmountFormatted).toBe(canonical.formatted)
  })

  it('job completion summary uses euro formatting (no cents/100 regression)', async () => {
    const conv = makeConversation('conv-integrity-4')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '2.300 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const jobId = accepted!.createdJobId!
    const payment = getPaymentForJob(jobId)!

    // Simulate completed job with released payment
    const { getJobRepository } = await import('../../src/lib/jobs/repository/registry')
    getJobRepository().update(jobId, (j) => ({
      ...j,
      status: 'completed',
      workCompletedAt: Date.now() - 5000,
      paymentReleasedAt: Date.now(),
    }))

    const { getPaymentRepository } = await import('../../src/lib/payments/repository/registry')
    getPaymentRepository().update(payment.id, (p) => ({
      ...p,
      state: 'released',
    }))

    const updatedJob = getJobById(jobId)!
    const updatedPayment = getPaymentForJob(jobId)!

    const summary = deriveJobCompletionSummary(updatedJob, updatedPayment)
    expect(summary).not.toBeNull()

    // formattedTotal must show the full euro amount, NOT divided by 100
    // Bug fix: was showing "23 €" instead of "2.300,00 €" due to cents/100 error
    expect(summary!.formattedTotal).toMatch(/2\.300,00\s*€/)
    expect(summary!.formattedTotal).not.toMatch(/^23[,.]?\s*€/)
  })

  // ── Patch C: server-authoritative amounts ────────────────────────────────

  it('rounding edge case: totalAmount not cleanly divisible by 4 → deposit+final exact', async () => {
    // 1.337€ = 133700 cents. 25% = 33425 cents = 334.25€ (exact).
    // 1.001€ = 100100 cents. 25% = 25025 cents = 250.25€. final = 750.75€. Sum = 1001.00 ✓
    // 1.111,11€: 25% = 277.7775 → rounds to 277.78. final = 833.33. Sum = 1111.11 ✓
    const cases = [1337, 1001, 1111.11, 999.99, 7777.77]
    for (const total of cases) {
      const { calculateTrancheAmounts } = await import('../../src/lib/payments/escrow')
      const { depositAmount, finalAmount } = calculateTrancheAmounts(total)
      expect(depositAmount + finalAmount).toBeCloseTo(total, 10)
      // Exact to-the-cent check (no floating point accumulated error)
      expect(Number((depositAmount + finalAmount).toFixed(2))).toBe(Number(total.toFixed(2)))
    }
  })

  it('paymentPrepSelectors uses payment.amounts when payment exists (not recomputed)', async () => {
    const conv = makeConversation('conv-integrity-patchc-1')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '3.600 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const jobId = accepted!.createdJobId!
    const payment = getPaymentForJob(jobId)!
    const job = getJobById(jobId)!

    const prep = derivePaymentPrepReadiness(job, payment)!
    expect(prep).not.toBeNull()

    // Amounts must come from the payment entity (server-committed) not recomputed
    expect(prep.depositAmount).toBe(payment.amounts.depositAmount)
    expect(prep.finalAmount).toBe(payment.amounts.finalAmount)

    // Verify no cent drift: server values sum to total
    expect(payment.amounts.depositAmount + payment.amounts.finalAmount).toBe(payment.amounts.totalAmount)
  })

  it('escrow job without payment: paymentPrepSelectors uses escrow plan amounts, not silent client fallback', async () => {
    const conv = makeConversation('conv-integrity-patchc-3')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '2.400 €',
    })

    // Accept offer (creates job + escrow plan) but don't create payment
    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const jobId = accepted!.createdJobId!
    const job = getJobById(jobId)!
    // Explicitly pass no payment to simulate pre-payment state
    const prep = derivePaymentPrepReadiness(job, undefined)

    expect(prep).not.toBeNull()
    expect(prep!.agreedAmount).toBe(2400)
    // Amounts from calculateTrancheAmounts(2400): deposit=600, final=1800
    expect(prep!.depositAmount).toBe(600)
    expect(prep!.finalAmount).toBe(1800)
    expect(prep!.depositAmount! + prep!.finalAmount!).toBe(prep!.agreedAmount!)
  })

  it('escrow plan now carries platformFeeRate and platformFeeAmount (no client derivation in moneyFlowProjection)', async () => {
    const conv = makeConversation('conv-integrity-patchc-4')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const acceptedOffer = getOfferById(offer.id)!
    const jobId = acceptedOffer.createdJobId!

    const escrowPlan = getEscrowPlanByJobId(jobId)
    expect(escrowPlan).not.toBeNull()

    // Platform fee is locked at plan creation — no client derivation needed
    expect(escrowPlan!.platformFeeRate).toBeDefined()
    expect(typeof escrowPlan!.platformFeeRate).toBe('number')
    expect(escrowPlan!.platformFeeAmount).toBeDefined()
    expect(typeof escrowPlan!.platformFeeAmount).toBe('number')

    // Fee amount must be consistent with fee rate and total
    const expectedFee = Number((escrowPlan!.totalAmount * escrowPlan!.platformFeeRate!).toFixed(2))
    expect(escrowPlan!.platformFeeAmount).toBe(expectedFee)
  })

  it('quotePaymentBasis deposit+final sums to total (no cent drift from calculateTrancheAmounts)', async () => {
    const conv = makeConversation('conv-integrity-patchc-2')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '1.337 €',  // odd number to stress-test rounding
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const acceptedOffer = getOfferById(accepted!.id)!
    const basis = deriveQuotePaymentBasis(acceptedOffer)!

    expect(basis.depositAmount! + basis.finalAmount!).toBe(basis.totalAmount!)
  })

  it('project facts resolve correctly for provider and customer surfaces', async () => {
    const conv = makeConversation('conv-integrity-5')
    addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      craftsmanUserId: conv.craftsmanUserId,
      customerUserId: conv.customerUserId,
      price: '4.750 €',
    })

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
    const jobId = accepted!.createdJobId!

    const facts = resolveCanonicalProjectFacts(jobId)
    expect(facts).not.toBeNull()
    expect(facts!.canonicalAmount.amount).toBe(4750)
    expect(facts!.canonicalAmount.formatted).toMatch(/4\.750,00\s*€/)
    expect(facts!.title).toBeTruthy()
  })
})
