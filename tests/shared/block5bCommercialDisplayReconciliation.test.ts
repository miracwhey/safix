/**
 * Block 5B — Canonical Commercial Display Reconciliation
 *
 * Tests the specific failure classes identified in the Block 5B package:
 *
 * 1. Same accepted/booked/funded context no longer shows conflicting amounts
 * 2. Provider and customer surfaces resolve same canonical commercial truth
 * 3. Order value vs escrow total vs tranche amount are semantically distinct
 * 4. Accidental double-counting is impossible
 * 5. Already-funded contexts no longer show stale unpaid display
 * 6. No regression to Blocks 1–5A
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { resolveCanonicalAmount } from '../../src/lib/shared/canonicalAmountResolver'
import { resolveCommercialDisplayContext } from '../../src/lib/shared/canonicalCommercialDisplay'
import { resolveCanonicalProviderDetail } from '../../src/lib/shared/canonicalProviderDetail'
import { deriveCustomerDepositAction } from '../../src/lib/jobs/customerDepositSelectors'
import { derivePaymentPrepReadiness } from '../../src/lib/jobs/paymentPrepSelectors'
import { formatEuro } from '../../src/lib/shared/formatters'
import { calculateTrancheAmounts } from '../../src/lib/payments/escrow/escrowService'

import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryOfferRepository } from '../../src/lib/offers/repository/InMemoryOfferRepository'
import { setOfferRepository } from '../../src/lib/offers/repository/registry'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import { setPaymentRepository } from '../../src/lib/payments/repository/registry'

import type { Job } from '../../src/lib/jobs/types'
import type { Offer } from '../../src/lib/offers/types'
import type { Payment } from '../../src/lib/payments/types'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow/escrowTypes'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Bad renovieren',
    customer: 'Anna Kundin',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '1.000 €',
    description: 'Badezimmer-Renovierung',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    sourceConversationId: 'conv-1',
    sourceOfferId: 'offer-1',
    proposalAcceptedAt: Date.now(),
    ...overrides,
  }
}

function makeOffer(overrides?: Partial<Offer>): Offer {
  return {
    id: 'offer-1',
    conversationId: 'conv-1',
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    price: '1.000 €',
    status: 'accepted',
    sentAt: Date.now() - 10000,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    acceptedAt: Date.now(),
    createdJobId: 'job-1',
    ...overrides,
  }
}

function makeEscrowPlan(overrides?: Partial<EscrowPaymentPlan>): EscrowPaymentPlan {
  return {
    id: 'plan-1',
    sourceOfferId: 'offer-1',
    jobId: 'job-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    currency: 'EUR',
    totalAmount: 1000,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'awaiting_customer_funding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makePayment(overrides?: Partial<Payment>): Payment {
  return {
    id: 'payment-1',
    jobId: 'job-1',
    state: 'deposit_required',
    amounts: {
      totalAmount: 1000,
      depositAmount: 250,
      finalAmount: 750,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeProject(overrides?: Partial<ProjectCase>): ProjectCase {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Bad renovieren',
    customer: 'Anna Kundin',
    craftsman: 'Peter Handwerker',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    price: '1.000 €',
    status: 'accepted',
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Seeds the full job → offer → escrow → payment context with 1000 € order value.
 */
function seedFullContext(overrides?: {
  job?: Partial<Job>
  offer?: Partial<Offer>
  escrow?: Partial<EscrowPaymentPlan>
  payment?: Partial<Payment>
}) {
  const job = makeJob(overrides?.job)
  const offer = makeOffer(overrides?.offer)
  const escrow = makeEscrowPlan(overrides?.escrow)
  const payment = makePayment(overrides?.payment)

  setJobRepository(new InMemoryJobRepository([job]))
  setOfferRepository(new InMemoryOfferRepository([offer]))
  const escrowRepo = new InMemoryEscrowPlanRepository()
  escrowRepo.addPlan(escrow)
  setEscrowPlanRepository(escrowRepo)
  setPaymentRepository(new InMemoryPaymentRepository([payment]))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Block 5B — Canonical Commercial Display Reconciliation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Same context never shows conflicting amounts
  // ═══════════════════════════════════════════════════════════════════════

  describe('1. same context shows consistent amounts across all surfaces', () => {
    it('canonical amount, commercial display, and customer deposit all agree on order value', () => {
      seedFullContext()

      const canonical = resolveCanonicalAmount('job-1')
      const commercial = resolveCommercialDisplayContext('job-1')
      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), undefined
      )

      // All surfaces derive same order value
      expect(canonical.amount).toBe(1000)
      expect(commercial.orderValue.amount).toBe(1000)
      expect(customerVm!.agreedAmount).toBe(1000)
    })

    it('canonical amount and payment prep readiness agree on order value', () => {
      seedFullContext()

      const canonical = resolveCanonicalAmount('job-1')
      const prepVm = derivePaymentPrepReadiness(makeJob(), makePayment())

      expect(canonical.amount).toBe(1000)
      expect(prepVm!.agreedAmount).toBe(1000)
    })

    it('provider commercial context matches canonical amount', () => {
      seedFullContext()
      setProjectRepository(new InMemoryProjectRepository([makeProject()]))

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail).not.toBeNull()
      expect(detail!.commercial.canonicalAmount.amount).toBe(1000)
      expect(detail!.commercial.escrowAmount).toBe(1000)
      expect(detail!.commercial.amountsAligned).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Customer deposit view model uses canonical amount (not payment.amounts)
  // ═══════════════════════════════════════════════════════════════════════

  describe('2. customer deposit action uses canonical amount', () => {
    it('agreedAmount comes from canonical resolver, not payment.amounts.totalAmount', () => {
      // Create a scenario where payment.amounts.totalAmount differs from
      // escrow plan total (simulating legacy mismatch)
      seedFullContext({
        payment: {
          amounts: { totalAmount: 9999, depositAmount: 2500, finalAmount: 7499 },
        },
      })

      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment({
          amounts: { totalAmount: 9999, depositAmount: 2500, finalAmount: 7499 },
        }), undefined
      )

      // Must use canonical (escrow = 1000), NOT payment.amounts.totalAmount (9999)
      expect(customerVm!.agreedAmount).toBe(1000)
    })

    it('deposit amount equals 100% of agreed total (full-upfront model)', () => {
      seedFullContext()

      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), undefined
      )

      // Full-upfront: deposit = full amount, remaining = 0
      expect(customerVm!.depositAmount).toBe(1000)
      expect(customerVm!.remainingAmount).toBe(0)
      expect(customerVm!.depositPercent).toBe(100)
    })

    it('falls back to parseJobAmount when no payment and no escrow', () => {
      // Only job exists, no offer, no escrow, no payment
      setJobRepository(new InMemoryJobRepository([
        makeJob({ sourceOfferId: undefined, amount: '800 €' }),
      ]))

      const customerVm = deriveCustomerDepositAction(
        makeJob({ sourceOfferId: undefined, amount: '800 €' }),
        undefined, undefined
      )

      expect(customerVm!.agreedAmount).toBe(800)
      expect(customerVm!.depositAmount).toBe(800)
      expect(customerVm!.remainingAmount).toBe(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Order value vs escrow total vs tranche amounts are distinct
  // ═══════════════════════════════════════════════════════════════════════

  describe('3. semantic distinction between amounts', () => {
    it('commercial display context provides distinct amount types', () => {
      seedFullContext()

      const ctx = resolveCommercialDisplayContext('job-1')

      // Order value = escrow total = funding amount (full-upfront model)
      expect(ctx.orderValue.amount).toBe(1000)
      expect(ctx.escrowTotal).toBe(1000)
      expect(ctx.fundingAmount).toBe(1000)

      // Tranche amounts: 25% + 75% = total
      expect(ctx.depositRelease).toBe(250)
      expect(ctx.finalRelease).toBe(750)
      expect(ctx.depositRelease! + ctx.finalRelease!).toBe(ctx.escrowTotal)

      // Amounts are aligned
      expect(ctx.amountsAligned).toBe(true)
    })

    it('tranche amounts match escrow service calculation', () => {
      seedFullContext()

      const ctx = resolveCommercialDisplayContext('job-1')
      const tranches = calculateTrancheAmounts(1000)

      expect(ctx.depositRelease).toBe(tranches.depositAmount)
      expect(ctx.finalRelease).toBe(tranches.finalAmount)
    })

    it('no escrow → tranche amounts are null, only order value available', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))

      const ctx = resolveCommercialDisplayContext('job-1')

      expect(ctx.orderValue.amount).toBe(1000)
      expect(ctx.hasEscrow).toBe(false)
      expect(ctx.escrowTotal).toBeNull()
      expect(ctx.fundingAmount).toBeNull()
      expect(ctx.depositRelease).toBeNull()
      expect(ctx.finalRelease).toBeNull()
    })

    it('formatted amounts use canonical euroFormatter', () => {
      seedFullContext()

      const ctx = resolveCommercialDisplayContext('job-1')

      expect(ctx.orderValue.formatted).toBe(formatEuro(1000))
      expect(ctx.escrowTotalFormatted).toBe(formatEuro(1000))
      expect(ctx.fundingAmountFormatted).toBe(formatEuro(1000))
      expect(ctx.depositReleaseFormatted).toBe(formatEuro(250))
      expect(ctx.finalReleaseFormatted).toBe(formatEuro(750))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. No accidental double-counting
  // ═══════════════════════════════════════════════════════════════════════

  describe('4. no double-counting', () => {
    it('order value is never the sum of tranches (it IS the tranches total)', () => {
      seedFullContext()

      const ctx = resolveCommercialDisplayContext('job-1')

      // Order value = exactly one of the amounts, not a sum of separate amounts
      expect(ctx.orderValue.amount).toBe(ctx.escrowTotal)
      expect(ctx.depositRelease! + ctx.finalRelease!).toBe(ctx.orderValue.amount)
    })

    it('customer deposit amount never exceeds order value', () => {
      seedFullContext()

      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), undefined
      )

      expect(customerVm!.depositAmount).toBeLessThanOrEqual(customerVm!.agreedAmount!)
    })

    it('payment.amounts legacy 25/75 split does not leak into canonical display', () => {
      // payment.amounts has legacy 25% deposit (250), but canonical should show full amount
      seedFullContext()

      const ctx = resolveCommercialDisplayContext('job-1')
      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), undefined
      )

      // Canonical total is 1000, not 250 (the legacy deposit amount)
      expect(ctx.orderValue.amount).toBe(1000)
      // Customer sees full 1000 as what they fund, not 250
      expect(customerVm!.depositAmount).toBe(1000)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Funded context does not show unpaid
  // ═══════════════════════════════════════════════════════════════════════

  describe('5. funded context shows paid', () => {
    it('customer deposit phase is deposit_paid when funding status is funded', () => {
      seedFullContext()

      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), 'funded'
      )

      expect(customerVm!.phase).toBe('deposit_paid')
      expect(customerVm!.customerActionRequired).toBe(false)
    })

    it('customer deposit shows consistent amount even when funded', () => {
      seedFullContext()

      const customerVm = deriveCustomerDepositAction(
        makeJob(), makePayment(), 'funded'
      )

      // Amount is still the canonical order value
      expect(customerVm!.agreedAmount).toBe(1000)
      expect(customerVm!.agreedAmountFormatted).toBe(formatEuro(1000))
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Context scoping — different jobs are independent
  // ═══════════════════════════════════════════════════════════════════════

  describe('6. context scoping', () => {
    it('two jobs with different amounts resolve independently', () => {
      const job1 = makeJob({ id: 'job-1', sourceOfferId: 'offer-1' })
      const job2 = makeJob({ id: 'job-2', sourceOfferId: 'offer-2', amount: '5.000 €' })
      const offer1 = makeOffer({ id: 'offer-1', price: '1.000 €', createdJobId: 'job-1' })
      const offer2 = makeOffer({ id: 'offer-2', price: '5.000 €', createdJobId: 'job-2' })

      setJobRepository(new InMemoryJobRepository([job1, job2]))
      setOfferRepository(new InMemoryOfferRepository([offer1, offer2]))

      const escrowRepo = new InMemoryEscrowPlanRepository()
      escrowRepo.addPlan(makeEscrowPlan({
        id: 'plan-1', jobId: 'job-1', sourceOfferId: 'offer-1', totalAmount: 1000,
      }))
      escrowRepo.addPlan(makeEscrowPlan({
        id: 'plan-2', jobId: 'job-2', sourceOfferId: 'offer-2', totalAmount: 5000,
      }))
      setEscrowPlanRepository(escrowRepo)

      const ctx1 = resolveCommercialDisplayContext('job-1')
      const ctx2 = resolveCommercialDisplayContext('job-2')

      expect(ctx1.orderValue.amount).toBe(1000)
      expect(ctx2.orderValue.amount).toBe(5000)
      expect(ctx1.depositRelease).toBe(250)
      expect(ctx2.depositRelease).toBe(1250)
    })

    it('commercial display for nonexistent job returns empty context', () => {
      const ctx = resolveCommercialDisplayContext('nonexistent')

      expect(ctx.orderValue.amount).toBeNull()
      expect(ctx.hasEscrow).toBe(false)
      expect(ctx.escrowTotal).toBeNull()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. No regression to Blocks 1–5A
  // ═══════════════════════════════════════════════════════════════════════

  describe('7. no regression to existing resolvers', () => {
    it('resolveCanonicalAmount still follows escrow → offer → job hierarchy', () => {
      seedFullContext()

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('escrow')
      expect(result.amount).toBe(1000)
    })

    it('resolveCanonicalAmount returns offer when no escrow', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '2.300 €' })]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('offer')
      expect(result.amount).toBe(2300)
    })

    it('resolveCanonicalAmount returns job fallback when no offer or escrow', () => {
      setJobRepository(new InMemoryJobRepository([
        makeJob({ sourceOfferId: undefined, amount: '1.500 €' }),
      ]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('job')
      expect(result.amount).toBe(1500)
    })
  })
})
