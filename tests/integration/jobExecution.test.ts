/**
 * Integration tests: Flows C & D — Job Execution Lifecycle
 *
 * Validates the full craftsman-side job execution path:
 * - proposal preparation and submission → customer acceptance
 * - job start, execution, work completion
 * - customer payment release → job completion
 *
 * Also covers selector logic for:
 * - ExecutionStatus derivation from job status
 * - Assignment integrity warnings (gaps only when in_progress/scheduled)
 * - ProposalReadiness derivation through the proposal lifecycle
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { installSessionForJobOwner, installSessionForJobCustomer } from '../helpers/mockSession'
import {
  startJobWorkflow,
  finishJobWorkflow,
  markWorkCompleteWorkflow,
  customerReleasePaymentWorkflow,
  submitProposalWorkflow,
  acceptProposalWorkflow,
  prepareProposalDraftWorkflow,
  initializeExecutionWorkflow,
  addJobNoteWorkflow,
  toggleAssignedMemberWorkflow,
} from '../../src/lib/workflow/jobWorkflow'

import { getJobById } from '../../src/lib/jobs'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import {
  deriveExecutionStatus,
  deriveAssignmentIntegrityWarning,
} from '../../src/lib/jobs/executionSelectors'
import { deriveProposalReadiness } from '../../src/lib/jobs/proposalReadinessSelectors'
import { deriveReleaseReadiness } from '../../src/lib/jobs/releaseReadinessSelectors'

import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedJob(id: string, overrides: Partial<Job> = {}): Job {
  const job: Job = {
    id,
    projectId: `project-${id}`,
    title: `Test Job ${id}`,
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: '1.000 €',
    description: '',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'cust-jobexec',
    craftsmanUserId: 'craft-jobexec',
    ...overrides,
  }
  // Block 7.2.1b: tests that seed `workCompletedAt` directly are simulating
  // a job that has already passed admin-confirm; mirror the new stamps so
  // `customerReleasePaymentWorkflow` sees a confirmed completion.
  if (job.workCompletedAt && !job.workConfirmedCompleteAt) {
    job.workMarkedCompleteAt = job.workMarkedCompleteAt ?? job.workCompletedAt
    job.workConfirmedCompleteAt = job.workCompletedAt
  }
  getJobRepository().add(job)
  return job
}

function seedPayment(jobId: string, state: Payment['state']): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  getPaymentRepository().add(payment)
  return payment
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Job Execution Lifecycle (Flows C & D)', () => {
  beforeEach(() => {
    setupCleanRepositories()
    // Default to the test owner so markWorkComplete + start/proposal flows pass
    // RBAC. Customer-side tests (customerReleasePaymentWorkflow) install a
    // matching customer session inline.
    installSessionForJobOwner({ craftsmanUserId: 'craft-jobexec' })
  })

  // ---- startJobWorkflow ---------------------------------------------------

  describe('startJobWorkflow', () => {
    it('transitions a new job to in_progress', async () => {
      seedJob('j-start-1', { status: 'new' })
      // Payment must be in_escrow for startJobWorkflow to advance it to work_in_progress
      seedPayment('j-start-1', 'in_escrow')

      const result = await startJobWorkflow('j-start-1')

      expect(result?.status).toBe('in_progress')
    })

    it('transitions a scheduled job to in_progress', async () => {
      seedJob('j-start-2', { status: 'scheduled' })
      seedPayment('j-start-2', 'in_escrow')

      const result = await startJobWorkflow('j-start-2')

      expect(result?.status).toBe('in_progress')
    })

    it('is idempotent when already in_progress', async () => {
      seedJob('j-start-3', { status: 'in_progress' })
      seedPayment('j-start-3', 'work_in_progress')

      const result = await startJobWorkflow('j-start-3')

      expect(result?.status).toBe('in_progress')
    })

    it('does not restart a job in waiting_payment status', async () => {
      seedJob('j-start-4', { status: 'waiting_payment' })
      seedPayment('j-start-4', 'release_pending')

      const result = await startJobWorkflow('j-start-4')

      // Guard must prevent regression: waiting_payment → in_progress bypass
      expect(result?.status).toBe('waiting_payment')
    })

    it('advances payment to work_in_progress when in_escrow', async () => {
      seedJob('j-start-5', { status: 'new' })
      seedPayment('j-start-5', 'in_escrow')

      await startJobWorkflow('j-start-5')

      const payment = getPaymentRepository().getByJobId('j-start-5')
      expect(payment?.state).toBe('work_in_progress')
    })

    it('returns undefined for a non-existent job', async () => {
      const result = await startJobWorkflow('nonexistent')
      expect(result).toBeUndefined()
    })
  })

  // ---- finishJobWorkflow --------------------------------------------------

  describe('finishJobWorkflow', () => {
    it('transitions an in_progress job to waiting_payment', async () => {
      seedJob('j-fin-1', { status: 'in_progress' })
      seedPayment('j-fin-1', 'work_in_progress')

      const result = await finishJobWorkflow('j-fin-1')

      expect(result?.status).toBe('waiting_payment')
    })

    it('is idempotent when already waiting_payment', async () => {
      seedJob('j-fin-2', { status: 'waiting_payment' })
      seedPayment('j-fin-2', 'release_pending')

      const result = await finishJobWorkflow('j-fin-2')

      expect(result?.status).toBe('waiting_payment')
    })

    it('does not transition a new job directly to waiting_payment', async () => {
      seedJob('j-fin-3', { status: 'new' })

      const result = await finishJobWorkflow('j-fin-3')

      // Guard prevents skipping execution phase
      expect(result?.status).toBe('new')
    })

    it('advances payment to release_pending when work_in_progress', async () => {
      seedJob('j-fin-4', { status: 'in_progress' })
      seedPayment('j-fin-4', 'work_in_progress')

      await finishJobWorkflow('j-fin-4')

      const payment = getPaymentRepository().getByJobId('j-fin-4')
      expect(payment?.state).toBe('release_pending')
    })
  })

  // ---- markWorkCompleteWorkflow -------------------------------------------

  describe('markWorkCompleteWorkflow', () => {
    it('stamps workCompletedAt on an in_progress job', async () => {
      seedJob('j-wc-1', { status: 'in_progress' })
      seedPayment('j-wc-1', 'work_in_progress')

      const result = await markWorkCompleteWorkflow('j-wc-1')

      expect(result?.workCompletedAt).toBeDefined()
    })

    it('transitions the job to waiting_payment after marking complete', async () => {
      seedJob('j-wc-2', { status: 'in_progress' })
      seedPayment('j-wc-2', 'work_in_progress')

      await markWorkCompleteWorkflow('j-wc-2')

      const job = getJobById('j-wc-2')
      expect(job?.status).toBe('waiting_payment')
    })

    it('is idempotent when workCompletedAt is already set', async () => {
      const ts = Date.now() - 1000
      seedJob('j-wc-3', {
        status: 'in_progress',
        workCompletedAt: ts,
      })

      const result = await markWorkCompleteWorkflow('j-wc-3')

      expect(result?.workCompletedAt).toBe(ts)
    })

    it('does not mark a new job as complete (guard: in_progress only)', async () => {
      seedJob('j-wc-4', { status: 'new' })

      const result = await markWorkCompleteWorkflow('j-wc-4')

      expect(result?.workCompletedAt).toBeUndefined()
      expect(result?.status).toBe('new')
    })
  })

  // ---- Proposal lifecycle -------------------------------------------------

  describe('Proposal lifecycle: prepare → submit → accept', () => {
    it('prepareProposalDraftWorkflow saves amount and description to job', async () => {
      seedJob('j-prop-1', { status: 'new' })

      const result = await prepareProposalDraftWorkflow('j-prop-1', {
        amount: '2.000 €',
        description: 'Badezimmer komplett sanieren',
        proposalTimingNote: 'Innerhalb 2 Wochen',
      })

      expect(result?.amount).toBe('2.000 €')
      expect(result?.description).toBe('Badezimmer komplett sanieren')
    })

    it('submitProposalWorkflow stamps proposalSentAt', async () => {
      seedJob('j-prop-2', {
        status: 'new',
        amount: '1.500 €',
        description: 'Küchenrenovierung',
      })

      const result = await submitProposalWorkflow('j-prop-2')

      expect(result?.proposalSentAt).toBeDefined()
    })

    it('submitProposalWorkflow is blocked when job is not in "new" status', async () => {
      seedJob('j-prop-3', { status: 'in_progress' })

      const result = await submitProposalWorkflow('j-prop-3')

      expect(result?.proposalSentAt).toBeUndefined()
    })

    it('acceptProposalWorkflow stamps proposalAcceptedAt', async () => {
      seedJob('j-prop-4', {
        status: 'new',
        amount: '1.500 €',
        description: 'Pflasterarbeiten',
        proposalSentAt: Date.now() - 3600_000,
      })

      const result = await acceptProposalWorkflow('j-prop-4')

      expect(result?.proposalAcceptedAt).toBeDefined()
    })

    it('acceptProposalWorkflow is blocked when proposalSentAt is not set', async () => {
      seedJob('j-prop-5', { status: 'new' })

      const result = await acceptProposalWorkflow('j-prop-5')

      expect(result?.proposalAcceptedAt).toBeUndefined()
    })

    it('acceptProposalWorkflow is idempotent', async () => {
      const ts = Date.now() - 1000
      seedJob('j-prop-6', {
        status: 'new',
        proposalSentAt: Date.now() - 7200_000,
        proposalAcceptedAt: ts,
      })

      const result = await acceptProposalWorkflow('j-prop-6')

      expect(result?.proposalAcceptedAt).toBe(ts)
    })

    it('full proposal sequence: prepare → submit → accept all succeed', async () => {
      seedJob('j-prop-7', { status: 'new' })

      await prepareProposalDraftWorkflow('j-prop-7', {
        amount: '3.000 €',
        description: 'Dach sanieren',
      })
      await submitProposalWorkflow('j-prop-7')
      await acceptProposalWorkflow('j-prop-7')

      const job = getJobById('j-prop-7')
      expect(job?.amount).toBe('3.000 €')
      expect(job?.proposalSentAt).toBeDefined()
      expect(job?.proposalAcceptedAt).toBeDefined()
    })
  })

  // ---- initializeExecutionWorkflow ----------------------------------------

  describe('initializeExecutionWorkflow', () => {
    it('succeeds when proposalAcceptedAt is set', async () => {
      seedJob('j-exec-1', {
        status: 'new',
        proposalSentAt: Date.now() - 7200_000,
        proposalAcceptedAt: Date.now() - 3600_000,
      })

      const result = await initializeExecutionWorkflow('j-exec-1')

      expect(result).toBeDefined()
    })

    it('is blocked when proposalAcceptedAt is not set', async () => {
      seedJob('j-exec-2', {
        status: 'new',
        proposalSentAt: Date.now() - 3600_000,
      })

      const result = await initializeExecutionWorkflow('j-exec-2')

      // Returns job unchanged (no accepted proposal yet)
      expect(result?.proposalAcceptedAt).toBeUndefined()
    })
  })

  // ---- customerReleasePaymentWorkflow -------------------------------------

  describe('customerReleasePaymentWorkflow', () => {
    it('releases payment for a job with workCompletedAt in waiting_payment', async () => {
      seedJob('j-rel-1', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-rel-1', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-rel-1')

      const job = getJobById('j-rel-1')
      expect(job?.status).toBe('completed')
    })

    it('stamps paymentReleasedAt on the job', async () => {
      seedJob('j-rel-2', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 3600_000,
      })
      seedPayment('j-rel-2', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-rel-2')

      const job = getJobById('j-rel-2')
      expect(job?.paymentReleasedAt).toBeDefined()
    })

    it('is blocked when workCompletedAt is not set', async () => {
      seedJob('j-rel-3', { status: 'waiting_payment' })
      seedPayment('j-rel-3', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-rel-3')

      // Guard: job should remain in waiting_payment, not complete
      const job = getJobById('j-rel-3')
      expect(job?.status).toBe('waiting_payment')
    })

    it('is blocked when job is not in waiting_payment', async () => {
      seedJob('j-rel-4', {
        status: 'in_progress',
        workCompletedAt: Date.now() - 1000,
      })
      seedPayment('j-rel-4', 'release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-rel-4')

      // Guard: job should remain in_progress, not complete
      const job = getJobById('j-rel-4')
      expect(job?.status).toBe('in_progress')
    })

    it('is idempotent when paymentReleasedAt is already set', async () => {
      const ts = Date.now() - 5000
      seedJob('j-rel-5', {
        status: 'waiting_payment',
        workCompletedAt: Date.now() - 7200_000,
        paymentReleasedAt: ts,
      })
      seedPayment('j-rel-5', 'released')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      const result = await customerReleasePaymentWorkflow('j-rel-5')

      expect(result?.paymentReleasedAt).toBe(ts)
    })
  })

  // ---- Full lifecycle: new → in_progress → completed ----------------------

  describe('Full job lifecycle: new → in_progress → waiting_payment → completed', () => {
    it('completes the canonical job lifecycle end-to-end', async () => {
      seedJob('j-full-1', { status: 'new' })
      seedPayment('j-full-1', 'in_escrow')

      // 1. Start job
      await startJobWorkflow('j-full-1')
      expect(getJobById('j-full-1')?.status).toBe('in_progress')

      // 2. Mark work complete → transitions to waiting_payment
      await markWorkCompleteWorkflow('j-full-1')
      expect(getJobById('j-full-1')?.status).toBe('waiting_payment')
      expect(getJobById('j-full-1')?.workCompletedAt).toBeDefined()

      // 3. Customer releases payment → job completed
      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-full-1')
      const finalJob = getJobById('j-full-1')
      expect(finalJob?.status).toBe('completed')
      expect(finalJob?.paymentReleasedAt).toBeDefined()
    })

    it('payment state progresses correctly through the full lifecycle', async () => {
      seedJob('j-full-2', { status: 'new' })
      seedPayment('j-full-2', 'in_escrow')

      await startJobWorkflow('j-full-2')
      const afterStart = getPaymentRepository().getByJobId('j-full-2')
      expect(afterStart?.state).toBe('work_in_progress')

      await markWorkCompleteWorkflow('j-full-2')
      const afterComplete = getPaymentRepository().getByJobId('j-full-2')
      expect(afterComplete?.state).toBe('release_pending')

      installSessionForJobCustomer({ customerUserId: 'cust-jobexec' })
      await customerReleasePaymentWorkflow('j-full-2')
      const afterRelease = getPaymentRepository().getByJobId('j-full-2')
      expect(afterRelease?.state).toBe('released')
    })
  })

  // ---- ExecutionStatus selector -------------------------------------------

  describe('deriveExecutionStatus', () => {
    it('maps "new" status → "assigned"', () => {
      const job = seedJob('j-es-1', { status: 'new' })
      expect(deriveExecutionStatus(job)).toBe('assigned')
    })

    it('maps "scheduled" status → "scheduled"', () => {
      const job = seedJob('j-es-2', { status: 'scheduled' })
      expect(deriveExecutionStatus(job)).toBe('scheduled')
    })

    it('maps "in_progress" status → "in_progress"', () => {
      const job = seedJob('j-es-3', { status: 'in_progress' })
      expect(deriveExecutionStatus(job)).toBe('in_progress')
    })

    it('maps "waiting_payment" status → "awaiting_payment"', () => {
      const job = seedJob('j-es-4', { status: 'waiting_payment' })
      expect(deriveExecutionStatus(job)).toBe('awaiting_payment')
    })

    it('maps "completed" status → "completed"', () => {
      const job = seedJob('j-es-5', { status: 'completed' })
      expect(deriveExecutionStatus(job)).toBe('completed')
    })
  })

  // ---- Assignment integrity selectors -------------------------------------

  describe('deriveAssignmentIntegrityWarning', () => {
    it('reports no gap when all jobs are in "new" status without members', () => {
      const jobs = [
        seedJob('j-ai-1', { status: 'new', assignedMemberIds: [] }),
        seedJob('j-ai-2', { status: 'new', assignedMemberIds: [] }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      expect(warning.hasAnyGap).toBe(false)
    })

    it('reports a gap when an in_progress job has no assigned members', () => {
      const jobs = [
        seedJob('j-ai-3', { status: 'in_progress', assignedMemberIds: [] }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      expect(warning.hasActiveGap).toBe(true)
      expect(warning.inProgressUnassigned).toHaveLength(1)
    })

    it('reports a gap when a scheduled job has no assigned members', () => {
      const jobs = [
        seedJob('j-ai-4', { status: 'scheduled', assignedMemberIds: [] }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      expect(warning.hasAnyGap).toBe(true)
      expect(warning.scheduledUnassigned).toHaveLength(1)
    })

    it('reports no gap when in_progress job has an assigned member', () => {
      const jobs = [
        seedJob('j-ai-5', {
          status: 'in_progress',
          assignedMemberIds: ['member-1'],
        }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      expect(warning.hasAnyGap).toBe(false)
      expect(warning.hasActiveGap).toBe(false)
    })

    it('excludes completed jobs from gap analysis', () => {
      const jobs = [
        seedJob('j-ai-6', {
          status: 'completed',
          assignedMemberIds: [],
        }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      expect(warning.hasAnyGap).toBe(false)
    })

    it('counts gaps correctly with mixed job statuses', () => {
      const jobs = [
        seedJob('j-ai-7', { status: 'in_progress', assignedMemberIds: [] }),
        seedJob('j-ai-8', { status: 'scheduled', assignedMemberIds: [] }),
        seedJob('j-ai-9', { status: 'new', assignedMemberIds: [] }),
        seedJob('j-ai-10', {
          status: 'in_progress',
          assignedMemberIds: ['member-2'],
        }),
      ]

      const warning = deriveAssignmentIntegrityWarning(jobs)

      // j-ai-7 (in_progress unassigned) + j-ai-8 (scheduled unassigned) = 2 gaps
      expect(warning.gapCount).toBe(2)
      expect(warning.inProgressUnassigned).toHaveLength(1)
      expect(warning.scheduledUnassigned).toHaveLength(1)
    })
  })

  // ---- ProposalReadiness selector ----------------------------------------

  describe('deriveProposalReadiness', () => {
    it('returns "needs_clarification" for a new empty job', () => {
      const job = seedJob('j-pr-1', { status: 'new' })

      const vm = deriveProposalReadiness(job)

      expect(vm.readiness).toBe('needs_clarification')
    })

    it('returns "ready_for_proposal" when all prerequisites are met', () => {
      const job = seedJob('j-pr-2', {
        status: 'new',
        amount: '1.500 €',
        description: 'Küche sanieren',
        dateLabel: 'KW 15',
        intakeContext: {
          origin: 'inquiry_category',
          originLabel: 'Kategorieanfrage',
          requestDescription: 'Küche sanieren',
          requestLocation: 'Berlin',
          requestBudget: '1.500 €',
          requestDuration: '2 Wochen',
        },
      })

      const vm = deriveProposalReadiness(job)

      expect(vm.readiness).toBe('ready_for_proposal')
    })

    it('returns "proposal_sent" after submitProposalWorkflow', async () => {
      seedJob('j-pr-3', {
        status: 'new',
        amount: '2.000 €',
        description: 'Terrasse pflastern',
        intakeContext: {
          origin: 'inquiry_reel',
          originLabel: 'Explore-Reel',
          requestDescription: 'Terrasse pflastern',
          requestLocation: 'München',
        },
      })
      await submitProposalWorkflow('j-pr-3')

      const job = getJobById('j-pr-3')!
      installSessionForJobOwner(job)
      const vm = deriveProposalReadiness(job)

      expect(vm.readiness).toBe('proposal_sent')
      expect(vm.proposalSentLabel).not.toBeNull()
    })

    it('returns "proposal_accepted" after acceptProposalWorkflow', async () => {
      seedJob('j-pr-4', {
        status: 'new',
        amount: '2.500 €',
        description: 'Dachrinne reparieren',
        intakeContext: {
          origin: 'inquiry_profile',
          originLabel: 'Handwerkerprofil',
          requestDescription: 'Dachrinne reparieren',
          requestLocation: 'Köln',
        },
        proposalSentAt: Date.now() - 7200_000,
      })
      await acceptProposalWorkflow('j-pr-4')

      const job = getJobById('j-pr-4')!
      installSessionForJobOwner(job)
      const vm = deriveProposalReadiness(job)

      expect(vm.readiness).toBe('proposal_accepted')
      expect(vm.proposalAcceptedLabel).not.toBeNull()
    })
  })

  // ---- ReleaseReadiness selector ------------------------------------------

  describe('deriveReleaseReadiness', () => {
    it('returns null when job is in new status (no execution phase yet)', () => {
      const job = seedJob('j-rr-1', { status: 'new' })

      const vm = deriveReleaseReadiness(job)

      expect(vm).toBeNull()
    })

    it('returns execution_active phase when job is in_progress with escrow funded', () => {
      const job = seedJob('j-rr-2', { status: 'in_progress' })
      const payment = seedPayment('j-rr-2', 'work_in_progress')

      const vm = deriveReleaseReadiness(job, payment)

      expect(vm?.phase).toBe('execution_active')
      expect(vm?.canMarkComplete).toBe(true)
      expect(vm?.canReleasePayment).toBe(false)
    })

    it('returns work_completed phase after craftsman marks work done', () => {
      const ts = Date.now() - 1000
      const job = seedJob('j-rr-3', {
        status: 'waiting_payment',
        workCompletedAt: ts,
      })
      const payment = seedPayment('j-rr-3', 'release_pending')

      const vm = deriveReleaseReadiness(job, payment)

      expect(vm?.phase).toBe('work_completed')
      expect(vm?.canReleasePayment).toBe(true)
      expect(vm?.canMarkComplete).toBe(false)
    })

    it('blocks payment release when dispute is open', () => {
      const ts = Date.now() - 1000
      const job = seedJob('j-rr-4', {
        status: 'waiting_payment',
        workCompletedAt: ts,
        disputeStatus: 'open',
      })
      const payment = seedPayment('j-rr-4', 'disputed')

      const vm = deriveReleaseReadiness(job, payment)

      expect(vm?.phase).toBe('work_completed')
      expect(vm?.canReleasePayment).toBe(false)
    })

    it('returns payment_released phase after payment is released', () => {
      const now = Date.now()
      const job = seedJob('j-rr-5', {
        status: 'completed',
        workCompletedAt: now - 7200_000,
        paymentReleasedAt: now - 3600_000,
      })
      const payment = seedPayment('j-rr-5', 'released')

      const vm = deriveReleaseReadiness(job, payment)

      expect(vm?.phase).toBe('payment_released')
      expect(vm?.canMarkComplete).toBe(false)
      expect(vm?.canReleasePayment).toBe(false)
    })
  })

  // ---- addJobNoteWorkflow & toggleAssignedMemberWorkflow ------------------

  describe('addJobNoteWorkflow', () => {
    it('adds a note to the job', () => {
      seedJob('j-note-1', { status: 'in_progress' })

      addJobNoteWorkflow('j-note-1', 'Estrich getrocknet, bereit für Fliesen')

      const job = getJobById('j-note-1')
      expect(job?.notes).toContain('Estrich getrocknet, bereit für Fliesen')
    })
  })

  describe('toggleAssignedMemberWorkflow', () => {
    it('assigns a member to a job', () => {
      seedJob('j-tm-1', { status: 'new', assignedMemberIds: [] })

      toggleAssignedMemberWorkflow('j-tm-1', 'member-001')

      const job = getJobById('j-tm-1')
      expect(job?.assignedMemberIds).toContain('member-001')
    })

    it('removes a member when already assigned (toggle)', () => {
      seedJob('j-tm-2', {
        status: 'new',
        assignedMemberIds: ['member-002'],
      })

      toggleAssignedMemberWorkflow('j-tm-2', 'member-002')

      const job = getJobById('j-tm-2')
      expect(job?.assignedMemberIds).not.toContain('member-002')
    })
  })
})
