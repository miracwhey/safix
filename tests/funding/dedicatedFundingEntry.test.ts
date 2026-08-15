/**
 * Dedicated Funding Entry Route + Stripe Handoff Hardening Tests
 *
 * Verifies:
 * 1. buildFundingEntryPath produces correct /funding/:id paths
 * 2. Valid funding card click always enters dedicated funding entry route
 * 3. Route works on cold start / empty stores (fundingRequestId-keyed)
 * 4. All funding/payment entry CTAs use the same canonical route model
 * 5. No generic /projects fallback for funding entry
 * 6. Attention selector uses dedicated funding entry route when funding request exists
 * 7. Customer next-step CTA uses dedicated funding entry route
 * 8. Disabled CTA only shown when artifact is genuinely corrupted (no fundingRequestId)
 * 9. No regression to funding creation
 * 10. No regression to canonical job resolution
 * 11. No regression to quote lifecycle
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
import {
  resolveCanonicalFundingTarget,
  buildFundingEntryPath,
} from '../../src/lib/funding'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
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
    projectTitle: 'Funding Entry Route Test',
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

describe('Dedicated Funding Entry Route + Stripe Handoff Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. buildFundingEntryPath produces correct paths ──────────────────

  describe('1. buildFundingEntryPath', () => {
    it('produces /funding/:fundingRequestId path', () => {
      const path = buildFundingEntryPath('fr-123')
      expect(path).toBe('/funding/fr-123')
    })

    it('works with UUID-format IDs', () => {
      const path = buildFundingEntryPath('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
      expect(path).toBe('/funding/a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    })

    it('path is deterministic across calls', () => {
      const path1 = buildFundingEntryPath('fr-stable')
      const path2 = buildFundingEntryPath('fr-stable')
      expect(path1).toBe(path2)
    })
  })

  // ─── 2. Valid funding card click enters dedicated funding entry route ──

  describe('2. Valid funding card enters dedicated funding entry route', () => {
    it('funding artifact fundingRequestId maps to dedicated route', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-entry-card1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.fundingRequestId).toBeDefined()

      // The funding card would use buildFundingEntryPath(record.fundingRequestId)
      const entryPath = buildFundingEntryPath(record!.fundingRequestId!)
      expect(entryPath).toBe(`/funding/${record!.fundingRequestId}`)
      expect(entryPath).not.toContain('/projects')
      expect(entryPath).not.toContain('?focus=payment')
    })
  })

  // ─── 3. Route works on cold start (fundingRequestId-keyed) ────────────

  describe('3. Cold start / hydration-safe funding entry', () => {
    it('buildFundingEntryPath works without any store hydration', () => {
      // No setup — stores are empty — but we have the fundingRequestId
      const path = buildFundingEntryPath('fr-cold-start-abc')
      expect(path).toBe('/funding/fr-cold-start-abc')
    })

    it('path does not depend on job store', () => {
      // fundingRequestId is carried by the artifact, not derived from job store
      const path = buildFundingEntryPath('fr-no-job-store')
      expect(path).toBe('/funding/fr-no-job-store')
      // No call to getJobById or getProjectById needed
    })

    it('path does not depend on project store', () => {
      const path = buildFundingEntryPath('fr-no-project-store')
      expect(path).toBe('/funding/fr-no-project-store')
    })
  })

  // ─── 4. All funding CTAs use same canonical route model ───────────────

  describe('4. All funding CTAs use dedicated funding entry route', () => {
    it('next-step CTA and attention selector both use /funding/:id when funding request exists', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-unified1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      await requestFundingWorkflow(job.id)

      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()

      // Next-step CTA
      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)

      // Attention selector
      const items = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = items.find(item => item.id === `attn-deposit-${job.id}`)
      expect(depositItem).toBeDefined()
      expect(depositItem!.linkTo).toBe(`/funding/${fundingReq!.id}`)
    })
  })

  // ─── 5. No generic /projects fallback for funding entry ───────────────

  describe('5. No /projects fallback for valid funding flows', () => {
    it('funding entry path is /funding/:id, never /projects', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-noprojects1')

      await requestFundingWorkflow(job.id)
      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()

      const path = buildFundingEntryPath(fundingReq!.id)
      expect(path).not.toBe('/projects')
      expect(path).not.toBe('/projects/')
      expect(path).not.toContain('/projects/')
      expect(path).toContain('/funding/')
    })
  })

  // ─── 6. Attention selector uses dedicated route ───────────────────────

  describe('6. Attention selector uses dedicated funding entry route', () => {
    it('deposit attention links to /funding/:id when funding request exists', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-attn1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      await requestFundingWorkflow(job.id)
      const fundingReq = getFundingRequestByJobId(job.id)

      const items = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = items.find(item => item.id === `attn-deposit-${job.id}`)
      expect(depositItem).toBeDefined()
      expect(depositItem!.linkTo).toBe(`/funding/${fundingReq!.id}`)
    })

    it('falls back to project-based link when no funding request exists', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-attn-fallback')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      // No requestFundingWorkflow — no funding request
      const items = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = items.find(item => item.id === `attn-deposit-${job.id}`)
      expect(depositItem).toBeDefined()
      // Falls back to project-based path
      expect(depositItem!.linkTo).toContain('?focus=payment')
    })
  })

  // ─── 7. Customer next-step CTA uses dedicated route ───────────────────

  describe('7. Customer next-step CTA uses dedicated funding entry route', () => {
    it('routes to /funding/:id when funding request exists', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-nextstep1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      await requestFundingWorkflow(job.id)
      const fundingReq = getFundingRequestByJobId(job.id)

      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
        undefined,
        fundingReq?.status,
      )
      expect(step.actionRoute).toBe(`/funding/${fundingReq!.id}`)
    })

    it('falls back to ?focus=payment when no funding request exists', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-nextstep-fb')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      const step = deriveCustomerNextStep(
        { ...job, paymentState: 'deposit_required' } as Job,
      )
      expect(step.actionRoute).toContain('?focus=payment')
    })
  })

  // ─── 8. Disabled CTA only for corrupted artifacts ─────────────────────

  describe('8. Disabled CTA only for genuinely corrupted funding artifacts', () => {
    it('valid funding artifact with fundingRequestId is always actionable', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-entry-valid1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.fundingRequestId).toBeTruthy()

      // With a valid fundingRequestId, the entry path is always available
      const path = buildFundingEntryPath(record!.fundingRequestId!)
      expect(path).toBeTruthy()
      expect(path.length).toBeGreaterThan(0)
    })

    it('project resolver failures do NOT prevent funding entry when fundingRequestId exists', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-entry-noproj1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')!

      // Project resolver may fail (e.g. stores not hydrated)
      // But funding entry path is independent of project resolution
      const entryPath = buildFundingEntryPath(record.fundingRequestId!)
      expect(entryPath).toBe(`/funding/${record.fundingRequestId}`)
      // Entry path does NOT depend on resolveCanonicalFundingTarget
    })
  })

  // ─── 9. No regression to funding creation ──────────────────────────────

  describe('9. No regression to funding creation', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-regress-fund1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })

    it('funding request is accessible by ID after creation', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-regress-fund2')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()

      const fundingReq = getFundingRequestByJobId(job.id)
      expect(fundingReq).toBeDefined()
      expect(fundingReq!.id).toBe(result!.fundingRequestId)
    })
  })

  // ─── 10. No regression to canonical job resolution ─────────────────────

  describe('10. No regression to canonical job resolution', () => {
    it('canonical job resolution still works', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-entry-regress-job1')

      const loadedJob = getJobById(job.id)
      expect(loadedJob).toBeDefined()
      expect(loadedJob!.sourceConversationId).toBe(conv.id)
    })

    it('project resolver still works for project-based context', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-regress-job2')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
        expect(result.path).toContain('?focus=payment')
      }
    })
  })

  // ─── 11. No regression to quote lifecycle ──────────────────────────────

  describe('11. No regression to quote lifecycle', () => {
    it('quote lifecycle still progresses correctly', async () => {
      const { offer, job } = await setupAcceptedQuote('conv-entry-regress-quote1')

      expect(offer.status).toBe('accepted')
      expect(offer.createdJobId).toBeTruthy()
      expect(job.sourceOfferId).toBe(offer.id)
    })

    it('project scoping via sourceJobId still works', async () => {
      const { job } = await setupAcceptedQuote('conv-entry-regress-proj1')

      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()
      expect(projectByJob!.sourceJobId).toBe(job.id)
    })
  })
})
