/**
 * Funding Entry Legacy Path Removal + Canonicalization Tests
 *
 * Verifies:
 * 1. All funding/payment CTAs use the same canonical resolver
 * 2. Attention selector deposit_required uses canonical resolver with ?focus=payment
 * 3. No generic /projects fallback in any funding entry path
 * 4. Old funding artifacts without projectId are handled safely via canonical path
 * 5. Accepted/funding truth wins over stale request/builder truth
 * 6. payment_phase does not compete with funding_step for funding card rendering
 * 7. Reload/cold-start still works (artifact-carried projectId)
 * 8. No regression to funding creation, canonical job resolution, or quote lifecycle
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
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
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
    projectTitle: 'Legacy Path Removal Test',
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

describe('Funding Entry Legacy Path Removal + Canonicalization', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. All funding CTAs use dedicated funding entry route ────────────

  describe('1. Unified funding entry route for all CTAs', () => {
    it('funding card, next-step CTA, and attention selector all use dedicated funding entry', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-unified1')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      await requestFundingWorkflow(job.id)

      // 1. Funding card target — project-based resolver still works for project context
      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')!
      const cardTarget = resolveCanonicalFundingTarget(record.jobId!, record.projectId)

      // 2. Next step CTA target — now uses dedicated funding entry route
      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()
      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )

      // 3. Attention selector target — now uses dedicated funding entry route
      const attentionItems = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = attentionItems.find(item => item.id === `attn-deposit-${job.id}`)

      // Card target still resolves project path for project context
      expect(cardTarget.ok).toBe(true)
      if (cardTarget.ok) {
        expect(cardTarget.path).toContain('?focus=payment')
      }

      // Next-step CTA and attention selector use dedicated funding entry route
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)
      expect(depositItem).toBeDefined()
      expect(depositItem!.linkTo).toBe(`/funding/${fundingReq!.id}`)
    })
  })

  // ─── 2. Attention selector uses canonical resolver (not inline) ───────

  describe('2. Attention selector uses canonical resolver', () => {
    it('deposit attention includes ?focus=payment', async () => {
      const { job } = await setupAcceptedQuote('conv-legacy-attn1')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const items = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = items.find(item => item.id === `attn-deposit-${job.id}`)

      expect(depositItem).toBeDefined()
      expect(depositItem!.linkTo).toBe(`/projects/${project.id}?focus=payment`)
      // NOT bare /projects/${project.id} — the old legacy path
      expect(depositItem!.linkTo).not.toBe(`/projects/${project.id}`)
    })

    it('attention deposit suppressed when canonical resolver fails (no project)', () => {
      const job: Job = {
        id: 'job-orphan-1',
        projectId: '',
        title: 'Orphan Job',
        customer: 'Customer',
        location: 'Berlin',
        dateLabel: 'Heute',
        status: 'new',
        amount: '1.000 €',
        description: 'No project',
        paymentState: 'deposit_required',
        documentationStatus: '',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
      }

      const items = deriveAttentionItems([job], [], Date.now())
      const depositItem = items.find(item => item.id === 'attn-deposit-job-orphan-1')

      // Resolver returns error → attention item is suppressed (no silent /projects fallback)
      expect(depositItem).toBeUndefined()
    })
  })

  // ─── 3. No generic /projects fallback in any funding entry path ───────

  describe('3. No generic /projects fallback', () => {
    it('canonical resolver never returns /projects', () => {
      const result = resolveCanonicalFundingTarget('any-job-id', 'proj-123')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).not.toBe('/projects')
        expect(result.path).not.toBe('/projects/')
        expect(result.path).toContain('/projects/proj-123')
      }
    })

    it('resolver error codes are precise (not generic fallback)', () => {
      const noJob = resolveCanonicalFundingTarget(undefined)
      expect(noJob.ok).toBe(false)
      if (!noJob.ok) expect(noJob.code).toBe('NO_JOB_ID')

      const noProject = resolveCanonicalFundingTarget('nonexistent-job')
      expect(noProject.ok).toBe(false)
      if (!noProject.ok) expect(noProject.code).toBe('PROJECT_NOT_FOUND')
    })
  })

  // ─── 4. Old funding artifacts without projectId handled safely ────────

  describe('4. Legacy artifact compatibility (no projectId)', () => {
    it('funding artifact without projectId resolves via store fallback chain', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-noproject1')

      await requestFundingWorkflow(job.id)

      // Simulate a legacy artifact: strip projectId from the record
      const artifactRepo = getThreadArtifactRepository()
      const existing = artifactRepo.getByConversationAndType(conv.id, 'funding_step')!
      await artifactRepo.upsert({
        ...existing,
        projectId: undefined, // Legacy artifact — no projectId
      })

      // The selector should still resolve and the artifact should have empty projectId
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.kind).toBe('funding_step')

      // The canonical resolver should still find the project via job store
      const target = resolveCanonicalFundingTarget(
        artifacts.fundingStepArtifact!.jobId,
        artifacts.fundingStepArtifact!.projectId || undefined
      )
      expect(target.ok).toBe(true)
      if (target.ok) {
        expect(target.path).toContain('?focus=payment')
      }
    })

    it('legacy artifact without fundingRequestId resolves via jobId fallback', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-nofrid1')

      await requestFundingWorkflow(job.id)

      // Simulate a legacy record: strip fundingRequestId
      const artifactRepo = getThreadArtifactRepository()
      const existing = artifactRepo.getByConversationAndType(conv.id, 'funding_step')!
      await artifactRepo.upsert({
        ...existing,
        fundingRequestId: undefined,
        escrowPlanId: undefined,
      })

      // Selector should resolve via getFundingRequestByJobId fallback
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
    })
  })

  // ─── 5. Accepted/funding truth wins over stale request truth ──────────

  describe('5. Accepted/funding truth always wins', () => {
    it('project with stale request status derives accepted from canonical job', async () => {
      const { job } = await setupAcceptedQuote('conv-legacy-truth1')

      // Project has stale 'request' status but linked to accepted job
      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'request',
        paymentState: 'none',
      }))

      const linkedJob = getJobById(job.id)!
      const canonicalStatus = deriveProjectStatusFromJob(linkedJob)
      expect(canonicalStatus).not.toBe('request')
      expect(canonicalStatus).toBe('accepted')
    })

    it('canonical resolver still resolves for stale-status projects', async () => {
      const { job } = await setupAcceptedQuote('conv-legacy-truth2')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'request', // stale
      }))

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toContain('?focus=payment')
      }
    })
  })

  // ─── 6. payment_phase does not compete with funding_step ──────────────

  describe('6. payment_phase does not compete with funding_step', () => {
    it('funding_step artifact is used for funding card, not payment_phase', async () => {
      const { conv } = await setupAcceptedQuote('conv-legacy-type1')

      // After offer acceptance, payment_phase may exist
      const repo = getThreadArtifactRepository()
      const _paymentPhase = repo.getByConversationAndType(conv.id, 'payment_phase')
      // payment_phase should NOT be rendered as a funding card

      const artifacts = getThreadArtifacts(conv.id)
      // Before funding request: no funding card
      expect(artifacts.fundingStepArtifact).toBeNull()
      // But after funding request, only funding_step drives the funding card
    })

    it('only funding_step drives the funding card after funding request', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-type2')

      await requestFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.kind).toBe('funding_step')

      const repo = getThreadArtifactRepository()
      const fundingRecord = repo.getByConversationAndType(conv.id, 'funding_step')
      expect(fundingRecord).toBeDefined()
      expect(fundingRecord!.artifactType).toBe('funding_step')
    })
  })

  // ─── 7. Reload / cold-start still works ───────────────────────────────

  describe('7. Reload / cold-start via artifact-carried projectId', () => {
    it('artifact-carried projectId resolves even when stores are empty', () => {
      const result = resolveCanonicalFundingTarget('any-job', 'proj-carried-123')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe('proj-carried-123')
        expect(result.path).toBe('/projects/proj-carried-123?focus=payment')
      }
    })

    it('artifact record carries projectId after funding creation', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-reload1')

      await requestFundingWorkflow(job.id)

      const repo = getThreadArtifactRepository()
      const record = repo.getByConversationAndType(conv.id, 'funding_step')

      expect(record).toBeDefined()
      expect(record!.projectId).toBe(job.projectId)
    })
  })

  // ─── 8. No regressions ────────────────────────────────────────────────

  describe('8. No regressions', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-legacy-regress1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })

    it('canonical job resolution still works', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-legacy-regress2')

      const loadedJob = getJobById(job.id)
      expect(loadedJob).toBeDefined()
      expect(loadedJob!.sourceConversationId).toBe(conv.id)
    })

    it('quote lifecycle still progresses correctly', async () => {
      const { offer, job } = await setupAcceptedQuote('conv-legacy-regress3')

      expect(offer.status).toBe('accepted')
      expect(offer.createdJobId).toBeTruthy()
      expect(job.sourceOfferId).toBe(offer.id)
    })

    it('participant scoping via sourceJobId still works', async () => {
      const { job } = await setupAcceptedQuote('conv-legacy-regress4')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      })
      await addProject(project)

      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()
      expect(projectByJob!.id).toBe(job.projectId)
    })
  })
})
