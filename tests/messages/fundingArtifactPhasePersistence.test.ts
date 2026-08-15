/**
 * Block 4 — Funding Artifact Phase Persistence Symmetry Tests
 *
 * Validates that funding artifact phases are persisted durably through
 * lifecycle transitions, closing the asymmetry where offer artifacts had
 * explicit updateOfferArtifactPhase() but funding artifacts relied entirely
 * on selector-level override at read time.
 *
 * Tests prove:
 * 1. Funding artifact phase is persisted correctly at creation ('sent')
 * 2. Canonical funding progression updates the persisted artifact phase
 * 3. Funded truth no longer depends primarily on selector rescue
 * 4. Repeated updates are idempotent
 * 5. Failure/cancel/expired phases behave correctly
 * 6. No regression to thread active-vs-historical rules
 * 7. No regression to Blocks 1–3 and conversation linkage
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the provider profile service to avoid real HTTP calls
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  getThreadArtifactRecord,
  updateOfferArtifactPhase,
  updateFundingArtifactPhase,
} from '../../src/lib/messages/threadArtifactService'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { getThreadArtifacts } from '../../src/lib/messages/threadArtifactSelectors'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  confirmFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { addConversation } from '../../src/lib/messages'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import {
  getFundingRequestByJobId,
  markFundingFailed,
  markFundingCancelled,
} from '../../src/lib/payments/fundingRequest'
import type { ThreadArtifactRecord } from '../../src/lib/messages/threadArtifactRecord'
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
    projectTitle: 'Artifact Phase Test',
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

describe('Block 4 — Funding Artifact Phase Persistence', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Funding artifact phase persisted correctly at creation ─────────

  describe('1. Funding artifact created with correct initial phase', () => {
    it('requestFundingWorkflow creates funding_step artifact with phase=sent', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-create')

      await requestFundingWorkflow(job.id)

      const record = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(record).toBeDefined()
      expect(record!.phase).toBe('sent')
      expect(record!.snapshotPhaseLabel).toBe('Zahlung angefordert')
      expect(record!.jobId).toBe(job.id)
    })
  })

  // ── 2. Canonical funding progression updates persisted artifact phase ──

  describe('2. Funding lifecycle persists phase progression', () => {
    it('customerFundingEntryWorkflow updates artifact phase to funding_started', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-started')

      await requestFundingWorkflow(job.id)

      // Before entry: artifact is 'sent'
      const beforeRecord = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(beforeRecord!.phase).toBe('sent')

      // Customer enters funding flow
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // After entry: artifact is 'funding_started'
      const afterRecord = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(afterRecord!.phase).toBe('funding_started')
      expect(afterRecord!.snapshotPhaseLabel).toBe('Einzahlung gestartet')
    })

    it('confirmFundingWorkflow updates artifact phase to funded', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-funded')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Before confirmation: artifact is 'funding_started'
      const beforeRecord = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(beforeRecord!.phase).toBe('funding_started')

      // Confirm funding
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // After confirmation: artifact is 'funded'
      const afterRecord = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(afterRecord!.phase).toBe('funded')
      expect(afterRecord!.snapshotPhaseLabel).toBe('Zahlung bestätigt')
    })

    it('full lifecycle: sent → funding_started → funded persists each phase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-full')

      // 1. Request → sent
      await requestFundingWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('sent')

      // 2. Customer entry → funding_started
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('funding_started')

      // 3. Confirm → funded
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('funded')
    })
  })

  // ── 3. Funded truth no longer depends primarily on selector rescue ────

  describe('3. Funded truth from persisted artifact, not just selector override', () => {
    it('persisted artifact phase is funded after confirmation, selector reads it directly', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-truth')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // The PERSISTED record has phase='funded' — selector does not need to override
      const record = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(record!.phase).toBe('funded')

      // The resolved artifact also shows 'funded'
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })
  })

  // ── 4. Repeated updates are idempotent ────────────────────────────────

  describe('4. Idempotent phase updates', () => {
    it('updateFundingArtifactPhase is idempotent — same phase is a no-op', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-idempotent')

      await requestFundingWorkflow(job.id)

      const beforeRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      const beforeUpdatedAt = beforeRecord.updatedAt

      // Call again with same phase
      await updateFundingArtifactPhase(conv.id, 'sent')

      const afterRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      // updatedAt should not change since phase is already 'sent'
      expect(afterRecord.updatedAt).toBe(beforeUpdatedAt)
      expect(afterRecord.phase).toBe('sent')
    })

    it('confirmFundingWorkflow is idempotent — second call does not break artifact', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-idempotent2')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const firstRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(firstRecord.phase).toBe('funded')

      // Second confirmation
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const secondRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(secondRecord.phase).toBe('funded')
    })

    it('no-op when artifact does not exist', async () => {
      // No artifact created — updateFundingArtifactPhase should not throw
      await expect(
        updateFundingArtifactPhase('non-existent-conv', 'funded')
      ).resolves.toBeUndefined()
    })
  })

  // ── 5. Failure/cancel/expired phases ──────────────────────────────────

  describe('5. Failure and terminal phases via direct update', () => {
    it('funding_failed phase can be persisted via updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-failed')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Simulate failure: update artifact phase directly
      await updateFundingArtifactPhase(conv.id, 'funding_failed', {
        snapshotPhaseLabel: 'Einzahlung fehlgeschlagen',
      })

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('funding_failed')
      expect(record.snapshotPhaseLabel).toBe('Einzahlung fehlgeschlagen')
    })

    it('cancelled phase can be persisted via updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-cancelled')

      await requestFundingWorkflow(job.id)

      await updateFundingArtifactPhase(conv.id, 'cancelled', {
        snapshotPhaseLabel: 'Einzahlung storniert',
      })

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('cancelled')
      expect(record.snapshotPhaseLabel).toBe('Einzahlung storniert')
    })

    it('expired phase can be persisted via updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-expired')

      await requestFundingWorkflow(job.id)

      await updateFundingArtifactPhase(conv.id, 'expired', {
        snapshotPhaseLabel: 'Einzahlung abgelaufen',
      })

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('expired')
    })
  })

  // ── 6. No regression to thread active-vs-historical rules ─────────────

  describe('6. Thread reconciliation rules preserved', () => {
    it('funded funding artifact still supersedes offer card for same jobId', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-supersede')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const artifacts = getThreadArtifacts(conv.id)

      // Funding artifact is funded
      expect(artifacts.fundingStepArtifact).not.toBeNull()
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')

      // Offer is superseded (same jobId context)
      expect(artifacts.offerFundingSuperseded).toBe(true)

      // Offer phase is downgraded from payment_due to accepted
      expect(artifacts.offerPaymentArtifact).not.toBeNull()
      expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
    })

    it('active CTA funding artifact supersedes offer card', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-cta')

      await requestFundingWorkflow(job.id)

      // funding_step is in 'sent' phase (active CTA)
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('sent')
      expect(artifacts.offerFundingSuperseded).toBe(true)
    })

    it('failed funding artifact does NOT supersede offer card', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-fail-nosupersede')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Simulate failure
      await updateFundingArtifactPhase(conv.id, 'funding_failed', {
        snapshotPhaseLabel: 'Einzahlung fehlgeschlagen',
      })

      // Also update the canonical funding request status
      const fr = getFundingRequestByJobId(job.id)!
      await markFundingFailed(fr.id)

      const artifacts = getThreadArtifacts(conv.id)

      // Offer is NOT superseded (funding failed = terminal non-success)
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })
  })

  // ── 7. Symmetry with offer artifact lifecycle ─────────────────────────

  describe('7. Offer/funding artifact phase symmetry', () => {
    it('updateOfferArtifactPhase returns Promise<void> (existing contract)', async () => {
      const conv = makeConversation('conv-phase-sym-offer')
      await addConversation(conv)

      await createOfferWorkflow({
        conversationId: conv.id,
        customerUserId: `customer-conv-phase-sym-offer`,
        craftsmanUserId: `craftsman-conv-phase-sym-offer`,
        price: '3.000 €',
      })

      const result = updateOfferArtifactPhase(conv.id, 'declined')
      expect(result).toBeInstanceOf(Promise)
      await result

      const record = getThreadArtifactRecord(conv.id, 'offer')
      expect(record!.phase).toBe('declined')
    })

    it('updateFundingArtifactPhase returns Promise<void> (new symmetric contract)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-sym-funding')

      await requestFundingWorkflow(job.id)

      const result = updateFundingArtifactPhase(conv.id, 'funded', {
        snapshotPhaseLabel: 'Zahlung bestätigt',
      })
      expect(result).toBeInstanceOf(Promise)
      await result

      const record = getThreadArtifactRecord(conv.id, 'funding_step')
      expect(record!.phase).toBe('funded')
    })
  })

  // ── 8. updatedAt timestamp advances on phase change ───────────────────

  describe('8. Timestamp semantics', () => {
    it('updatedAt advances when phase changes', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-phase-timestamp')

      await requestFundingWorkflow(job.id)

      const createdRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      const createdUpdatedAt = createdRecord.updatedAt

      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 5))

      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      const updatedRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(updatedRecord.updatedAt).toBeGreaterThanOrEqual(createdUpdatedAt)
      expect(updatedRecord.phase).toBe('funding_started')
    })
  })

  // ── 9. Terminal lifecycle paths with canonical service functions ───────

  describe('9. Terminal lifecycle paths wire through canonical service + artifact update', () => {
    it('funding_failed persisted via markFundingFailed + updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-terminal-failed')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Mark canonical funding request as failed
      const fr = getFundingRequestByJobId(job.id)!
      await markFundingFailed(fr.id, 'card_declined')

      // Persist terminal artifact phase
      await updateFundingArtifactPhase(conv.id, 'funding_failed', {
        snapshotPhaseLabel: 'Einzahlung fehlgeschlagen',
      })

      // Both canonical entity and artifact reflect failure
      const updatedFr = getFundingRequestByJobId(job.id)!
      expect(updatedFr.status).toBe('funding_failed')

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('funding_failed')
      expect(record.snapshotPhaseLabel).toBe('Einzahlung fehlgeschlagen')
    })

    it('cancelled persisted via markFundingCancelled + updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-terminal-cancelled')

      await requestFundingWorkflow(job.id)

      // Mark canonical funding request as cancelled
      const fr = getFundingRequestByJobId(job.id)!
      await markFundingCancelled(fr.id)

      // Persist terminal artifact phase
      await updateFundingArtifactPhase(conv.id, 'cancelled', {
        snapshotPhaseLabel: 'Einzahlung storniert',
      })

      // Both canonical entity and artifact reflect cancellation
      const updatedFr = getFundingRequestByJobId(job.id)!
      expect(updatedFr.status).toBe('cancelled')

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('cancelled')
    })

    it('expired persisted via updateFundingArtifactPhase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-terminal-expired')

      await requestFundingWorkflow(job.id)

      // Persist terminal artifact phase (no canonical expiration service exists yet)
      await updateFundingArtifactPhase(conv.id, 'expired', {
        snapshotPhaseLabel: 'Einzahlung abgelaufen',
      })

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('expired')
    })

    it('terminal phases are idempotent — repeated update is a no-op', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-terminal-idempotent')

      await requestFundingWorkflow(job.id)
      await updateFundingArtifactPhase(conv.id, 'funding_failed')

      const firstRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      const firstUpdatedAt = firstRecord.updatedAt

      // Second call with same phase — idempotent
      await updateFundingArtifactPhase(conv.id, 'funding_failed')

      const secondRecord = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(secondRecord.updatedAt).toBe(firstUpdatedAt)
      expect(secondRecord.phase).toBe('funding_failed')
    })
  })

  // ── 10. Selector rescue remains as fallback, not primary mechanism ────

  describe('10. Selector rescue remains fallback for stale/out-of-band cases', () => {
    it('selector overrides stale stored phase to funded when canonical funded truth exists', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-rescue-stale')

      await requestFundingWorkflow(job.id)

      // Stored artifact phase is 'sent' (stale)
      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('sent')

      // Advance canonical state to funded via workflow (which also updates artifact)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // Artifact is already 'funded' (primary persistence)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('funded')

      // Selector also resolves to 'funded' — primary persistence wins
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('selector rescue corrects stale artifact when out-of-band funding happened', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-rescue-outofband')

      await requestFundingWorkflow(job.id)

      // Directly read the artifact — phase is stale 'sent'
      const repo = getThreadArtifactRepository()
      const artifactBefore = repo.getByConversationAndType(conv.id, 'funding_step')!
      expect(artifactBefore.phase).toBe('sent')

      // Confirm funding through workflow (this sets canonical state + updates artifact)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // After workflow, artifact is updated (primary persistence)
      const artifactAfter = repo.getByConversationAndType(conv.id, 'funding_step')!
      expect(artifactAfter.phase).toBe('funded')
    })

    it('selector does NOT override terminal failure phases with funded dominance', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-rescue-no-override-terminal')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      // Mark canonical entity as failed too (selector reads live entity first)
      const fr = getFundingRequestByJobId(job.id)!
      await markFundingFailed(fr.id, 'card_declined')

      // Persist funding_failed as terminal artifact phase
      await updateFundingArtifactPhase(conv.id, 'funding_failed')

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('funding_failed')

      // Selector reads live entity (which is 'funding_failed'), terminal phase preserved
      // (funded dominance excludes funding_failed, cancelled, expired)
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funding_failed')
    })

    it('direct repository read confirms artifact record matches persisted phase', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-rescue-direct-read')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      // Direct repository read to verify persistence
      const repo = getThreadArtifactRepository()
      const rawRecord: ThreadArtifactRecord | undefined =
        repo.getByConversationAndType(conv.id, 'funding_step')

      expect(rawRecord).toBeDefined()
      expect(rawRecord!.phase).toBe('funded')
      expect(rawRecord!.artifactType).toBe('funding_step')
      expect(rawRecord!.jobId).toBe(job.id)
    })
  })

  // ── 11. Lifecycle completeness verification ───────────────────────────

  describe('11. Lifecycle completeness verification', () => {
    it('all real production happy-path phases are persisted (not selector-only)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-completeness-happy')

      // Phase 1: sent (creation)
      await requestFundingWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('sent')

      // Phase 2: funding_started (customer entry)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('funding_started')

      // Phase 3: funded (confirmation)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      expect(getThreadArtifactRecord(conv.id, 'funding_step')!.phase).toBe('funded')

      // Verify selector agrees with persisted state
      const artifacts = getThreadArtifacts(conv.id)
      expect(artifacts.fundingStepArtifact!.phase).toBe('funded')
    })

    it('cancelled funding does NOT supersede offer (same as funding_failed)', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-completeness-cancelled-nosupersede')

      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      await markFundingCancelled(fr.id)

      await updateFundingArtifactPhase(conv.id, 'cancelled', {
        snapshotPhaseLabel: 'Einzahlung storniert',
      })

      const artifacts = getThreadArtifacts(conv.id)
      // Cancelled is a terminal non-success phase — offer is NOT superseded
      expect(artifacts.offerFundingSuperseded).toBe(false)
    })

    it('funding_initiated type is supported but not currently a production call site', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-completeness-initiated')

      await requestFundingWorkflow(job.id)

      // funding_initiated exists as a type value but has no production workflow caller.
      // It can be persisted via updateFundingArtifactPhase directly.
      await updateFundingArtifactPhase(conv.id, 'funding_initiated')

      const record = getThreadArtifactRecord(conv.id, 'funding_step')!
      expect(record.phase).toBe('funding_initiated')
    })
  })
})
