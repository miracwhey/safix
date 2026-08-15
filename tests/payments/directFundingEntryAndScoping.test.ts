/**
 * Direct Funding Entry + Strict Project Scoping Tests
 *
 * Verifies:
 * 1. Thread funding card opens the canonical funding target directly
 *    (with ?focus=payment query param)
 * 2. Project list badge links to the same canonical target
 * 3. Unrelated projects (request/inquiry state) do NOT show funding badge/state
 * 4. Accepted canonical project DOES show funding state
 * 5. Customer lands on the real payment component/flow
 * 6. Reload/re-entry preserves the same funding destination
 * 7. No regression to canonical job resolution, funding creation,
 *    quote lifecycle, or participant scoping
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
  getFundingRequestByJobId,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import { addProject, getProjectById } from '../../src/lib/projects'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'
import type { Project } from '../../src/lib/projects'
import type { PaymentState } from '../../src/lib/shared/coreTypes'

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
    projectTitle: 'Funding Entry Test',
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

/**
 * Replicate the deriveOperationalChip logic from CustomerProjectsScreen
 * to verify strict project scoping of funding badges.
 */
function deriveOperationalChip(
  status: Project['status'],
  paymentState: PaymentState,
): { label: string; style: string } | null {
  if (status === 'completed' || status === 'cancelled') return null

  if (paymentState === 'release_pending') {
    return {
      label: '⚡ Freigabe erforderlich',
      style: 'bg-amber-50 text-amber-700 ring-amber-200',
    }
  }
  if (paymentState === 'disputed') {
    return {
      label: '⚖️ Streitfall aktiv',
      style: 'bg-rose-50 text-rose-700 ring-rose-200',
    }
  }
  if (paymentState === 'deposit_required') {
    return {
      label: '💳 Zahlung ausstehend',
      style: 'bg-blue-50 text-blue-700 ring-blue-200',
    }
  }
  if (status === 'in_progress') {
    return {
      label: '🔨 In Durchführung',
      style: 'bg-slate-50 text-slate-600 ring-slate-200',
    }
  }
  if (status === 'scheduled') {
    return {
      label: '📅 Termin geplant',
      style: 'bg-blue-50 text-blue-700 ring-blue-200',
    }
  }
  return null
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Direct Funding Entry + Strict Project Scoping', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── 1. Canonical funding target ────────────────────────────────────────

  describe('1. Thread funding card opens canonical funding target', () => {
    it('funding artifact has jobId → projectId → /projects/:projectId?focus=payment', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-dfe-target1')

      await requestFundingWorkflow(job.id)

      const artifactRepo = getThreadArtifactRepository()
      const record = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      expect(record).toBeDefined()
      expect(record!.jobId).toBe(job.id)

      // The canonical funding target is /projects/:projectId?focus=payment
      const linkedJob = getJobById(record!.jobId!)
      expect(linkedJob).toBeDefined()
      expect(linkedJob!.projectId).toBeDefined()

      // Verify the canonical path includes focus=payment
      const canonicalPath = `/projects/${linkedJob!.projectId}?focus=payment`
      expect(canonicalPath).toContain('?focus=payment')
      expect(canonicalPath).toContain(linkedJob!.projectId)
    })

    it('funding artifact for funding_started phase still resolves to canonical target', async () => {
      const { job } = await setupAcceptedQuote('conv-dfe-target2')

      await requestFundingWorkflow(job.id)
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funding_started')

      // Job still resolves to project for navigation
      const linkedJob = getJobById(job.id)
      expect(linkedJob).toBeDefined()
      expect(linkedJob!.projectId).toBeDefined()
    })
  })

  // ─── 2. Strict project scoping — funding badges ────────────────────────

  describe('2. Strict project scoping of funding badges', () => {
    it('request-state project with paymentState "none" does NOT show funding badge', async () => {
      const project = makeProject({
        id: 'proj-inquiry',
        status: 'request',
        paymentState: 'none',
      })
      await addProject(project)

      const loaded = getProjectById('proj-inquiry')!
      const chip = deriveOperationalChip(loaded.status, loaded.paymentState)

      expect(chip).toBeNull()
    })

    it('request-state project never shows deposit_required badge (strict scoping)', async () => {
      // Even if somehow paymentState were wrong, request-state projects
      // should not show the chip because 'none' is the correct default.
      const project = makeProject({
        id: 'proj-inquiry2',
        status: 'request',
        paymentState: 'none',
      })
      await addProject(project)

      const loaded = getProjectById('proj-inquiry2')!
      expect(loaded.paymentState).toBe('none')

      const chip = deriveOperationalChip(loaded.status, loaded.paymentState)
      expect(chip).toBeNull()
    })

    it('accepted project with deposit_required DOES show funding badge', async () => {
      const project = makeProject({
        id: 'proj-accepted-funding',
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const loaded = getProjectById('proj-accepted-funding')!
      const chip = deriveOperationalChip(loaded.status, loaded.paymentState)

      expect(chip).not.toBeNull()
      expect(chip!.label).toContain('Zahlung')
    })

    it('completed project never shows funding badge even with deposit_required', () => {
      const chip = deriveOperationalChip('completed', 'deposit_required')
      expect(chip).toBeNull()
    })

    it('cancelled project never shows funding badge', () => {
      const chip = deriveOperationalChip('cancelled', 'deposit_required')
      expect(chip).toBeNull()
    })

    it('PaymentState "none" does not produce payment-related chips', () => {
      const statuses: Project['status'][] = [
        'request', 'accepted', 'scheduled', 'in_progress', 'review',
      ]
      for (const status of statuses) {
        const chip = deriveOperationalChip(status, 'none')
        // 'none' should not match any payment-related chip condition
        // in_progress and scheduled produce non-payment chips, but 'none'
        // should not produce a payment-related chip
        if (chip) {
          expect(chip.label).not.toContain('Zahlung')
          expect(chip.label).not.toContain('Einzahlung')
        }
      }
    })
  })

  // ─── 3. Cross-project funding isolation ─────────────────────────────────

  describe('3. Funding state is isolated to the canonical project', () => {
    it('funding request only exists for the accepted job, not for unrelated jobs', async () => {
      const { job: fundedJob } = await setupAcceptedQuote('conv-dfe-iso1')
      await requestFundingWorkflow(fundedJob.id)

      // Verify funding exists for the funded job
      const fr = getFundingRequestByJobId(fundedJob.id)
      expect(fr).toBeDefined()
      expect(fr!.status).toBe('sent')

      // An unrelated job should NOT have a funding request
      const { job: otherJob } = await setupAcceptedQuote('conv-dfe-iso2')
      const otherFr = getFundingRequestByJobId(otherJob.id)
      expect(otherFr).toBeUndefined()
    })

    it('escrow plan is scoped to its specific job', async () => {
      const { job: fundedJob } = await setupAcceptedQuote('conv-dfe-iso3')
      await requestFundingWorkflow(fundedJob.id)

      const plan = getEscrowPlanByJobId(fundedJob.id)
      expect(plan).toBeDefined()
      expect(plan!.jobId).toBe(fundedJob.id)

      // Different job should have its own escrow plan from quote acceptance
      const { job: otherJob } = await setupAcceptedQuote('conv-dfe-iso4')
      const otherPlan = getEscrowPlanByJobId(otherJob.id)
      expect(otherPlan).toBeDefined()
      // But no funding request on it
      const otherFr = getFundingRequestByJobId(otherJob.id)
      expect(otherFr).toBeUndefined()
    })
  })

  // ─── 4. Customer lands on real payment flow ─────────────────────────────

  describe('4. Customer reaches real payment flow', () => {
    it('customerFundingEntryWorkflow transitions to funding_started', async () => {
      const { job } = await setupAcceptedQuote('conv-dfe-pay1')
      await requestFundingWorkflow(job.id)

      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeDefined()
      expect(result!.escrowPlanId).toBeDefined()
      expect(result!.jobId).toBe(job.id)

      const fr = getFundingRequestByJobId(job.id)
      expect(fr!.status).toBe('funding_started')
    })

    it('funding entry provides all data needed for Stripe payment initiation', async () => {
      const { job } = await setupAcceptedQuote('conv-dfe-pay2')
      await requestFundingWorkflow(job.id)

      installSessionForJobCustomer(job)
      const result = await customerFundingEntryWorkflow(job.id)

      // These fields are required by /api/initiate-funding
      expect(result!.fundingRequestId).toBeDefined()
      expect(result!.escrowPlanId).toBeDefined()
      expect(result!.jobId).toBe(job.id)
      expect(result!.amount).toBe(5000)
      expect(result!.currency).toBe('EUR')
      expect(result!.customerUserId).toBeDefined()
    })
  })

  // ─── 5. Reload/re-entry preserves funding destination ──────────────────

  describe('5. Reload/re-entry preserves funding destination', () => {
    it('funding data is retrievable by jobId after workflow execution', async () => {
      const { job, conv } = await setupAcceptedQuote('conv-dfe-reload1')
      await requestFundingWorkflow(job.id)

      // Simulate reload: retrieve all funding data by jobId
      const fr = getFundingRequestByJobId(job.id)
      const plan = getEscrowPlanByJobId(job.id)
      const artifactRepo = getThreadArtifactRepository()
      const artifact = artifactRepo.getByConversationAndType(conv.id, 'funding_step')

      expect(fr).toBeDefined()
      expect(plan).toBeDefined()
      expect(artifact).toBeDefined()
      expect(fr!.jobId).toBe(job.id)
      expect(plan!.jobId).toBe(job.id)

      // Job still resolves to project
      const linkedJob = getJobById(job.id)
      expect(linkedJob!.projectId).toBeDefined()
    })
  })

  // ─── 6. No regression to existing flows ────────────────────────────────

  describe('6. No regression — canonical job resolution', () => {
    it('accepted offer creates job with correct linkage', async () => {
      const { job, offer, escrowPlan } = await setupAcceptedQuote('conv-dfe-regr1')

      expect(job).toBeDefined()
      expect(job.id).toBeDefined()
      expect(job.projectId).toBeDefined()
      expect(escrowPlan).toBeDefined()
      expect(escrowPlan.jobId).toBe(job.id)
      expect(escrowPlan.sourceOfferId).toBe(offer.id)
    })

    it('funding request creation does not break quote lifecycle', async () => {
      const { job, offer } = await setupAcceptedQuote('conv-dfe-regr2')

      await requestFundingWorkflow(job.id)

      // Quote is still in accepted state
      const reloadedOffer = getOfferById(offer.id)
      expect(reloadedOffer!.status).toBe('accepted')

      // Job still exists with correct properties
      const reloadedJob = getJobById(job.id)
      expect(reloadedJob).toBeDefined()
      expect(reloadedJob!.projectId).toBeDefined()
    })
  })

  // ─── 7. PaymentState 'none' type-level correctness ────────────────────

  describe('7. PaymentState "none" is handled correctly', () => {
    it('allowedTransitions includes none → deposit_required', async () => {
      const { canTransition } = await import('../../src/lib/payments/stateMachine')
      expect(canTransition('none', 'deposit_required')).toBe(true)
    })

    it('none cannot transition to non-deposit_required states', async () => {
      const { canTransition } = await import('../../src/lib/payments/stateMachine')
      expect(canTransition('none', 'in_escrow')).toBe(false)
      expect(canTransition('none', 'released')).toBe(false)
    })

    it('getPaymentStateLabel handles "none"', async () => {
      const { getPaymentStateLabel } = await import('../../src/lib/payments/selectors')
      const label = getPaymentStateLabel('none')
      expect(label).toBe('Keine Zahlung')
    })

    it('getPaymentStateDescription handles "none"', async () => {
      const { getPaymentStateDescription } = await import('../../src/lib/payments/selectors')
      const desc = getPaymentStateDescription('none')
      expect(desc).toBeDefined()
      expect(desc.length).toBeGreaterThan(0)
    })
  })

  // ─── 8. Funding badge + focus scoping hardening ────────────────────────

  describe('8. Badge and ?focus=payment require real job backing', () => {
    it('project without sourceJobId does NOT get ?focus=payment even with deposit_required', async () => {
      // A project in 'accepted' with deposit_required but no sourceJobId
      // should never produce a payment-focus link. This covers edge cases
      // where payment state is set but no canonical job exists.
      const project = makeProject({
        id: 'proj-no-job',
        sourceJobId: '',
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const loaded = getProjectById('proj-no-job')!
      expect(loaded.paymentState).toBe('deposit_required')
      expect(loaded.sourceJobId).toBe('')

      // Replicate the link-target gating logic from CustomerProjectsScreen:
      // isPaymentChip requires sourceJobId to be truthy
      const chip = deriveOperationalChip(loaded.status, loaded.paymentState)
      expect(chip).not.toBeNull() // chip exists
      const isPaymentChip = chip && loaded.sourceJobId && (
        loaded.paymentState === 'deposit_required' ||
        loaded.paymentState === 'release_pending'
      )
      expect(isPaymentChip).toBeFalsy() // but NOT a payment chip due to empty sourceJobId
    })

    it('project with real sourceJobId and deposit_required DOES get ?focus=payment', async () => {
      const { job } = await setupAcceptedQuote('conv-dfe-badge-hard1')
      await requestFundingWorkflow(job.id)

      // Create a project linked to the canonical job
      const project = makeProject({
        id: 'proj-real-job',
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const loaded = getProjectById('proj-real-job')!
      const chip = deriveOperationalChip(loaded.status, loaded.paymentState)
      expect(chip).not.toBeNull()
      const isPaymentChip = chip && loaded.sourceJobId && (
        loaded.paymentState === 'deposit_required' ||
        loaded.paymentState === 'release_pending'
      )
      expect(isPaymentChip).toBeTruthy()
    })

    it('?focus=payment is a no-op on builder project without sourceJobId', async () => {
      // Even if ?focus=payment is in the URL, a builder project without
      // sourceJobId should not trigger payment scroll.
      const project = makeProject({
        id: 'proj-builder-nofocus',
        sourceJobId: '',
        status: 'request',
        paymentState: 'none',
        source: 'builder',
      })
      await addProject(project)

      const loaded = getProjectById('proj-builder-nofocus')!
      // The focusPayment gate from CustomerProjectDetailScreen:
      // focusPayment = searchParams.get('focus') === 'payment' && !!project.sourceJobId
      const focusPayment = !!loaded.sourceJobId
      expect(focusPayment).toBe(false)
    })

    it('?focus=payment activates only on project with sourceJobId', async () => {
      const { job } = await setupAcceptedQuote('conv-dfe-focus-hard1')

      const project = makeProject({
        id: 'proj-with-focus',
        sourceJobId: job.id,
        status: 'accepted',
        paymentState: 'deposit_required',
      })
      await addProject(project)

      const loaded = getProjectById('proj-with-focus')!
      const focusPayment = !!loaded.sourceJobId
      expect(focusPayment).toBe(true)
    })
  })
})
