/**
 * Canonical Amount Resolver — Integration Tests
 *
 * Validates the AMOUNT HIERARCHY:
 *   1. EscrowPlan.totalAmount (strongest after escrow creation)
 *   2. Accepted Offer price (binding commercial basis after acceptance)
 *   3. Job.amount (fallback only)
 *
 * Also validates:
 *   - Cross-surface amount consistency (same context → same amount)
 *   - Funding request alignment with canonical amount
 *   - No amount drift between customer and provider surfaces
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { resolveCanonicalAmount } from '../../src/lib/shared/canonicalAmountResolver'
import { resolveCanonicalProjectFacts } from '../../src/lib/shared/canonicalProjectFacts'
import { formatEuro } from '../../src/lib/shared/formatters'

// ── Repository setup imports ──────────────────────────────────────────────

import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryOfferRepository } from '../../src/lib/offers/repository/InMemoryOfferRepository'
import { setOfferRepository } from '../../src/lib/offers/repository/registry'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'
import { InMemoryFundingRequestRepository } from '../../src/lib/payments/fundingRequest/InMemoryFundingRequestRepository'
import { setFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'

import type { Job } from '../../src/lib/jobs/types'
import type { Offer } from '../../src/lib/offers/types'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow/escrowTypes'
import type { FundingRequest } from '../../src/lib/payments/fundingRequest/types'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Bad renovieren',
    customer: 'Anna Kundin',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '2.300 €',
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
    price: '2.300 €',
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
    totalAmount: 2300,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'awaiting_customer_funding',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeFundingRequest(overrides?: Partial<FundingRequest>): FundingRequest {
  return {
    id: 'fr-1',
    sourceOfferId: 'offer-1',
    jobId: 'job-1',
    escrowPlanId: 'plan-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    providerUserId: 'craftsman-1',
    type: 'full_escrow',
    status: 'sent',
    amount: 2300,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Canonical Amount Resolver', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Amount Hierarchy ──────────────────────────────────────────────

  describe('1. amount hierarchy — escrow > offer > job', () => {
    it('returns escrow plan amount when all three sources exist', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
      const escrowRepo = new InMemoryEscrowPlanRepository()
      escrowRepo.addPlan(makeEscrowPlan({ totalAmount: 2300 }))
      setEscrowPlanRepository(escrowRepo)

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('escrow')
      expect(result.amount).toBe(2300)
      expect(result.formatted).toMatch(/2\.300,00\s*€/)
    })

    it('returns offer amount when no escrow plan exists', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '2.300 €' })]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('offer')
      expect(result.amount).toBe(2300)
      expect(result.formatted).toMatch(/2\.300,00\s*€/)
    })

    it('returns job amount as fallback when no offer or escrow', () => {
      setJobRepository(new InMemoryJobRepository([
        makeJob({ sourceOfferId: undefined, amount: '1.500 €' })
      ]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('job')
      expect(result.amount).toBe(1500)
      expect(result.formatted).toMatch(/1\.500,00\s*€/)
    })

    it('returns none when job does not exist', () => {
      const result = resolveCanonicalAmount('nonexistent')
      expect(result.source).toBe('none')
      expect(result.amount).toBeNull()
      expect(result.formatted).toBe('')
    })

    it('returns none when job has no parseable amount and no linked offer/escrow', () => {
      setJobRepository(new InMemoryJobRepository([
        makeJob({ sourceOfferId: undefined, amount: '' })
      ]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.source).toBe('none')
      expect(result.amount).toBeNull()
    })
  })

  // ── 2. Cross-surface amount consistency ──────────────────────────────

  describe('2. cross-surface amount consistency', () => {
    it('accepted offer, escrow plan, and funding request all resolve to same amount', () => {
      const job = makeJob()
      const offer = makeOffer({ price: '2.300 €' })
      const escrow = makeEscrowPlan({ totalAmount: 2300 })
      const funding = makeFundingRequest({ amount: 2300 })

      setJobRepository(new InMemoryJobRepository([job]))
      setOfferRepository(new InMemoryOfferRepository([offer]))
      const escrowRepo = new InMemoryEscrowPlanRepository()
      escrowRepo.addPlan(escrow)
      setEscrowPlanRepository(escrowRepo)
      const fundingRepo = new InMemoryFundingRequestRepository()
      fundingRepo.add(funding)
      setFundingRequestRepository(fundingRepo)

      const canonical = resolveCanonicalAmount('job-1')

      // All entities carry the same amount
      expect(canonical.amount).toBe(2300)
      expect(canonical.amount).toBe(escrow.totalAmount)
      expect(canonical.amount).toBe(funding.amount)

      // Formatted output is consistent
      expect(canonical.formatted).toBe(formatEuro(2300))
      expect(canonical.formatted).toBe(formatEuro(escrow.totalAmount))
      expect(canonical.formatted).toBe(formatEuro(funding.amount))
    })

    it('customer-facing and provider-facing views derive same order value', () => {
      const job = makeJob()
      const offer = makeOffer({ price: '5.000 €' })
      const escrow = makeEscrowPlan({ totalAmount: 5000 })

      setJobRepository(new InMemoryJobRepository([job]))
      setOfferRepository(new InMemoryOfferRepository([offer]))
      const escrowRepo = new InMemoryEscrowPlanRepository()
      escrowRepo.addPlan(escrow)
      setEscrowPlanRepository(escrowRepo)

      // Simulating customer view and provider view both calling same resolver
      const customerView = resolveCanonicalAmount('job-1')
      const providerView = resolveCanonicalAmount('job-1')

      expect(customerView.amount).toBe(providerView.amount)
      expect(customerView.formatted).toBe(providerView.formatted)
      expect(customerView.source).toBe(providerView.source)
    })
  })

  // ── 3. Formatting consistency ────────────────────────────────────────

  describe('3. money formatting is consistent and correct in German/Euro', () => {
    it('1000 euros never shows as raw "1000"', () => {
      setJobRepository(new InMemoryJobRepository([makeJob({ amount: '1.000 €' })]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '1.000 €' })]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.formatted).not.toBe('1000')
      expect(result.formatted).toMatch(/1\.000,00\s*€/)
    })

    it('amounts always include decimal places', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '500 €' })]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.formatted).toContain(',00')
    })

    it('amounts always include € symbol', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))

      const result = resolveCanonicalAmount('job-1')
      expect(result.formatted).toContain('€')
    })
  })
})

// ── Canonical Project Facts ─────────────────────────────────────────────

describe('Canonical Project Facts Resolver', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('resolves customer from project when available', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ customer: 'Weak Customer' })]))
    setProjectRepository(new InMemoryProjectRepository([{
      id: 'project-1',
      sourceJobId: 'job-1',
      title: 'Test',
      customer: 'Anna Kundin',
      craftsman: 'Peter',
      location: 'Berlin',
      dateLabel: '',
      price: '2.300 €',
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))

    const facts = resolveCanonicalProjectFacts('job-1')
    expect(facts).not.toBeNull()
    expect(facts!.customer).toBe('Anna Kundin')
  })

  it('resolves location from project when available', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ location: 'Ort folgt' })]))
    setProjectRepository(new InMemoryProjectRepository([{
      id: 'project-1',
      sourceJobId: 'job-1',
      title: 'Test',
      customer: 'Anna',
      craftsman: 'Peter',
      location: 'München',
      dateLabel: '',
      price: '2.300 €',
      status: 'accepted',
      paymentState: 'deposit_required',
      messageCount: 0,
      noteCount: 0,
      photoCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]))

    const facts = resolveCanonicalProjectFacts('job-1')
    expect(facts!.location).toBe('München')
  })

  it('falls back to job fields when project does not exist', () => {
    setJobRepository(new InMemoryJobRepository([
      makeJob({ customer: 'Job Customer', location: 'Frankfurt' })
    ]))

    const facts = resolveCanonicalProjectFacts('job-1')
    expect(facts!.customer).toBe('Job Customer')
    expect(facts!.location).toBe('Frankfurt')
  })

  it('returns null for nonexistent job', () => {
    const facts = resolveCanonicalProjectFacts('nonexistent')
    expect(facts).toBeNull()
  })

  it('includes canonical amount from resolver', () => {
    setJobRepository(new InMemoryJobRepository([makeJob()]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '3.500 €' })]))

    const facts = resolveCanonicalProjectFacts('job-1')
    expect(facts!.canonicalAmount.amount).toBe(3500)
    expect(facts!.canonicalAmount.formatted).toMatch(/3\.500,00\s*€/)
  })
})
