/**
 * Customer Answer-Card View-Model — Block 1
 *
 * Behavioral tests for the pure builder + mappers, seeded from REAL repository
 * fixtures (addJob + addProject + funding requests) so the canonical projection
 * is computed by production code, not hand-authored view-models.
 *
 * Plus structural guards on useCustomerAnswerCard that lock the three critical
 * fixes (dispute wiring, payment/funding/escrow subscriptions + paymentsTick).
 * The full subscription/hydration behavioral repro lives in the Block 6
 * jsdom suite.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { addJob } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import { deriveCanonicalProjection } from '../../src/lib/shared/canonicalCustomerLifecycle'
import { getFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import {
  buildCustomerAnswerCardModel,
  answerCardToneFromPriority,
  answerCardIconKey,
  answerCardCtaLabel,
} from '../../src/lib/viewmodel/customerAnswerCard'

import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'
import type { FundingRequest, FundingRequestStatus } from '../../src/lib/payments/fundingRequest/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Max Mustermann',
    location: 'Hannover',
    dateLabel: 'Morgen',
    status: 'new',
    amount: '5.000 €',
    description: 'Badezimmer renovieren',
    paymentState: 'none',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Badezimmer Renovierung',
    customer: 'Max Mustermann',
    craftsman: 'Müller Bau GmbH',
    location: 'Hannover',
    dateLabel: 'Morgen',
    price: '5.000 €',
    status: 'request',
    paymentState: 'none',
    category: 'Bad',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function seedFundingRequest(jobId: string, status: FundingRequestStatus, id = 'fr-1') {
  const fr: FundingRequest = {
    id,
    sourceOfferId: 'offer-1',
    jobId,
    escrowPlanId: 'ep-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    providerUserId: 'craftsman-1',
    type: 'full_escrow',
    status,
    amount: 5000,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === 'funded' ? { fundedAt: NOW } : {}),
  }
  getFundingRequestRepository().add(fr)
}

/** Seeds an accepted job + its project and returns the resolved canonical input. */
function seedAccepted(
  jobOverrides: Partial<Job> = {},
  projectOverrides: Partial<Project> = {},
) {
  const job = makeJob({
    status: 'new',
    proposalSentAt: NOW - 48 * HOUR,
    proposalAcceptedAt: NOW - 24 * HOUR,
    ...jobOverrides,
  })
  addJob(job)
  const project = makeProject(projectOverrides)
  addProject(project)
  return { job, project, canonical: deriveCanonicalProjection(project) }
}

beforeEach(() => {
  setupCleanRepositories()
})

// ── Pure mappers ────────────────────────────────────────────────────────────

describe('answerCardToneFromPriority — total over priority', () => {
  it('urgent → loud', () => expect(answerCardToneFromPriority('urgent')).toBe('loud'))
  it('active → calm', () => expect(answerCardToneFromPriority('active')).toBe('calm'))
  it('idle → done', () => expect(answerCardToneFromPriority('idle')).toBe('done'))
})

describe('answerCardIconKey — domain + priority → semantic key', () => {
  it('dispute (any priority) → dispute', () => {
    expect(answerCardIconKey('dispute', 'urgent')).toBe('dispute')
    expect(answerCardIconKey('dispute', 'active')).toBe('dispute')
  })
  it('payment urgent → pay, active → secured', () => {
    expect(answerCardIconKey('payment', 'urgent')).toBe('pay')
    expect(answerCardIconKey('payment', 'active')).toBe('secured')
  })
  it('job urgent → offer, active → pending', () => {
    expect(answerCardIconKey('job', 'urgent')).toBe('offer')
    expect(answerCardIconKey('job', 'active')).toBe('pending')
  })
  it('idle (any domain) → done', () => {
    expect(answerCardIconKey('job', 'idle')).toBe('done')
    expect(answerCardIconKey('payment', 'idle')).toBe('done')
  })
})

describe('answerCardCtaLabel', () => {
  const noCtx = { disputeStatus: undefined, paymentState: 'none' as const }
  it('calm / done → Zum Projekt', () => {
    expect(answerCardCtaLabel('calm', 'job', noCtx)).toBe('Zum Projekt')
    expect(answerCardCtaLabel('done', 'payment', noCtx)).toBe('Zum Projekt')
  })
  it('loud dispute → ansehen, customer_waiting → Belege einreichen', () => {
    expect(answerCardCtaLabel('loud', 'dispute', { disputeStatus: 'open', paymentState: 'none' })).toBe('Streitfall ansehen')
    expect(answerCardCtaLabel('loud', 'dispute', { disputeStatus: 'customer_waiting', paymentState: 'none' })).toBe('Belege einreichen')
  })
  it('loud payment → release_pending confirm, else Auftrag bezahlen', () => {
    expect(answerCardCtaLabel('loud', 'payment', { disputeStatus: undefined, paymentState: 'release_pending' })).toBe('Bestätigen & freigeben')
    expect(answerCardCtaLabel('loud', 'payment', { disputeStatus: undefined, paymentState: 'deposit_required' })).toBe('Auftrag bezahlen')
  })
  it('loud job → Angebot ansehen', () => {
    expect(answerCardCtaLabel('loud', 'job', noCtx)).toBe('Angebot ansehen')
  })
})

// ── Builder — behavioral, real fixtures ───────────────────────────────────────

describe('buildCustomerAnswerCardModel — NUDGE (no linked job)', () => {
  it('project without sourceJobId is NUDGE, never "Anfrage in Prüfung"', () => {
    const project = makeProject({ sourceJobId: '', status: 'request', paymentState: 'none' })
    addProject(project)
    const model = buildCustomerAnswerCardModel({
      project,
      canonical: deriveCanonicalProjection(project),
      sourceJob: undefined,
      disputeStatus: undefined,
      fundingStatus: undefined,
      fundingRequestId: undefined,
    })
    expect(model.tone).toBe('nudge')
    expect(model.iconKey).toBe('nudge')
    expect(model.label).toBe('Finde Handwerker für dein Projekt')
    expect(model.ctaLabel).toBe('Handwerker finden')
    expect(model.escrowConfirmed).toBe(false)
    // Money-safe: project-mode search (9 %), never provider-mode (5 % funnel).
    expect(model.route.to).toBe('/search')
    expect(model.route.state).toEqual({ mode: 'project', projectId: 'project-1' })
  })
})

describe('buildCustomerAnswerCardModel — dispute (regression: loud tone fires)', () => {
  it('open dispute → loud, dispute icon, "Streitfall ansehen", project route', () => {
    const { project, job, canonical } = seedAccepted({ paymentState: 'in_escrow' })
    const model = buildCustomerAnswerCardModel({
      project,
      canonical,
      sourceJob: job,
      disputeStatus: 'open',
      fundingStatus: 'funded',
      fundingRequestId: 'fr-1',
    })
    expect(model.tone).toBe('loud')
    expect(model.iconKey).toBe('dispute')
    expect(model.label).toBe('Streitfall offen') // from deriveCustomerNextAction, not hard-coded
    expect(model.ctaLabel).toBe('Streitfall ansehen')
    expect(model.route.to).toBe('/projects/project-1')
  })

  it('customer_waiting dispute → loud, "Belege einreichen"', () => {
    const { project, job, canonical } = seedAccepted({ paymentState: 'in_escrow' })
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: 'customer_waiting', fundingStatus: 'funded', fundingRequestId: 'fr-1',
    })
    expect(model.tone).toBe('loud')
    expect(model.ctaLabel).toBe('Belege einreichen')
  })
})

describe('buildCustomerAnswerCardModel — funding routes', () => {
  it('payable deposit_required → loud, deep-links to /funding/:id', () => {
    seedFundingRequest('job-1', 'sent', 'fr-pay')
    const { project, job, canonical } = seedAccepted({ paymentState: 'deposit_required' })
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: undefined, fundingStatus: 'sent', fundingRequestId: 'fr-pay',
    })
    expect(model.tone).toBe('loud')
    expect(model.iconKey).toBe('pay')
    expect(model.ctaLabel).toBe('Auftrag bezahlen')
    expect(model.route.to).toBe('/funding/fr-pay')
  })

  it('terminal-dead funding (expired) → never deep-links, goes to project', () => {
    seedFundingRequest('job-1', 'expired', 'fr-dead')
    const { project, job, canonical } = seedAccepted({ paymentState: 'deposit_required' })
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: undefined, fundingStatus: 'expired', fundingRequestId: 'fr-dead',
    })
    expect(model.tone).toBe('calm') // active, not urgent — no pay-now CTA
    expect(model.route.to).toBe('/projects/project-1')
  })

  it('funded → escrow confirmed, calm tone, project route', () => {
    seedFundingRequest('job-1', 'funded', 'fr-funded')
    const { project, job, canonical } = seedAccepted({ paymentState: 'deposit_required' })
    expect(canonical.fundingConfirmed).toBe(true)
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: undefined, fundingStatus: 'funded', fundingRequestId: 'fr-funded',
    })
    expect(model.escrowConfirmed).toBe(true)
    expect(model.tone).toBe('calm')
    expect(model.route.to).toBe('/projects/project-1')
  })

  it('terminal/DONE card never claims escrow even when funding is confirmed', () => {
    // released job: funding stays "funded" (fully_released → fundingConfirmed),
    // but the money has left escrow — the badge would contradict the headline.
    seedFundingRequest('job-1', 'funded', 'fr-rel')
    const { project, job, canonical } = seedAccepted({
      status: 'completed',
      paymentState: 'released',
    })
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: undefined, fundingStatus: 'funded', fundingRequestId: 'fr-rel',
    })
    expect(model.tone).toBe('done')
    expect(model.escrowConfirmed).toBe(false)
  })
})

describe('buildCustomerAnswerCardModel — release_pending', () => {
  it('release_pending → loud confirm CTA from the selector', () => {
    const { project, job, canonical } = seedAccepted({
      status: 'waiting_payment',
      paymentState: 'release_pending',
    })
    const model = buildCustomerAnswerCardModel({
      project, canonical, sourceJob: job,
      disputeStatus: undefined, fundingStatus: undefined, fundingRequestId: undefined,
    })
    expect(model.tone).toBe('loud')
    expect(model.label).toBe('Bestätigen & freigeben')
    expect(model.ctaLabel).toBe('Bestätigen & freigeben')
    expect(model.route.to).toBe('/projects/project-1')
  })
})

// ── Hook structural guards — lock the 3 critical fixes ─────────────────────────

const hookSource = readFileSync(
  resolve(__dirname, '../../src/hooks/useHomeState.ts'),
  'utf8',
)

function answerCardSection(): string {
  return hookSource.slice(
    hookSource.indexOf('export function useCustomerAnswerCard'),
    hookSource.indexOf('export function useOwnerHomeState'),
  )
}

describe('useCustomerAnswerCard — critical-fix guards', () => {
  it('wires dispute through getDisputeByJobId (was hard-coded undefined)', () => {
    expect(answerCardSection()).toContain('getDisputeByJobId(')
  })

  it('subscribes to payments, funding requests and escrow plans', () => {
    const s = answerCardSection()
    expect(s).toContain('subscribePayments(')
    expect(s).toContain('subscribeFundingRequests(')
    expect(s).toContain('subscribeEscrowPlans(')
  })

  it('paymentsTick is in the memo deps (tone must not freeze)', () => {
    const s = answerCardSection()
    const depsLine = s.slice(s.lastIndexOf('}, ['))
    expect(depsLine).toContain('paymentsTick')
  })

  it('re-reads stores + bumps AFTER installing subscriptions (snapshot behaviour, not a comment)', () => {
    const s = answerCardSection()
    // Assert the behaviour-bearing statements that close the render→subscribe
    // race, located after the last subscription call — NOT the prose comment.
    const afterSubs = s.slice(s.indexOf('subscribeEscrowPlans('))
    expect(afterSubs).toContain('setProjects(getProjects())')
    expect(afterSubs).toContain('bumpPayments()')
  })
})
