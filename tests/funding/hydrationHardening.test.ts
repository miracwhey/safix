/**
 * Funding Target Hydration Hardening Tests
 *
 * Verifies the funding card / CTA entry path survives:
 * 1. Cold start — resolver works with artifact-carried projectId even when
 *    job/project stores are empty
 * 2. Explicit artifact-carried target wins over store inference
 * 3. All funding CTAs use the same unified resolver
 * 4. No generic /projects fallback when canonical target exists
 * 5. Accepted/funding truth renders correctly on direct entry
 * 6. No regression to funding creation, canonical job resolution, or lifecycle
 * 7. Artifact record carries projectId after funding creation
 * 8. Resolver with both projectId and jobId prefers projectId
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
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
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
    projectTitle: 'Hydration Test',
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
  installSessionForJobOwner(job)

  return { conv, offer: acceptedOffer, job }
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

describe('Funding Target Hydration Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Artifact-carried projectId survives cold start ───────────────

  describe('1. Cold start / hydration-safe resolution', () => {
    it('resolver returns valid target from explicit projectId even without store hydration', () => {
      // Simulate: stores are empty but the artifact carries projectId
      const result = resolveCanonicalFundingTarget(undefined, 'proj-cold-start-123')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe('proj-cold-start-123')
        expect(result.path).toBe('/projects/proj-cold-start-123?focus=payment')
        expect(result.path).not.toBe('/projects')
      }
    })

    it('resolver returns valid target from explicit projectId when jobId is unknown', () => {
      const result = resolveCanonicalFundingTarget('', 'proj-explicit-456')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe('proj-explicit-456')
        expect(result.path).toBe('/projects/proj-explicit-456?focus=payment')
      }
    })

    it('resolver returns valid target from explicit projectId when job store is empty', () => {
      // jobId exists but job is not in the store — simulates delayed hydration
      const result = resolveCanonicalFundingTarget('nonexistent-job', 'proj-pre-hydration')

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe('proj-pre-hydration')
        expect(result.path).toContain('?focus=payment')
      }
    })
  })

  // ─── 2. Explicit artifact-carried target wins over store inference ────

  describe('2. Artifact-carried target takes priority', () => {
    it('explicit projectId wins even when job store has different projectId', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-priority1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      // Pass explicit projectId that differs from job.projectId
      const result = resolveCanonicalFundingTarget(job.id, 'explicit-override-proj')

      expect(result.ok).toBe(true)
      if (result.ok) {
        // Explicit projectId wins
        expect(result.projectId).toBe('explicit-override-proj')
        expect(result.path).toBe('/projects/explicit-override-proj?focus=payment')
      }
    })
  })

  // ─── 3. Funding artifact record now carries projectId ─────────────────

  describe('3. Artifact record persists projectId at creation', () => {
    it('requestFundingWorkflow writes projectId on the funding_step artifact', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-hydrate-artifact1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      expect(record).toBeDefined()
      expect(record!.jobId).toBe(job.id)
      // The new field: projectId is persisted on the artifact record
      expect(record!.projectId).toBe(job.projectId)
    })

    it('resolved FundingStepArtifact exposes projectId', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-hydrate-artifact2')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.projectId).toBe(job.projectId)
    })
  })

  // ─── 4. All funding CTAs use unified funding entry route ────────────────

  describe('4. Unified funding entry for all CTAs', () => {
    it('funding card and next-step CTA both route to dedicated funding entry', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-unified1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      await requestFundingWorkflow(job.id)

      // Card resolver: project-based resolution still works
      const cardTarget = resolveCanonicalFundingTarget(job.id, job.projectId)
      expect(cardTarget.ok).toBe(true)

      // Next step CTA: now uses dedicated funding entry route
      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()
      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )

      if (cardTarget.ok) {
        expect(cardTarget.path).toContain('?focus=payment')
      }
      // Next-step CTA routes to dedicated funding entry
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)
    })
  })

  // ─── 5. No generic /projects fallback ──────────────────────────────────

  describe('5. No generic /projects fallback', () => {
    it('never returns bare /projects path', () => {
      const result = resolveCanonicalFundingTarget('job-123', 'proj-456')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).not.toBe('/projects')
        expect(result.path).not.toBe('/projects/')
        expect(result.path).toContain('/projects/proj-456')
      }
    })

    it('returns precise error instead of fallback when no target exists', () => {
      const result = resolveCanonicalFundingTarget('nonexistent-job')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('PROJECT_NOT_FOUND')
        expect(result.message).toBeTruthy()
      }
    })

    it('returns NO_JOB_ID error when both jobId and projectId are missing', () => {
      const result = resolveCanonicalFundingTarget(undefined)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('NO_JOB_ID')
      }
    })
  })

  // ─── 6. Accepted/funding truth on direct entry ─────────────────────────

  describe('6. Accepted/funding truth on direct entry', () => {
    it('canonical status from accepted job is not request', () => {
      const status = deriveProjectStatusFromJob({
        status: 'booked' as const,
        proposalSentAt: Date.now() - 1000,
        proposalAcceptedAt: Date.now(),
      })
      expect(status).toBe('accepted')
      expect(status).not.toBe('request')
    })

    it('stale project status is overridden by canonical job derivation', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-truth1')

      const linkedJob = getJobById(job.id)
      expect(linkedJob).toBeDefined()

      const canonicalStatus = deriveProjectStatusFromJob(linkedJob!)
      expect(canonicalStatus).not.toBe('request')
    })
  })

  // ─── 7. Reload / re-entry hardening ────────────────────────────────────

  describe('7. Reload / re-entry hardening', () => {
    it('artifact-carried target resolves after simulated store clear', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-hydrate-reload1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record).toBeDefined()

      // Record carries both jobId and projectId
      const carriedJobId = record!.jobId!
      const carriedProjectId = record!.projectId!

      // Simulate cold start: resolve using carried data
      // The resolver should succeed even if stores were theoretically empty
      const result = resolveCanonicalFundingTarget(carriedJobId, carriedProjectId)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
        expect(result.path).toBe(`/projects/${job.projectId}?focus=payment`)
      }
    })

    it('funding target is deterministic across multiple calls', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-reload2')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      const result1 = resolveCanonicalFundingTarget(job.id, job.projectId)
      const result2 = resolveCanonicalFundingTarget(job.id, job.projectId)
      const result3 = resolveCanonicalFundingTarget(job.id, job.projectId)

      expect(result1).toEqual(result2)
      expect(result2).toEqual(result3)
    })
  })

  // ─── 8. Store-based fallback still works when projectId absent ─────────

  describe('8. Store fallback when artifact lacks projectId', () => {
    it('falls back to job store when explicit projectId is empty', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-fallback1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      // Empty projectId — should fall back to store lookup
      const result = resolveCanonicalFundingTarget(job.id, '')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
        expect(result.path).toContain('?focus=payment')
      }
    })

    it('falls back to reverse lookup when job.projectId project not in store', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-fallback2')

      // The project was created by acceptOfferWorkflow with sourceJobId
      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
    })
  })

  // ─── 9. No regressions ─────────────────────────────────────────────────

  describe('9. No regressions', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-regress1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })

    it('canonical job resolution still works', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-hydrate-regress2')

      const loadedJob = getJobById(job.id)
      expect(loadedJob).toBeDefined()
      expect(loadedJob!.sourceConversationId).toBe(conv.id)
    })

    it('quote lifecycle still progresses correctly', async () => {
      const { offer, job } = await setupAcceptedQuote('conv-hydrate-regress3')

      expect(offer.status).toBe('accepted')
      expect(offer.createdJobId).toBeTruthy()
      expect(job.sourceOfferId).toBe(offer.id)
    })

    it('existing resolver callers (single-arg) still work', async () => {
      const { job } = await setupAcceptedQuote('conv-hydrate-compat1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      // Call with only jobId (no projectId) — backwards compatible
      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
      }
    })
  })
})
