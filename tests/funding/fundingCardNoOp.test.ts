/**
 * Funding Card No-Op Elimination Tests
 *
 * Verifies:
 * 1. Funding card click navigates when canonical target exists
 * 2. Unresolved target no longer silently no-ops — shows disabled state
 * 3. Error codes map to user-facing German messages
 * 4. Continue-payment CTA behaves the same way (no silent failure)
 * 5. All funding CTAs consistently surface errors instead of hiding
 * 6. No regression to canonical target resolution
 * 7. No regression to funding creation
 * 8. No regression to accepted/funding project truth
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
  FUNDING_TARGET_ERROR_MESSAGES,
  type FundingTargetError,
} from '../../src/lib/funding'
import { deriveCustomerNextStep } from '../../src/lib/jobs/customerNextStepSelectors'
import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import {
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById, addJob } from '../../src/lib/jobs'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
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
    projectTitle: 'No-Op Elimination Test',
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

function buildDepositJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-noop-1',
    projectId: 'synthetic-project-ref',
    title: 'Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€1.000',
    description: 'Deposit required job',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Card No-Op Elimination', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Click navigates when canonical target exists ─────────────────

  describe('1. Funding card click navigates when canonical target exists', () => {
    it('resolver returns valid path when project linked to job', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-nav1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe(`/projects/${job.projectId}?focus=payment`)
        // Path is concrete and navigable — not empty, not null
        expect(result.path.length).toBeGreaterThan(0)
      }
    })

    it('resolver returns valid path from artifact-carried projectId', () => {
      const result = resolveCanonicalFundingTarget('any-job', 'proj-artifact-carried')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe('/projects/proj-artifact-carried?focus=payment')
      }
    })
  })

  // ─── 2. Unresolved target no longer silently no-ops ──────────────────

  describe('2. Unresolved target returns precise error (not silent no-op)', () => {
    it('returns error with code when job has no project', async () => {
      // Use a clean orphan job (not from setupAcceptedQuote which creates a project)
      const orphanJob = buildDepositJob({ id: 'orphan-job-123' })
      await addJob(orphanJob)

      const result = resolveCanonicalFundingTarget(orphanJob.id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBeTruthy()
        expect(result.message).toBeTruthy()
        // Must be one of the known error codes
        expect(['NO_JOB_ID', 'PROJECT_NOT_FOUND', 'JOB_WITHOUT_PROJECT']).toContain(result.code)
      }
    })

    it('returns NO_JOB_ID when jobId is missing', () => {
      const result = resolveCanonicalFundingTarget(undefined)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('NO_JOB_ID')
      }
    })

    it('returns PROJECT_NOT_FOUND when job does not exist in store', () => {
      const result = resolveCanonicalFundingTarget('totally-nonexistent-job')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('PROJECT_NOT_FOUND')
      }
    })
  })

  // ─── 3. Error codes map to user-facing German messages ────────────────

  describe('3. Error codes map to user-facing German messages', () => {
    it('every error code has a user-facing message', () => {
      const codes: FundingTargetError['code'][] = ['NO_JOB_ID', 'PROJECT_NOT_FOUND', 'JOB_WITHOUT_PROJECT']

      for (const code of codes) {
        expect(FUNDING_TARGET_ERROR_MESSAGES[code]).toBeDefined()
        expect(FUNDING_TARGET_ERROR_MESSAGES[code].length).toBeGreaterThan(0)
      }
    })

    it('NO_JOB_ID maps to a clear German message', () => {
      expect(FUNDING_TARGET_ERROR_MESSAGES.NO_JOB_ID).toBe(
        'Zahlungsziel konnte nicht ermittelt werden.'
      )
    })

    it('PROJECT_NOT_FOUND maps to a clear German message', () => {
      expect(FUNDING_TARGET_ERROR_MESSAGES.PROJECT_NOT_FOUND).toBe(
        'Projekt wird geladen — bitte versuchen Sie es erneut.'
      )
    })

    it('JOB_WITHOUT_PROJECT maps to a clear German message', () => {
      expect(FUNDING_TARGET_ERROR_MESSAGES.JOB_WITHOUT_PROJECT).toBe(
        'Kein verknüpftes Projekt gefunden.'
      )
    })
  })

  // ─── 4. Continue-payment CTA behaves consistently ─────────────────────

  describe('4. Continue-payment CTA uses canonical resolver', () => {
    it('next step CTA routes to ?focus=payment when resolver succeeds', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-cta1')

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
      expect(step.actionRoute).toContain(job.projectId)
    })

    it('next step CTA still provides a route even when resolver fails (fallback)', () => {
      const orphanJob = buildDepositJob({
        id: 'cta-orphan-job',
        projectId: 'proj-fallback',
        proposalSentAt: 1,
        proposalAcceptedAt: 1,
      })

      const step = deriveCustomerNextStep(orphanJob)

      // Falls back to projectRoute?focus=payment — not a no-op
      expect(step.actionRoute).toBeDefined()
      expect(step.actionRoute).toContain('?focus=payment')
    })
  })

  // ─── 5. All funding CTAs consistently surface errors ──────────────────

  describe('5. All funding CTAs do not silently no-op', () => {
    it('attention selector suppresses item but logs warning when resolver fails', async () => {
      const orphanJob = buildDepositJob({ id: 'job-attn-noop' })
      await addJob(orphanJob)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const items = deriveAttentionItems([orphanJob], [], Date.now())
      const depositItem = items.find(item => item.id === `attn-deposit-${orphanJob.id}`)

      // Item is suppressed (correct — can't link to anything)
      expect(depositItem).toBeUndefined()
      // Warning is logged (not silently swallowed)
      expect(warnSpy).toHaveBeenCalled()
      const warnCalls = warnSpy.mock.calls.flat().join(' ')
      expect(warnCalls).toContain('AttentionSelectors')

      warnSpy.mockRestore()
    })

    it('attention selector provides correct link when resolver succeeds', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-attn-ok1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      const items = deriveAttentionItems(
        [{ ...job, paymentState: 'deposit_required' } as Job],
        [],
        Date.now(),
      )
      const depositItem = items.find(item => item.id === `attn-deposit-${job.id}`)

      expect(depositItem).toBeDefined()
      expect(depositItem!.linkTo).toBe(`/projects/${job.projectId}?focus=payment`)
    })
  })

  // ─── 6. No regression to canonical target resolution ──────────────────

  describe('6. No regression to canonical target resolution', () => {
    it('resolver still resolves via job store when project exists', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-regress-target1')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
      }))

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.projectId).toBe(job.projectId)
      }
    })

    it('resolver still resolves via reverse lookup', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-regress-target2')

      await addProject(makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      }))

      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()

      const result = resolveCanonicalFundingTarget(job.id)
      expect(result.ok).toBe(true)
    })
  })

  // ─── 7. No regression to funding creation ──────────────────────────────

  describe('7. No regression to funding creation', () => {
    it('funding creation still works end-to-end', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-regress-fund1')

      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.amount).toBe(5000)
      expect(result!.status).toBe('sent')
    })
  })

  // ─── 8. No regression to accepted/funding project truth ───────────────

  describe('8. No regression to accepted/funding project truth', () => {
    it('project with sourceJobId still links correctly', async () => {
      const { job } = await setupAcceptedQuote('conv-noop-regress-truth1')

      const project = makeProject({
        id: job.projectId,
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const projectByJob = getProjectByJobId(job.id)
      expect(projectByJob).toBeDefined()
      expect(projectByJob!.id).toBe(job.projectId)

      // And the canonical resolver works for this project
      const target = resolveCanonicalFundingTarget(job.id)
      expect(target.ok).toBe(true)
      if (target.ok) {
        expect(target.path).toBe(`/projects/${job.projectId}?focus=payment`)
      }
    })
  })
})
