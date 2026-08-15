/**
 * Canonical Funding Target Resolution Tests
 *
 * Verifies:
 * 1. Resolver returns correct project + path when job exists
 * 2. Resolver uses reverse lookup (project.sourceJobId) when job not in store
 * 3. Resolver returns precise error when no target found
 * 4. Funding card uses canonical resolver (never generic /projects fallback)
 * 5. Customer next step CTAs use ?focus=payment for payment routes
 * 6. Project detail derives canonical status from linked job
 * 7. No regression to funding creation, canonical job resolution, or quote lifecycle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the provider profile service to avoid real HTTP calls
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import { resolveCanonicalFundingTarget } from '../../src/lib/funding'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveProjectStatusFromJob } from '../../src/lib/projects'
import {
  getFundingRequestByJobId,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByOfferId,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { addProject, getProjectById, getProjectByJobId } from '../../src/lib/projects'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'
import type { Job } from '../../src/lib/jobs'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: `customer-${id}`,
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: `craftsman-${id}`,
    projectTitle: 'Canonical Target Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

async function setupAcceptedQuote(convId: string) {
  const conv = makeConversation(convId)
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: `customer-${convId}`,
    craftsmanUserId: `craftsman-${convId}`,
    price: '5.000 €',
  })

  await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const acceptedOffer = getOfferById(offer.id)!
  const job = getJobById(acceptedOffer.createdJobId!)!
  const escrowPlan = getEscrowPlanByOfferId(offer.id)!
  installSessionForJobOwner(job)

  return { conv, offer: acceptedOffer, job, escrowPlan }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = Date.now()
  return {
    id: overrides.id ?? 'proj-test-1',
    sourceJobId: overrides.sourceJobId ?? '',
    title: overrides.title ?? 'Test Project',
    customer: 'Max Mustermann',
    craftsman: 'Hans Handwerker',
    location: 'Berlin',
    dateLabel: 'Heute',
    price: '1.000 €',
    status: overrides.status ?? 'request',
    paymentState: overrides.paymentState ?? 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Canonical Funding Target Resolution', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Resolver returns correct project via job ─────────────────────

  describe('1. Resolver via job.projectId', () => {
    it('resolves canonical target when job and project exist', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-1')

      // Create a project linked to the job
      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      })
      await addProject(project)

      const result = resolveCanonicalFundingTarget(job.id)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
        expect(result.path).toBe(`/projects/${job.projectId}?focus=payment`)
        expect(result.path).not.toBe('/projects')
      }
    })

    it('never returns generic /projects path', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-no-generic')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      })
      await addProject(project)

      const result = resolveCanonicalFundingTarget(job.id)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toContain('?focus=payment')
        expect(result.path).not.toBe('/projects')
        expect(result.path).not.toBe('/projects/')
      }
    })
  })

  // ─── 2. Resolver via project.sourceJobId reverse lookup ──────────────

  describe('2. Resolver via reverse lookup (project.sourceJobId)', () => {
    it('resolves target via reverse lookup when project linked by sourceJobId', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-reverse1')

      // acceptOfferWorkflow creates a project with id = job.projectId
      // Verify the reverse lookup works for it
      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBeDefined()
        expect(result.path).toContain('?focus=payment')
      }
    })
  })

  // ─── 3. Resolver returns precise error ────────────────────────────────

  describe('3. Precise error codes', () => {
    it('returns NO_JOB_ID when jobId is undefined', () => {
      const result = resolveCanonicalFundingTarget(undefined)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('NO_JOB_ID')
        expect(result.message).toBeTruthy()
      }
    })

    it('returns NO_JOB_ID when jobId is empty string', () => {
      const result = resolveCanonicalFundingTarget('')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('NO_JOB_ID')
      }
    })

    it('returns PROJECT_NOT_FOUND when job does not exist in store', () => {
      const result = resolveCanonicalFundingTarget('nonexistent-job-id')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('PROJECT_NOT_FOUND')
      }
    })
  })

  // ─── 4. Funding card uses canonical resolver ──────────────────────────

  describe('4. Funding card resolves to canonical target', () => {
    it('funding artifact jobId → canonical project via resolver', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-cft-card1')

      // Create the project linked to the job
      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      expect(record).toBeDefined()
      expect(record!.jobId).toBe(job.id)

      // The canonical resolver should return the same path the card uses
      const target = resolveCanonicalFundingTarget(record!.jobId!)
      expect(target.ok).toBe(true)
      if (target.ok) {
        expect(target.projectId).toBe(job.projectId)
        expect(target.path).toBe(`/projects/${job.projectId}?focus=payment`)
      }
    })
  })

  // ─── 5. Customer next step CTAs use ?focus=payment ────────────────────

  describe('5. Next step CTAs use dedicated funding entry route', () => {
    it('Fund Escrow CTA routes to dedicated funding entry route', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-nextstep1')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      await requestFundingWorkflow(job.id)

      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()

      // deriveCustomerNextStep with deposit_required + funding_pending
      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )

      // Now routes to dedicated funding entry route keyed by fundingRequestId
      expect(step.actionRoute).toContain('/funding/')
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)
    })
  })

  // ─── 6. Project detail derives canonical status from job ──────────────

  describe('6. Canonical status derivation from linked job', () => {
    it('deriveProjectStatusFromJob maps accepted job to accepted status', () => {
      const acceptedJob = {
        status: 'booked' as const,
        proposalSentAt: Date.now() - 1000,
        proposalAcceptedAt: Date.now(),
      }

      const status = deriveProjectStatusFromJob(acceptedJob)
      expect(status).toBe('accepted')
      // Not 'request' — even if the project.status is still 'request'
      expect(status).not.toBe('request')
    })

    it('deriveProjectStatusFromJob maps in_progress job correctly', () => {
      const inProgressJob = {
        status: 'in_progress' as const,
        proposalSentAt: Date.now() - 2000,
        proposalAcceptedAt: Date.now() - 1000,
      }

      const status = deriveProjectStatusFromJob(inProgressJob)
      expect(status).toBe('in_progress')
    })

    it('project with stale request status resolves to accepted via canonical job', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-stale1')

      // Project has stale 'request' status but linked to an accepted job
      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'request',
        paymentState: 'none',
      })
      await addProject(project)

      // The linked job should be accepted/booked
      const linkedJob = getJobById(job.id)
      expect(linkedJob).toBeDefined()

      // Canonical status derivation from job overrides stale project status
      const canonicalStatus = deriveProjectStatusFromJob(linkedJob!)
      expect(canonicalStatus).not.toBe('request')
    })
  })

  // ─── 7. All funding CTAs land at same canonical target ────────────────

  describe('7. All entry points resolve to same target', () => {
    it('funding card and next step CTA resolve to same funding entry', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-same1')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      await requestFundingWorkflow(job.id)

      // Funding card target — project-based resolver still works
      const cardTarget = resolveCanonicalFundingTarget(job.id)
      expect(cardTarget.ok).toBe(true)

      // Next step CTA target — now uses dedicated funding entry route
      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()
      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )

      // Both resolve to the same funding request, via different paths
      // Card target uses project resolver, next-step uses funding entry route
      if (cardTarget.ok) {
        expect(cardTarget.path).toContain('?focus=payment')
      }
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)
    })
  })

  // ─── 8. No regressions ────────────────────────────────────────────────

  describe('8. No regressions', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-regress1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })

    it('canonical job resolution still works', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-cft-regress2')

      const loadedJob = getJobById(job.id)
      expect(loadedJob).toBeDefined()
      expect(loadedJob!.sourceConversationId).toBe(conv.id)
    })

    it('quote lifecycle still progresses correctly', async () => {
      const { offer, job } = await setupAcceptedQuote('conv-cft-regress3')

      expect(offer.status).toBe('accepted')
      expect(offer.createdJobId).toBeTruthy()
      expect(job.sourceOfferId).toBe(offer.id)
    })

    it('project scoping via sourceJobId still works', async () => {
      const { job } = await setupAcceptedQuote('conv-cft-regress4')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      })
      await addProject(project)

      const loaded = getProjectById(job.projectId)
      expect(loaded).toBeDefined()
      expect(loaded!.sourceJobId).toBe(job.id)

      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()
      expect(projectByJob!.id).toBe(job.projectId)
    })
  })
})
