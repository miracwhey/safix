/**
 * Funding Artifact Target Canonicalization Tests
 *
 * Proves that the client-side funding_step artifact write path persists
 * the canonical customer-facing project ID — not a synthetic/conversation-scoped
 * job.projectId.
 *
 * The canonical project is the one whose sourceJobId matches the funding job,
 * which is the same resolution the server-authoritative path uses
 * (api/request-funding.ts: projects.source_job_id = canonicalJob.id).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import { resolveCanonicalFundingTarget } from '../../src/lib/funding'
import {
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { getProjectByJobId } from '../../src/lib/projects'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import type { Conversation } from '../../src/lib/messages/types'

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
    projectTitle: 'Target Canonicalization Test',
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Artifact Target Canonicalization', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Persisted projectId matches the canonical customer-facing project ──

  describe('1. Persisted artifact projectId is canonical', () => {
    it('funding artifact projectId matches getProjectByJobId (canonical project)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-canon-target1')

      await requestFundingWorkflow(job.id)

      // The canonical customer-facing project is the one whose sourceJobId matches
      const canonicalProject = getProjectByJobId(job.id)
      expect(canonicalProject).toBeDefined()

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      expect(record).toBeDefined()
      // The persisted projectId must match the canonical project, not just job.projectId
      expect(record!.projectId).toBe(canonicalProject!.id)
    })

    it('resolved FundingStepArtifact projectId matches canonical project', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-canon-target2')

      await requestFundingWorkflow(job.id)

      const canonicalProject = getProjectByJobId(job.id)
      expect(canonicalProject).toBeDefined()

      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.projectId).toBe(canonicalProject!.id)
    })
  })

  // ─── 2. Canonical resolver using artifact-persisted projectId ─────────────

  describe('2. Canonical resolver works with persisted target', () => {
    it('resolveCanonicalFundingTarget with artifact projectId navigates correctly', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-canon-resolve1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')!

      // Use the persisted projectId in the resolver (as ThreadArtifactFundingCard does)
      const result = resolveCanonicalFundingTarget(record.jobId!, record.projectId)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const canonicalProject = getProjectByJobId(job.id)!
        expect(result.projectId).toBe(canonicalProject.id)
        expect(result.path).toBe(`/projects/${canonicalProject.id}?focus=payment`)
        expect(result.path).toContain('?focus=payment')
        // Never generic /projects fallback
        expect(result.path).not.toBe('/projects')
      }
    })
  })

  // ─── 3. No regression to funding creation ─────────────────────────────────

  describe('3. No regressions', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-canon-regress1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })

    it('canonical job resolution still works', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-canon-regress2')

      const loadedJob = getJobById(job.id)
      expect(loadedJob).toBeDefined()
      expect(loadedJob!.sourceConversationId).toBe(conv.id)
    })

    it('quote lifecycle still progresses correctly', async () => {
      const { offer, job } = await setupAcceptedQuote('conv-canon-regress3')

      expect(offer.status).toBe('accepted')
      expect(offer.createdJobId).toBeTruthy()
      expect(job.sourceOfferId).toBe(offer.id)
    })
  })
})
