/**
 * Quote-Based Payment Gating Tests
 *
 * Validates the core payment gating rules:
 * 1. pending quote does not unlock payment readiness
 * 2. declined quote does not unlock payment readiness
 * 3. accepted quote unlocks payment readiness
 * 4. payment basis amount derives from accepted quote
 * 5. thread and detail screen remain aligned after accept
 * 6. payment-related state persists after reload/re-entry
 * 7. no regression to quote lifecycle
 * 8. no regression to relationship-thread logic
 * 9. no regression to project history/thread artifacts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  isQuotePaymentReady,
  deriveQuotePaymentBasis,
  getQuotePaymentGatingReason,
} from '../../src/lib/offers/quotePaymentGating'
import type { Offer, OfferStatus } from '../../src/lib/offers/types'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  declineOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { addConversation } from '../../src/lib/messages'
import { getJobById } from '../../src/lib/jobs'
import { getOfferById } from '../../src/lib/offers'
import { getPaymentForJob } from '../../src/lib/payments'
import { getActionablePaymentState, isJobOperational } from '../../src/lib/jobs/helpers'
import { derivePaymentPrepReadiness, parseJobAmount } from '../../src/lib/jobs/paymentPrepSelectors'
import { getJobContextForThread } from '../../src/lib/workflow/messageWorkflow'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveNextAction } from '../../src/lib/jobs/nextActionSelectors'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import { syncAllProjectsFromJobs } from '../../src/lib/projects/projectJobSyncBridge'
import type { Conversation } from '../../src/lib/messages/types'

// ── Test helpers ──────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-gating-test',
    projectId: 'project_gating',
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-gate',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-hw',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-gate',
    projectTitle: 'Küche Renovation',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3.000 – 6.000',
    projectDuration: '2 Wochen',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'profile',
    messages: [
      {
        id: 'msg-gate',
        sender: 'user',
        text: 'Anfrage',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

function buildOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-test',
    conversationId: 'conv-gating-test',
    customerUserId: 'customer-gate',
    craftsmanUserId: 'craftsman-gate',
    price: '5.000 €',
    status: 'pending',
    sentAt: Date.now() - 5000,
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 5000,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pending quote does NOT unlock payment readiness
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — pending quote does not unlock payment readiness', () => {
  it('isQuotePaymentReady returns false for pending offer', () => {
    const offer = buildOffer({ status: 'pending' })
    expect(isQuotePaymentReady(offer)).toBe(false)
  })

  it('deriveQuotePaymentBasis returns null for pending offer', () => {
    const offer = buildOffer({ status: 'pending' })
    expect(deriveQuotePaymentBasis(offer)).toBeNull()
  })

  it('getQuotePaymentGatingReason returns not-ready with pending code', () => {
    const offer = buildOffer({ status: 'pending' })
    const reason = getQuotePaymentGatingReason(offer)
    expect(reason.ready).toBe(false)
    expect(reason.code).toBe('pending')
    expect(reason.explanation).toContain('offen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Declined quote does NOT unlock payment readiness
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — declined quote does not unlock payment readiness', () => {
  it('isQuotePaymentReady returns false for declined offer', () => {
    const offer = buildOffer({ status: 'declined', declinedAt: Date.now() })
    expect(isQuotePaymentReady(offer)).toBe(false)
  })

  it('deriveQuotePaymentBasis returns null for declined offer', () => {
    const offer = buildOffer({ status: 'declined', declinedAt: Date.now() })
    expect(deriveQuotePaymentBasis(offer)).toBeNull()
  })

  it('getQuotePaymentGatingReason returns not-ready with declined code', () => {
    const offer = buildOffer({ status: 'declined', declinedAt: Date.now() })
    const reason = getQuotePaymentGatingReason(offer)
    expect(reason.ready).toBe(false)
    expect(reason.code).toBe('declined')
    expect(reason.explanation).toContain('abgelehnt')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Accepted quote UNLOCKS payment readiness
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — accepted quote unlocks payment readiness', () => {
  it('isQuotePaymentReady returns true for accepted offer', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      lockedAt: Date.now(),
      createdJobId: 'job-1',
    })
    expect(isQuotePaymentReady(offer)).toBe(true)
  })

  it('deriveQuotePaymentBasis returns basis for accepted offer', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      lockedAt: Date.now(),
      createdJobId: 'job-1',
      price: '3.000 €',
    })
    const basis = deriveQuotePaymentBasis(offer)
    expect(basis).not.toBeNull()
    expect(basis!.offerId).toBe('offer-test')
    expect(basis!.totalAmount).toBe(3000)
    expect(basis!.createdJobId).toBe('job-1')
  })

  it('getQuotePaymentGatingReason returns ready with accepted code', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
    })
    const reason = getQuotePaymentGatingReason(offer)
    expect(reason.ready).toBe(true)
    expect(reason.code).toBe('accepted')
    expect(reason.explanation).toContain('angenommen')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Payment basis amount derives from accepted quote
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — payment basis amount derives from accepted quote', () => {
  it('totalAmount parsed from offer.price', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      price: '2.300 €',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.totalAmount).toBe(2300)
  })

  it('deposit is 25% of total', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      price: '4.000 €',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.depositAmount).toBe(1000)
    expect(basis.finalAmount).toBe(3000)
    expect(basis.depositPercent).toBe(25)
  })

  it('formatted amounts are present', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      price: '1.500 €',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.totalAmountFormatted).toBeTruthy()
    expect(basis.depositAmountFormatted).toBeTruthy()
    expect(basis.finalAmountFormatted).toBeTruthy()
  })

  it('acceptedAt is set from the offer', () => {
    const at = Date.now()
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: at,
      price: '1.000 €',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.acceptedAt).toBe(at)
  })

  it('changeOrderAdjustment is null (reserved for future)', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      price: '1.000 €',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.changeOrderAdjustment).toBeNull()
  })

  it('handles unparseable price gracefully', () => {
    const offer = buildOffer({
      status: 'accepted',
      acceptedAt: Date.now(),
      price: 'auf Anfrage',
    })
    const basis = deriveQuotePaymentBasis(offer)!
    expect(basis.totalAmount).toBeNull()
    expect(basis.totalAmountFormatted).toBeNull()
    expect(basis.depositAmount).toBeNull()
  })

  it('does not derive basis for non-accepted offers regardless of price', () => {
    const statuses: OfferStatus[] = [
      'draft', 'pending', 'declined', 'expired', 'superseded', 'cancelled',
    ]
    for (const status of statuses) {
      const offer = buildOffer({ status, price: '10.000 €' })
      expect(deriveQuotePaymentBasis(offer)).toBeNull()
    }
  })

  it('null offer returns null basis', () => {
    expect(deriveQuotePaymentBasis(null)).toBeNull()
    expect(deriveQuotePaymentBasis(undefined)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Thread and detail screen remain aligned after accept
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — thread and detail screen aligned after accept', () => {
  beforeEach(() => setupCleanRepositories())

  it('job payment state matches offer payment readiness after acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '6.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!
    const payment = getPaymentForJob(job.id)

    // Quote-level: payment ready
    expect(isQuotePaymentReady(accepted)).toBe(true)

    // Job-level: operational and payment state active
    expect(isJobOperational(job)).toBe(true)
    expect(getActionablePaymentState(job, payment)).toBe('deposit_required')

    // Quote basis matches job/payment amounts
    const basis = deriveQuotePaymentBasis(accepted)!
    expect(basis.totalAmount).toBe(parseJobAmount(accepted.price))
    expect(payment!.amounts.totalAmount).toBe(basis.totalAmount)
  })

  it('thread job context shows payment state consistent with quote basis', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '3.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const context = getJobContextForThread(conv.id)
    expect(context).not.toBeNull()
    expect(context!.paymentState).toBe('deposit_required')

    // Payment state label should mention deposit
    expect(context!.paymentStateLabel).toContain('Zahlung')
  })

  it('deriveNextAction aligns with quote payment readiness after acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '4.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    // Both craftsman and customer next actions should reference payment
    const craftsmanAction = deriveNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(craftsmanAction.domain).toBe('payment')
    expect(craftsmanAction.label).toContain('Zahlung')

    const customerAction = deriveCustomerNextAction(
      job.status, job.paymentState, undefined,
      job.proposalSentAt, job.proposalAcceptedAt
    )
    expect(customerAction.domain).toBe('payment')
    expect(customerAction.label).toContain('Zahlung')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Payment-related state persists after reload/re-entry
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — payment state persists after reload/re-entry', () => {
  beforeEach(() => setupCleanRepositories())

  it('accepted offer payment basis survives simulated sync cycle', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '5.800 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Simulate reload: re-sync projects
    await syncAllProjectsFromJobs()

    // Quote-level remains stable
    const acceptedOffer = getOfferById(offer.id)!
    expect(isQuotePaymentReady(acceptedOffer)).toBe(true)
    const basis = deriveQuotePaymentBasis(acceptedOffer)!
    expect(basis.totalAmount).toBe(5800)

    // Job-level remains stable
    const job = getJobById(acceptedOffer.createdJobId!)!
    expect(isJobOperational(job)).toBe(true)
    expect(getActionablePaymentState(job)).toBe('deposit_required')
  })

  it('payment prep readiness remains available after sync', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '7.200 €',
    })

    await acceptOfferWorkflow(offer.id)

    await syncAllProjectsFromJobs()

    const acceptedOffer = getOfferById(offer.id)!
    const job = getJobById(acceptedOffer.createdJobId!)!
    const payment = getPaymentForJob(job.id)

    const prep = derivePaymentPrepReadiness(job, payment)
    expect(prep).not.toBeNull()
    expect(prep!.agreedAmount).toBe(7200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. No regression to quote lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — no regression to quote lifecycle', () => {
  beforeEach(() => setupCleanRepositories())

  it('accepted offer remains locked and immutable', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '3.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    expect(accepted.status).toBe('accepted')
    expect(accepted.acceptedAt).toBeDefined()
    expect(accepted.lockedAt).toBeDefined()
    expect(accepted.createdJobId).toBeDefined()
  })

  it('declined offer cannot become payment-ready', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '3.000 €',
    })

    await declineOfferWorkflow(offer.id)

    const declined = getOfferById(offer.id)!
    expect(declined.status).toBe('declined')
    expect(isQuotePaymentReady(declined)).toBe(false)
    expect(deriveQuotePaymentBasis(declined)).toBeNull()
  })

  it('pending offer does not create payment entities', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '3.000 €',
    })

    // Offer is pending — no job/payment should exist yet
    const pending = getOfferById(offer.id)!
    expect(pending.status).toBe('pending')
    expect(pending.createdJobId).toBeUndefined()
    expect(isQuotePaymentReady(pending)).toBe(false)
  })

  it('expired/superseded/cancelled offer statuses block payment', () => {
    for (const status of ['expired', 'superseded', 'cancelled'] as OfferStatus[]) {
      const offer = buildOffer({ status })
      expect(isQuotePaymentReady(offer)).toBe(false)
      expect(deriveQuotePaymentBasis(offer)).toBeNull()
      const reason = getQuotePaymentGatingReason(offer)
      expect(reason.ready).toBe(false)
      expect(reason.code).toBe(status)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. No regression to relationship-thread logic
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — no regression to relationship-thread logic', () => {
  beforeEach(() => setupCleanRepositories())

  it('thread artifacts resolve correctly after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '4.000 €',
    })

    // Before acceptance: offer artifact should exist
    const beforeArtifacts = getThreadArtifacts(conv.id)
    expect(beforeArtifacts.offerPaymentArtifact).not.toBeNull()
    expect(beforeArtifacts.offerPaymentArtifact?.phase).toBe('sent')

    await acceptOfferWorkflow(offer.id)

    // After acceptance: offer artifact should show accepted/payment_due phase
    const afterArtifacts = getThreadArtifacts(conv.id)
    expect(afterArtifacts.offerPaymentArtifact).not.toBeNull()
    const phase = afterArtifacts.offerPaymentArtifact!.phase
    expect(['accepted', 'payment_due']).toContain(phase)
  })

  it('job created from accepted offer has sourceOfferId set', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '2.500 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    expect(job.sourceOfferId).toBe(offer.id)
    expect(job.sourceConversationId).toBe(conv.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. No regression to project history/thread artifacts
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — no regression to project history/thread artifacts', () => {
  beforeEach(() => setupCleanRepositories())

  it('project sync does not break after offer acceptance', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '5.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    // Sync should not throw or break state
    await syncAllProjectsFromJobs()

    const accepted = getOfferById(offer.id)!
    const job = getJobById(accepted.createdJobId!)!

    // Job and offer remain consistent
    expect(job.amount).toBe(accepted.price)
    expect(isJobOperational(job)).toBe(true)
    expect(accepted.status).toBe('accepted')
  })

  it('payment entity amounts match the quote basis', async () => {
    const conv = makeConversation()
    await addConversation(conv)

    const offer = await createOfferWorkflow({
      conversationId: conv.id,
      customerUserId: 'customer-gate',
      craftsmanUserId: 'craftsman-gate',
      price: '8.000 €',
    })

    await acceptOfferWorkflow(offer.id)

    const accepted = getOfferById(offer.id)!
    const payment = getPaymentForJob(accepted.createdJobId!)!

    const basis = deriveQuotePaymentBasis(accepted)!

    // Payment amounts must match the quote basis exactly
    expect(payment.amounts.totalAmount).toBe(basis.totalAmount)
    expect(payment.amounts.depositAmount).toBe(basis.depositAmount)
    expect(payment.amounts.finalAmount).toBe(basis.finalAmount)
    expect(payment.offerId).toBe(accepted.id)
  })

  it('getQuotePaymentGatingReason for null/undefined offer is safe', () => {
    const reason = getQuotePaymentGatingReason(null)
    expect(reason.ready).toBe(false)
    expect(reason.code).toBe('no_offer')

    const reasonUndef = getQuotePaymentGatingReason(undefined)
    expect(reasonUndef.ready).toBe(false)
    expect(reasonUndef.code).toBe('no_offer')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Additional: Full gating across all non-accepted statuses
// ═══════════════════════════════════════════════════════════════════════════

describe('gating — all non-accepted statuses produce no payment readiness', () => {
  const nonAcceptedStatuses: OfferStatus[] = [
    'draft', 'pending', 'declined', 'expired', 'superseded', 'cancelled',
  ]

  for (const status of nonAcceptedStatuses) {
    it(`status "${status}" is not payment-ready`, () => {
      const offer = buildOffer({ status, price: '10.000 €' })
      expect(isQuotePaymentReady(offer)).toBe(false)
      expect(deriveQuotePaymentBasis(offer)).toBeNull()
    })
  }
})
