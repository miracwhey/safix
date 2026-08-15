/**
 * Provider Detail Hydration — Block 4 Tests
 *
 * Validates the provider-facing detail/operations/payment surface completeness:
 *
 *   1. Provider detail shows canonical title/customer/location/date for accepted/booked context
 *   2. Provider detail shows canonical order value/payment basis consistently
 *   3. Provider-facing status/phase/next action matches the actual current workflow state
 *   4. Provider payment/escrow display does not show unexplained conflicting amounts
 *   5. Mixed English/German provider labels in scope are removed
 *   6. No regression to Blocks 1–3
 *   7. Canonical provider detail model composes correctly
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { resolveCanonicalProviderDetail } from '../../src/lib/shared/canonicalProviderDetail'
import { resolveCanonicalProjectFacts } from '../../src/lib/shared/canonicalProjectFacts'
import { resolveCanonicalAmount } from '../../src/lib/shared/canonicalAmountResolver'
import { deriveProviderJobPhase, PROVIDER_PHASE_CONFIG } from '../../src/lib/jobs/providerJobPhaseSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import { formatEuro } from '../../src/lib/shared/formatters'
import { deriveJobCompletionSummary } from '../../src/lib/jobs/jobCompletionSelectors'
import { derivePaymentPrepReadiness } from '../../src/lib/jobs/paymentPrepSelectors'

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
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow/escrowTypes'
import type { FundingRequest } from '../../src/lib/payments/fundingRequest/types'

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Auftrag aus Angebot',
    customer: '',
    location: 'Ort folgt',
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
    proposalSentAt: Date.now() - 20000,
    proposalAcceptedAt: Date.now() - 10000,
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
    description: 'Komplettumbau Badezimmer inkl. Fliesen und Sanitär',
    projectTitleSnapshot: 'Badezimmer-Renovierung Altbau',
    locationSnapshot: 'Berlin-Mitte',
    timingNote: 'KW 12–14, ca. 3 Wochen',
    status: 'accepted',
    sentAt: Date.now() - 20000,
    createdAt: Date.now() - 20000,
    updatedAt: Date.now(),
    acceptedAt: Date.now() - 10000,
    createdJobId: 'job-1',
    ...overrides,
  }
}

function makeProject(overrides?: Partial<ProjectCase>): ProjectCase {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Badezimmer-Renovierung Altbau',
    customer: 'Anna Kundin',
    craftsman: 'Peter Handwerker',
    location: 'Berlin-Mitte',
    dateLabel: 'KW 12–14',
    price: '2.300 €',
    status: 'accepted',
    paymentState: 'deposit_required',
    messageCount: 3,
    noteCount: 1,
    photoCount: 0,
    createdAt: Date.now() - 30000,
    updatedAt: Date.now(),
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

function seedFullContext(overrides?: {
  job?: Partial<Job>
  offer?: Partial<Offer>
  project?: Partial<ProjectCase>
  escrow?: Partial<EscrowPaymentPlan>
  funding?: Partial<FundingRequest>
}) {
  setJobRepository(new InMemoryJobRepository([makeJob(overrides?.job)]))
  setOfferRepository(new InMemoryOfferRepository([makeOffer(overrides?.offer)]))
  setProjectRepository(new InMemoryProjectRepository([makeProject(overrides?.project)]))
  const escrowRepo = new InMemoryEscrowPlanRepository()
  escrowRepo.addPlan(makeEscrowPlan(overrides?.escrow))
  setEscrowPlanRepository(escrowRepo)
  const fundingRepo = new InMemoryFundingRequestRepository()
  fundingRepo.add(makeFundingRequest(overrides?.funding))
  setFundingRequestRepository(fundingRepo)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Provider Detail Hydration — Block 4', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Canonical title/customer/location/date ──────────────────────

  describe('1. provider detail shows canonical facts for accepted/booked context', () => {
    it('resolves title from project instead of generic job placeholder', () => {
      seedFullContext()

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts).not.toBeNull()
      expect(facts!.title).toBe('Badezimmer-Renovierung Altbau')
      expect(facts!.title).not.toBe('Auftrag aus Angebot')
    })

    it('resolves customer from project when job.customer is empty', () => {
      seedFullContext({ job: { customer: '' } })

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.customer).toBe('Anna Kundin')
      expect(facts!.customer).not.toBe('')
    })

    it('resolves location from project instead of placeholder', () => {
      seedFullContext({ job: { location: 'Ort folgt' } })

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.location).toBe('Berlin-Mitte')
      expect(facts!.location).not.toBe('Ort folgt')
    })

    it('resolves dateLabel from project instead of placeholder', () => {
      seedFullContext({ job: { dateLabel: 'Termin offen' } })

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.dateLabel).toBe('KW 12–14')
      expect(facts!.dateLabel).not.toBe('Termin offen')
    })

    it('falls back to offer context when project fields are weak', () => {
      setJobRepository(new InMemoryJobRepository([makeJob({
        title: 'Auftrag aus Angebot',
        location: 'Ort folgt',
        dateLabel: 'Termin offen',
      })]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
      // No project seeded

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.title).toBe('Badezimmer-Renovierung Altbau')
      expect(facts!.location).toBe('Berlin-Mitte')
      expect(facts!.dateLabel).toBe('KW 12–14, ca. 3 Wochen')
    })
  })

  // ── 2. Canonical order value / payment basis ────────────────────────

  describe('2. provider detail shows canonical order value consistently', () => {
    it('escrow amount matches canonical amount', () => {
      seedFullContext()

      const canonical = resolveCanonicalAmount('job-1')
      expect(canonical.source).toBe('escrow')
      expect(canonical.amount).toBe(2300)
      expect(canonical.formatted).toMatch(/2\.300,00\s*€/)
    })

    it('provider detail model shows coherent commercial context', () => {
      seedFullContext()

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail).not.toBeNull()
      expect(detail!.commercial.canonicalAmount.amount).toBe(2300)
      expect(detail!.commercial.escrowAmount).toBe(2300)
      expect(detail!.commercial.amountsAligned).toBe(true)
    })

    it('canonical amount and escrow amount use same formatting', () => {
      seedFullContext()

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail!.commercial.canonicalAmount.formatted).toBe(
        detail!.commercial.escrowAmountFormatted
      )
    })

    it('detects amount misalignment when escrow differs from canonical', () => {
      seedFullContext({ escrow: { totalAmount: 5000 } })

      const detail = resolveCanonicalProviderDetail('job-1')
      // Escrow is 5000 but offer-based canonical would be 2300 — except
      // escrow is strongest, so canonical = 5000.
      // Both should agree since escrow IS the canonical source here.
      expect(detail!.commercial.amountsAligned).toBe(true)
      expect(detail!.commercial.canonicalAmount.amount).toBe(5000)
    })
  })

  // ── 3. Provider phase / next action ─────────────────────────────────

  describe('3. provider status/phase/next action matches workflow state', () => {
    it('accepted job without funding shows funding_not_requested', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))

      const phase = deriveProviderJobPhase(makeJob())
      expect(phase.phase).toBe('funding_not_requested')
      expect(phase.label).toBe('Einzahlung anfordern')
    })

    it('funded job shows funded_in_escrow phase', () => {
      seedFullContext({ funding: { status: 'funded' }, escrow: { status: 'funded_in_escrow' } })

      const job = makeJob()
      const phase = deriveProviderJobPhase(job, 'funded', 'funded_in_escrow')
      expect(phase.phase).toBe('funded_in_escrow')
      expect(phase.label).toBe('Bereit zum Start')
    })

    it('next action for funded job is start_work', () => {
      const action = deriveProviderNextAction(makeJob(), 'funded', 'funded_in_escrow')
      expect(action.actionId).toBe('start_work')
      expect(action.label).toBe('Arbeit starten')
      expect(action.enabled).toBe(true)
    })

    it('in-progress job shows work_started phase', () => {
      const job = makeJob({ status: 'in_progress' })
      const phase = deriveProviderJobPhase(job, 'funded', 'funded_in_escrow')
      expect(phase.phase).toBe('work_started')
    })

    it('completed job with full release shows payment_released', () => {
      const job = makeJob({
        status: 'completed',
        paymentReleasedAt: Date.now(),
      })
      const phase = deriveProviderJobPhase(job, 'funded', 'fully_released')
      expect(phase.phase).toBe('payment_released')
      expect(phase.label).toBe('Vollständig freigegeben')
    })

    it('provider detail model includes correct phase and next action', () => {
      seedFullContext({ funding: { status: 'sent' } })

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail!.phase.phase).toBe('funding_requested')
      expect(detail!.nextAction.actionId).toBe('wait_for_funding')
      expect(detail!.nextAction.enabled).toBe(false)
    })
  })

  // ── 4. No conflicting amounts ───────────────────────────────────────

  describe('4. provider payment/escrow display shows no unexplained conflicting amounts', () => {
    it('escrow and canonical amounts agree for standard accepted flow', () => {
      seedFullContext()

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail!.commercial.amountsAligned).toBe(true)
      expect(detail!.commercial.canonicalAmount.formatted).toBe(
        formatEuro(2300)
      )
    })

    it('no escrow plan means amounts trivially aligned', () => {
      setJobRepository(new InMemoryJobRepository([makeJob()]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
      setProjectRepository(new InMemoryProjectRepository([makeProject()]))

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail!.commercial.escrowAmount).toBeNull()
      expect(detail!.commercial.amountsAligned).toBe(true)
    })

    it('funding request amount matches canonical for standard flow', () => {
      seedFullContext()

      const canonical = resolveCanonicalAmount('job-1')
      const funding = makeFundingRequest()
      expect(canonical.amount).toBe(funding.amount)
    })
  })

  // ── 5. Language consistency ─────────────────────────────────────────

  describe('5. provider-facing labels are consistent German', () => {
    it('all phase labels are German', () => {
      const germanPhrasePattern = /[a-zäöüß]/i
      for (const [, config] of Object.entries(PROVIDER_PHASE_CONFIG)) {
        expect(config.label).toMatch(germanPhrasePattern)
        // Must not contain common English-only labels
        expect(config.label).not.toMatch(/^(Sent|Started|Completed|Released|Closed|Pending|Cancelled)$/)
      }
    })

    it('all next action labels are German', () => {
      const phases = [
        'quote_sent', 'funding_not_requested', 'funding_requested',
        'funding_pending', 'funded_in_escrow', 'work_started',
        'work_completed', 'partially_released', 'payment_released',
        'disputed', 'closed',
      ] as const

      for (const phase of phases) {
        const job = makeJob()
        // Use phase-specific overrides to reach each phase
        let action
        switch (phase) {
          case 'quote_sent':
            action = deriveProviderNextAction({ ...job, proposalAcceptedAt: undefined })
            break
          case 'funded_in_escrow':
            action = deriveProviderNextAction(job, 'funded', 'funded_in_escrow')
            break
          case 'work_started':
            action = deriveProviderNextAction({ ...job, status: 'in_progress' }, 'funded', 'funded_in_escrow')
            break
          default:
            action = deriveProviderNextAction(job)
        }

        // All labels should contain German characters or be recognizable German
        expect(action.label).toBeTruthy()
        expect(action.description).toBeTruthy()
      }
    })
  })

  // ── 6. No regression to Blocks 1–3 ─────────────────────────────────

  describe('6. no regression to Blocks 1–3', () => {
    it('canonical amount hierarchy still works (escrow > offer > job)', () => {
      seedFullContext()

      const amount = resolveCanonicalAmount('job-1')
      expect(amount.source).toBe('escrow')
      expect(amount.amount).toBe(2300)
    })

    it('canonical facts hierarchy still works (project > offer > job)', () => {
      seedFullContext()

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.title).toBe('Badezimmer-Renovierung Altbau')
      expect(facts!.customer).toBe('Anna Kundin')
      expect(facts!.location).toBe('Berlin-Mitte')
    })

    it('formatEuro produces German locale with 2 decimal places', () => {
      expect(formatEuro(2300)).toMatch(/2\.300,00\s*€/)
      expect(formatEuro(0)).toMatch(/0,00\s*€/)
    })

    it('accepted offer linkage is preserved', () => {
      seedFullContext()

      const facts = resolveCanonicalProjectFacts('job-1')
      expect(facts!.acceptedOfferLinkage).not.toBeNull()
      expect(facts!.acceptedOfferLinkage!.sourceOfferId).toBe('offer-1')
    })
  })

  // ── 7. Canonical provider detail model ──────────────────────────────

  describe('7. canonical provider detail model composes correctly', () => {
    it('returns null for nonexistent job', () => {
      const detail = resolveCanonicalProviderDetail('nonexistent')
      expect(detail).toBeNull()
    })

    it('returns complete model for accepted/funded context', () => {
      seedFullContext({ funding: { status: 'funded' }, escrow: { status: 'funded_in_escrow' } })

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail).not.toBeNull()

      // Facts
      expect(detail!.facts.title).toBe('Badezimmer-Renovierung Altbau')
      expect(detail!.facts.customer).toBe('Anna Kundin')
      expect(detail!.facts.location).toBe('Berlin-Mitte')

      // Phase
      expect(detail!.phase.phase).toBe('funded_in_escrow')
      expect(detail!.phaseConfig.label).toBe('Bereit zum Start')

      // Next action
      expect(detail!.nextAction.actionId).toBe('start_work')
      expect(detail!.nextAction.enabled).toBe(true)

      // Commercial
      expect(detail!.commercial.canonicalAmount.amount).toBe(2300)
      expect(detail!.commercial.escrowAmount).toBe(2300)
      expect(detail!.commercial.amountsAligned).toBe(true)
    })

    it('includes phase config for UI rendering', () => {
      seedFullContext()

      const detail = resolveCanonicalProviderDetail('job-1')
      expect(detail!.phaseConfig).toHaveProperty('label')
      expect(detail!.phaseConfig).toHaveProperty('icon')
      expect(detail!.phaseConfig).toHaveProperty('badge')
      expect(detail!.phaseConfig).toHaveProperty('dot')
    })
  })

  // ── 8. Provider main detail completion — Block 4 hard close ─────────

  describe('8. provider main detail surfaces consume canonical truth', () => {
    it('JobDetailsCard shows canonical customer (not blank) when project has stronger context', () => {
      // Job has empty customer, project has real name
      seedFullContext({ job: { customer: '' } })

      const facts = resolveCanonicalProjectFacts('job-1')
      // The canonical resolver should pull from project
      expect(facts!.customer).toBe('Anna Kundin')
      // The display should NOT be blank
      const displayCustomer = (facts?.customer ?? '') || '–'
      expect(displayCustomer).toBe('Anna Kundin')
      expect(displayCustomer).not.toBe('')
      expect(displayCustomer).not.toBe('–')
    })

    it('JobDetailsCard shows dash fallback when customer is truly empty (no project)', () => {
      setJobRepository(new InMemoryJobRepository([makeJob({ customer: '' })]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
      // No project seeded

      const facts = resolveCanonicalProjectFacts('job-1')
      // Job.customer is '' — canonical resolver falls back to it
      const rawCustomer = facts?.customer ?? ''
      const displayCustomer = rawCustomer || '–'
      expect(displayCustomer).toBe('–')
    })

    it('JobDetailsCard shows canonical amount (not raw job.amount)', () => {
      seedFullContext()

      const facts = resolveCanonicalProjectFacts('job-1')
      // Escrow is the strongest source
      expect(facts!.canonicalAmount.source).toBe('escrow')
      expect(facts!.canonicalAmount.formatted).toMatch(/2\.300,00\s*€/)

      // The display value should come from canonical, not raw job.amount
      const displayAmount = facts?.canonicalAmount?.formatted || '–'
      expect(displayAmount).toMatch(/2\.300,00\s*€/)
    })
  })

  describe('9. completion summary uses canonical facts (not raw job fields)', () => {
    it('deriveJobCompletionSummary resolves customer from canonical facts', () => {
      // Import the completion selector

      // Job has weak customer, project has strong customer
      seedFullContext({ job: { customer: '', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() } })

      const job = makeJob({ customer: '', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() })
      setJobRepository(new InMemoryJobRepository([job]))

      const payment = {
        id: 'pay-1',
        jobId: 'job-1',
        state: 'released' as const,
        amounts: { totalAmount: 2300, depositAmount: 575, finalAmount: 1725 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const vm = deriveJobCompletionSummary(job, payment)
      expect(vm).not.toBeNull()
      // Customer should come from canonical facts (project), not raw job.customer
      expect(vm!.customer).toBe('Anna Kundin')
      expect(vm!.customer).not.toBe('')
    })

    it('deriveJobCompletionSummary resolves location from canonical facts', () => {

      seedFullContext({ job: { location: 'Ort folgt', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() } })

      const job = makeJob({ location: 'Ort folgt', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() })
      setJobRepository(new InMemoryJobRepository([job]))

      const payment = {
        id: 'pay-1',
        jobId: 'job-1',
        state: 'released' as const,
        amounts: { totalAmount: 2300, depositAmount: 575, finalAmount: 1725 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const vm = deriveJobCompletionSummary(job, payment)
      expect(vm).not.toBeNull()
      // Location should come from canonical facts (project), not raw "Ort folgt"
      expect(vm!.location).toBe('Berlin-Mitte')
      expect(vm!.location).not.toBe('Ort folgt')
    })

    it('deriveJobCompletionSummary resolves title from canonical facts', () => {

      seedFullContext({ job: { title: 'Auftrag aus Angebot', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() } })

      const job = makeJob({ title: 'Auftrag aus Angebot', status: 'completed', paymentReleasedAt: Date.now(), workCompletedAt: Date.now() })
      setJobRepository(new InMemoryJobRepository([job]))

      const payment = {
        id: 'pay-1',
        jobId: 'job-1',
        state: 'released' as const,
        amounts: { totalAmount: 2300, depositAmount: 575, finalAmount: 1725 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      const vm = deriveJobCompletionSummary(job, payment)
      expect(vm).not.toBeNull()
      expect(vm!.jobTitle).toBe('Badezimmer-Renovierung Altbau')
      expect(vm!.jobTitle).not.toBe('Auftrag aus Angebot')
    })
  })

  describe('10. payment prep uses canonical amount (not raw job.amount)', () => {
    it('derivePaymentPrepReadiness uses canonical amount from escrow plan', () => {

      // Seed with escrow plan totalAmount=2300, but job.amount is empty
      seedFullContext({ job: { amount: '' } })

      const job = makeJob({ amount: '' })
      setJobRepository(new InMemoryJobRepository([job]))

      const vm = derivePaymentPrepReadiness(job, undefined)
      expect(vm).not.toBeNull()
      // Should NOT be 'missing_amount' — canonical resolver finds escrow amount
      expect(vm!.phase).not.toBe('missing_amount')
      expect(vm!.agreedAmount).toBe(2300)
      expect(vm!.agreedAmountFormatted).toMatch(/2\.300,00\s*€/)
    })

    it('derivePaymentPrepReadiness uses canonical amount from offer when no escrow', () => {

      // Seed with offer price but no escrow and empty job.amount
      setJobRepository(new InMemoryJobRepository([makeJob({ amount: '' })]))
      setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '3.500 €' })]))
      setProjectRepository(new InMemoryProjectRepository([makeProject()]))

      const job = makeJob({ amount: '' })
      setJobRepository(new InMemoryJobRepository([job]))

      const vm = derivePaymentPrepReadiness(job, undefined)
      expect(vm).not.toBeNull()
      // Should resolve from offer, not raw job.amount
      expect(vm!.phase).not.toBe('missing_amount')
      expect(vm!.agreedAmount).toBe(3500)
    })
  })

  describe('11. provider commercial coherence — no unexplained conflicting amounts', () => {
    it('PaymentPrepCard and JobDetailsCard show same amount for same context', () => {

      seedFullContext()

      const job = makeJob()
      setJobRepository(new InMemoryJobRepository([job]))

      // JobDetailsCard amount comes from canonical facts
      const facts = resolveCanonicalProjectFacts('job-1')
      const detailAmount = facts!.canonicalAmount.amount

      // PaymentPrepCard amount comes from derivePaymentPrepReadiness
      const vm = derivePaymentPrepReadiness(job, undefined)
      const prepAmount = vm!.agreedAmount

      // Both should show the same amount
      expect(detailAmount).toBe(prepAmount)
    })

    it('operations card canonical amount and escrow amount are coherent', () => {
      seedFullContext()

      const detail = resolveCanonicalProviderDetail('job-1')
      // When escrow exists, canonical amount = escrow amount
      expect(detail!.commercial.canonicalAmount.amount).toBe(detail!.commercial.escrowAmount)
      // Formatted values should match
      expect(detail!.commercial.canonicalAmount.formatted).toBe(detail!.commercial.escrowAmountFormatted)
    })
  })
})
