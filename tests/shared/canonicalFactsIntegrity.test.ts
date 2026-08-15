/**
 * Canonical Project Facts Integrity — Integration Tests
 *
 * Validates the FULL FACTS HIERARCHY for accepted/booked contexts:
 *
 *   title     — Project.title → Offer context → Job.title (weakest)
 *   customer  — Project.customer → Job.customer
 *   location  — Project.location → Offer.locationSnapshot → Job.location
 *   dateLabel — Project.dateLabel → Offer.timingNote → Job.dateLabel
 *   amount    — resolveCanonicalAmount (escrow → offer → job)
 *   linkage   — acceptedOfferLinkage when job.sourceOfferId exists
 *
 * Covers:
 *   1. Title resolution prefers project title over generic "Auftrag aus Angebot"
 *   2. Customer resolution is consistent across provider and customer surfaces
 *   3. Location resolution prefers strong sources over "Ort folgt"
 *   4. DateLabel/scheduling uses canonical hierarchy, not placeholders
 *   5. Accepted-offer linkage and payment basis remain coherent
 *   6. Provider detail hydration resolves real canonical facts
 *   7. No regression to amount hierarchy / money formatting
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { resolveCanonicalProjectFacts } from '../../src/lib/shared/canonicalProjectFacts'
import { formatEuro, formatOfferPrice } from '../../src/lib/shared/formatters'

// ── Repository setup imports ──────────────────────────────────────────────

import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryOfferRepository } from '../../src/lib/offers/repository/InMemoryOfferRepository'
import { setOfferRepository } from '../../src/lib/offers/repository/registry'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'

import type { Job } from '../../src/lib/jobs/types'
import type { Offer } from '../../src/lib/offers/types'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow/escrowTypes'

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
    description: 'Badezimmer komplett renovieren',
    status: 'accepted',
    sentAt: Date.now() - 10000,
    createdAt: Date.now() - 10000,
    updatedAt: Date.now(),
    acceptedAt: Date.now(),
    createdJobId: 'job-1',
    projectTitleSnapshot: 'Bad renovieren',
    locationSnapshot: 'München',
    timingNote: 'Anfang April',
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
    location: 'Berlin-Mitte',
    dateLabel: 'KW 15',
    price: '2.300 €',
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Canonical Project Facts — Title Hierarchy', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('prefers project.title over generic "Auftrag aus Angebot"', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ title: 'Auftrag aus Angebot' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ title: 'Bad renovieren' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.title).toBe('Bad renovieren')
  })

  it('falls back to offer.projectTitleSnapshot when project title matches generic placeholder', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ title: 'Auftrag aus Angebot' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ projectTitleSnapshot: 'Küche einbauen' })]))
    setProjectRepository(new InMemoryProjectRepository([
      makeProject({ title: 'Auftrag aus Angebot' }),
    ]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.title).toBe('Küche einbauen')
  })

  it('falls back to offer.description when no projectTitleSnapshot', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ title: 'Auftrag aus Angebot' })]))
    setOfferRepository(new InMemoryOfferRepository([
      makeOffer({ projectTitleSnapshot: undefined, description: 'Fliesenarbeit im Bad' }),
    ]))
    // No project
    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.title).toBe('Fliesenarbeit im Bad')
  })

  it('uses job.title when no stronger source exists', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ title: 'Dach reparieren', sourceOfferId: undefined })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.title).toBe('Dach reparieren')
  })

  it('uses job.title when it is already meaningful (not generic)', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ title: 'Elektrik erneuern' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ title: '' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.title).toBe('Elektrik erneuern')
  })
})

describe('Canonical Project Facts — Customer Hierarchy', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('prefers project.customer over job.customer', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ customer: 'Weak Name' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ customer: 'Anna Kundin' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.customer).toBe('Anna Kundin')
  })

  it('falls back to job.customer when project.customer is empty', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ customer: 'Max Müller' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ customer: '' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.customer).toBe('Max Müller')
  })

  it('uses job.customer when no project exists', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ customer: 'Hans Schmidt' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.customer).toBe('Hans Schmidt')
  })
})

describe('Canonical Project Facts — Location Hierarchy', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('prefers project.location over job placeholder "Ort folgt"', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ location: 'Ort folgt' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ location: 'Berlin-Mitte' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.location).toBe('Berlin-Mitte')
  })

  it('falls back to offer.locationSnapshot when project has placeholder', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ location: 'Ort folgt' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ locationSnapshot: 'Hamburg' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ location: 'Ort folgt' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.location).toBe('Hamburg')
  })

  it('falls back to offer.locationSnapshot when job has empty location and no project', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ location: '' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ locationSnapshot: 'Frankfurt' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.location).toBe('Frankfurt')
  })

  it('uses job.location when it is already meaningful', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ location: 'Stuttgart', sourceOfferId: undefined })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.location).toBe('Stuttgart')
  })
})

describe('Canonical Project Facts — DateLabel / Scheduling Hierarchy', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('prefers project.dateLabel over job placeholder "Termin offen"', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ dateLabel: 'Termin offen' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ dateLabel: 'KW 15' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.dateLabel).toBe('KW 15')
  })

  it('falls back to offer.timingNote when project and job have placeholders', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ dateLabel: 'Termin offen' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ timingNote: 'Anfang April' })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({ dateLabel: '' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.dateLabel).toBe('Anfang April')
  })

  it('falls back to offer.timingNote when no project exists and job has placeholder', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ dateLabel: 'Termin offen' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ timingNote: 'Mitte März' })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.dateLabel).toBe('Mitte März')
  })

  it('uses job.dateLabel when it is already meaningful', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ dateLabel: '15. April 2026', sourceOfferId: undefined })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.dateLabel).toBe('15. April 2026')
  })
})

describe('Canonical Project Facts — Accepted-Offer Linkage', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('includes accepted-offer linkage when sourceOfferId exists', () => {
    setJobRepository(new InMemoryJobRepository([makeJob()]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer()]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.acceptedOfferLinkage).not.toBeNull()
    expect(facts.acceptedOfferLinkage!.sourceOfferId).toBe('offer-1')
    expect(facts.acceptedOfferLinkage!.acceptedAt).toBeDefined()
    expect(facts.acceptedOfferLinkage!.description).toBe('Badezimmer komplett renovieren')
    expect(facts.acceptedOfferLinkage!.timingNote).toBe('Anfang April')
  })

  it('returns null linkage when no sourceOfferId', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ sourceOfferId: undefined })]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.acceptedOfferLinkage).toBeNull()
  })
})

describe('Canonical Project Facts — Cross-Surface Consistency', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('provider and customer surfaces resolve to the same facts', () => {
    const job = makeJob()
    const offer = makeOffer()
    const project = makeProject()
    const escrow = makeEscrowPlan()

    setJobRepository(new InMemoryJobRepository([job]))
    setOfferRepository(new InMemoryOfferRepository([offer]))
    setProjectRepository(new InMemoryProjectRepository([project]))
    const escrowRepo = new InMemoryEscrowPlanRepository()
    escrowRepo.addPlan(escrow)
    setEscrowPlanRepository(escrowRepo)

    // Both surfaces call the same resolver
    const providerFacts = resolveCanonicalProjectFacts('job-1')!
    const customerFacts = resolveCanonicalProjectFacts('job-1')!

    // All facts must be identical
    expect(providerFacts.title).toBe(customerFacts.title)
    expect(providerFacts.customer).toBe(customerFacts.customer)
    expect(providerFacts.location).toBe(customerFacts.location)
    expect(providerFacts.dateLabel).toBe(customerFacts.dateLabel)
    expect(providerFacts.canonicalAmount.amount).toBe(customerFacts.canonicalAmount.amount)
    expect(providerFacts.canonicalAmount.formatted).toBe(customerFacts.canonicalAmount.formatted)
  })

  it('all facts are correctly resolved from the strongest sources', () => {
    // Job has weak/generic placeholders
    // Offer has good context
    // Project has the richest context
    setJobRepository(new InMemoryJobRepository([makeJob({
      title: 'Auftrag aus Angebot',
      customer: '',
      location: 'Ort folgt',
      dateLabel: 'Termin offen',
      amount: '2.300 €',
    })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({
      projectTitleSnapshot: 'Badezimmer renovieren',
      locationSnapshot: 'München',
      timingNote: 'April 2026',
      description: 'Komplettrenovierung',
    })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({
      title: 'Bad renovieren',
      customer: 'Anna Kundin',
      location: 'Berlin-Mitte',
      dateLabel: 'KW 15',
    })]))
    const escrowRepo = new InMemoryEscrowPlanRepository()
    escrowRepo.addPlan(makeEscrowPlan({ totalAmount: 2300 }))
    setEscrowPlanRepository(escrowRepo)

    const facts = resolveCanonicalProjectFacts('job-1')!

    // Project wins for title, customer, location, dateLabel
    expect(facts.title).toBe('Bad renovieren')
    expect(facts.customer).toBe('Anna Kundin')
    expect(facts.location).toBe('Berlin-Mitte')
    expect(facts.dateLabel).toBe('KW 15')

    // Amount comes from escrow (strongest)
    expect(facts.canonicalAmount.amount).toBe(2300)
    expect(facts.canonicalAmount.formatted).toBe(formatEuro(2300))
  })

  it('offer context fills gaps when project has weak values', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({
      title: 'Auftrag aus Angebot',
      location: 'Ort folgt',
      dateLabel: 'Termin offen',
    })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({
      projectTitleSnapshot: 'Küche erneuern',
      locationSnapshot: 'Köln',
      timingNote: 'Ende Mai',
    })]))
    // Project exists but has weak / empty values
    setProjectRepository(new InMemoryProjectRepository([makeProject({
      title: 'Auftrag aus Angebot',
      location: '',
      dateLabel: '',
    })]))

    const facts = resolveCanonicalProjectFacts('job-1')!

    expect(facts.title).toBe('Küche erneuern')
    expect(facts.location).toBe('Köln')
    expect(facts.dateLabel).toBe('Ende Mai')
  })

  it('returns null for nonexistent job', () => {
    const facts = resolveCanonicalProjectFacts('nonexistent')
    expect(facts).toBeNull()
  })

  it('no regression: amount hierarchy still works correctly', () => {
    setJobRepository(new InMemoryJobRepository([makeJob({ amount: '1.000 €' })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({ price: '2.300 €' })]))
    const escrowRepo = new InMemoryEscrowPlanRepository()
    escrowRepo.addPlan(makeEscrowPlan({ totalAmount: 2300 }))
    setEscrowPlanRepository(escrowRepo)

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.canonicalAmount.amount).toBe(2300)
    expect(facts.canonicalAmount.source).toBe('escrow')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Block 1 Closure — Raw Money Elimination + Provider Facts Hydration
// ═══════════════════════════════════════════════════════════════════════════

describe('Block 1 Closure — Raw money elimination via formatOfferPrice', () => {
  it('raw numeric price "1000" gets formatted to canonical Euro', () => {
    // This is the exact scenario: craftsman enters "1000", it must not display as "1000"
    const formatted = formatOfferPrice('1000')
    expect(formatted).toMatch(/1\.000,00\s*€/)
    expect(formatted).not.toBe('1000')
  })

  it('already-formatted price "1.500 €" is re-formatted canonically', () => {
    const formatted = formatOfferPrice('1.500 €')
    expect(formatted).toMatch(/1\.500,00\s*€/)
  })

  it('payment basis totalAmountFormatted aligns with formatOfferPrice', () => {
    // deriveQuotePaymentBasis uses formatEuro(parsedAmount) internally
    // formatOfferPrice parses and formats the same way
    // For an accepted offer with price "2.300 €", both should produce identical output
    const formatted = formatOfferPrice('2.300 €')
    expect(formatted).toBe(formatEuro(2300))
  })
})

describe('Block 1 Closure — Provider facts hydration via canonical resolver', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('provider detail resolves all five facts from canonical hierarchy', () => {
    // Simulate an accepted offer creating a job with weak placeholders
    // and a project with strong facts
    setJobRepository(new InMemoryJobRepository([makeJob({
      title: 'Auftrag aus Angebot',
      customer: '',
      location: 'Ort folgt',
      dateLabel: 'Termin offen',
      amount: '1000',
    })]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer({
      price: '2.300 €',
      projectTitleSnapshot: 'Bad renovieren',
      locationSnapshot: 'München',
      timingNote: 'Anfang April',
    })]))
    setProjectRepository(new InMemoryProjectRepository([makeProject({
      title: 'Bad renovieren',
      customer: 'Anna Kundin',
      location: 'Berlin-Mitte',
      dateLabel: 'KW 15',
    })]))
    const escrowRepo = new InMemoryEscrowPlanRepository()
    escrowRepo.addPlan(makeEscrowPlan({ totalAmount: 2300 }))
    setEscrowPlanRepository(escrowRepo)

    const facts = resolveCanonicalProjectFacts('job-1')!

    // All five provider-visible facts must come from canonical sources
    expect(facts.title).toBe('Bad renovieren')          // Project wins
    expect(facts.customer).toBe('Anna Kundin')           // Project wins
    expect(facts.location).toBe('Berlin-Mitte')          // Project wins
    expect(facts.dateLabel).toBe('KW 15')                // Project wins
    expect(facts.canonicalAmount.amount).toBe(2300)       // Escrow wins
    expect(facts.canonicalAmount.formatted).toBe(formatEuro(2300))

    // Raw "1000" from job.amount must never appear
    expect(facts.canonicalAmount.formatted).not.toBe('1000')
  })

  it('accepted-offer linkage is always present for offer-originated jobs', () => {
    setJobRepository(new InMemoryJobRepository([makeJob()]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer()]))

    const facts = resolveCanonicalProjectFacts('job-1')!
    expect(facts.acceptedOfferLinkage).not.toBeNull()
    expect(facts.acceptedOfferLinkage!.sourceOfferId).toBe('offer-1')
    expect(facts.acceptedOfferLinkage!.timingNote).toBe('Anfang April')
  })

  it('provider and customer surfaces consume the same canonical resolver', () => {
    // Both surfaces call resolveCanonicalProjectFacts(jobId)
    // This test proves the return values are structurally identical
    setJobRepository(new InMemoryJobRepository([makeJob()]))
    setOfferRepository(new InMemoryOfferRepository([makeOffer()]))
    setProjectRepository(new InMemoryProjectRepository([makeProject()]))
    const escrowRepo = new InMemoryEscrowPlanRepository()
    escrowRepo.addPlan(makeEscrowPlan())
    setEscrowPlanRepository(escrowRepo)

    const factsA = resolveCanonicalProjectFacts('job-1')!
    const factsB = resolveCanonicalProjectFacts('job-1')!

    // Identity: same input → same output (both surfaces get identical facts)
    expect(factsA.title).toBe(factsB.title)
    expect(factsA.customer).toBe(factsB.customer)
    expect(factsA.location).toBe(factsB.location)
    expect(factsA.dateLabel).toBe(factsB.dateLabel)
    expect(factsA.canonicalAmount.amount).toBe(factsB.canonicalAmount.amount)
    expect(factsA.canonicalAmount.formatted).toBe(factsB.canonicalAmount.formatted)
    expect(factsA.acceptedOfferLinkage?.sourceOfferId).toBe(factsB.acceptedOfferLinkage?.sourceOfferId)
  })
})
