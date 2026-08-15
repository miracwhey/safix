/**
 * Block 7.2.1b — admin-confirm-gate tests.
 *
 * Verifies the worker-mark / admin-confirm split:
 *  - `markWorkCompleteWorkflow` only stamps `workMarkedCompleteAt`
 *    and emits the owner-push when called by a worker. No status
 *    transition, no acceptance, no tranche eligibility.
 *  - `confirmJobCompletionWorkflow` is the new home for all those
 *    side-effects.
 *  - `rejectWorkerCompletionWorkflow` clears the marked stamp without
 *    touching status.
 *  - The solo-owner shortcut keeps the legacy single-step UX.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  confirmJobCompletionWorkflow,
  markWorkCompleteWorkflow,
  rejectWorkerCompletionWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addJob, getJobById } from '../../src/lib/jobs'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  installMockSession,
  mockOwnerSession,
  mockWorkerSession,
} from '../helpers/mockSession'
import {
  ensureEscrowPlan,
  confirmFunding,
  getEscrowPlanByJobId,
  getEscrowTranches,
} from '../../src/lib/payments/escrow'
import { getAcceptanceByJobId } from '../../src/lib/acceptance'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'
import { InMemoryTeamMemberRepository, setTeamMemberRepository } from '../../src/lib/team/repository'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

const OWNER_ID = 'owner-confirm-gate'
const WORKER_ID = 'worker-confirm-gate'
const PROVIDER_ID = 'prov-confirm-gate'
const CUSTOMER_ID = 'customer-confirm-gate'

function seedTeamMembers(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? `job-${Math.random().toString(16).slice(2)}`
  return {
    id,
    projectId: 'proj-confirm-gate',
    title: 'Confirm gate job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: '',
    status: 'in_progress',
    amount: '1.000 €',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: OWNER_ID,
    customerUserId: CUSTOMER_ID,
    providerId: PROVIDER_ID,
    workCompletedAt: undefined,
    workMarkedCompleteAt: undefined,
    workConfirmedCompleteAt: undefined,
    paymentReleasedAt: undefined,
    ...overrides,
  } as Job
}

async function seedFundedPlan(jobId: string): Promise<void> {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-${jobId}`,
    jobId,
    customerUserId: CUSTOMER_ID,
    providerId: PROVIDER_ID,
    totalAmount: 4000,
  })
  await confirmFunding(plan.id)
}

beforeEach(() => {
  setupCleanRepositories()
  seedTeamMembers([
    { id: 'tm-worker', userId: WORKER_ID, providerId: PROVIDER_ID, name: 'Worker', role: 'worker' },
  ])
})

// ── Worker-mark phase ─────────────────────────────────────────────────────

describe('markWorkCompleteWorkflow — worker path', () => {
  it('worker_mark_only_sets_marked_stamp_no_confirmed', async () => {
    const job = makeJob({ id: 'job-w-1', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))

    const result = await markWorkCompleteWorkflow(job.id)

    expect(result?.workMarkedCompleteAt).toBeGreaterThan(0)
    expect(result?.workConfirmedCompleteAt).toBeUndefined()
    expect(result?.workCompletedAt).toBeUndefined()
  })

  it('worker_mark_does_not_open_acceptance', async () => {
    const job = makeJob({ id: 'job-w-2', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))

    await markWorkCompleteWorkflow(job.id)

    expect(getAcceptanceByJobId(job.id)).toBeUndefined()
  })

  it('worker_mark_does_not_change_job_status', async () => {
    const job = makeJob({ id: 'job-w-3', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))

    const result = await markWorkCompleteWorkflow(job.id)

    expect(result?.status).toBe('in_progress')
  })

  it('worker_mark_does_not_record_tranche_eligibility', async () => {
    const job = makeJob({ id: 'job-w-4', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    await seedFundedPlan(job.id)
    installMockSession(mockWorkerSession(WORKER_ID))

    await markWorkCompleteWorkflow(job.id)

    const plan = getEscrowPlanByJobId(job.id)!
    const finalTranche = getEscrowTranches(plan.id).find((t) => t.kind === 'final_release')!
    // Tranche must not advance — worker mark alone is not enough.
    expect(finalTranche.status).not.toBe('eligible_for_release')
  })

  it('worker_mark_emits_owner_push', async () => {
    const job = makeJob({ id: 'job-w-5', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))

    await markWorkCompleteWorkflow(job.id)

    const signals = getTimelineSignalsForJob(job.id)
    expect(signals.some((s) => s.type === 'worker_marked_complete')).toBe(true)
  })
})

// ── Admin-confirm phase ───────────────────────────────────────────────────

describe('confirmJobCompletionWorkflow — owner path', () => {
  async function seedMarkedJob(id: string): Promise<Job> {
    const job = makeJob({ id, assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    await seedFundedPlan(job.id)
    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)
    return getJobById(job.id)!
  }

  it('admin_confirm_opens_acceptance_with_72h_expires', async () => {
    const job = await seedMarkedJob('job-c-1')
    installMockSession(mockOwnerSession(OWNER_ID))

    await confirmJobCompletionWorkflow(job.id)

    const acceptance = getAcceptanceByJobId(job.id)
    expect(acceptance).toBeDefined()
    expect(acceptance!.status).toBe('pending')
    const ttl = acceptance!.expiresAt - acceptance!.createdAt
    expect(ttl).toBe(72 * 60 * 60 * 1000)
  })

  it('admin_confirm_sets_confirmed_and_alias_workCompletedAt', async () => {
    const job = await seedMarkedJob('job-c-2')
    installMockSession(mockOwnerSession(OWNER_ID))

    const result = await confirmJobCompletionWorkflow(job.id)

    expect(result?.workConfirmedCompleteAt).toBeGreaterThan(0)
    // Legacy alias must be in lock-step for consumers that still read it.
    expect(result?.workCompletedAt).toBe(result?.workConfirmedCompleteAt)
  })

  it('admin_confirm_records_tranche_eligibility', async () => {
    const job = await seedMarkedJob('job-c-3')
    installMockSession(mockOwnerSession(OWNER_ID))

    await confirmJobCompletionWorkflow(job.id)

    const plan = getEscrowPlanByJobId(job.id)!
    const finalTranche = getEscrowTranches(plan.id).find((t) => t.kind === 'final_release')!
    expect(finalTranche.status).toBe('eligible_for_release')
  })

  it('admin_confirm_transitions_to_waiting_payment', async () => {
    const job = await seedMarkedJob('job-c-4')
    installMockSession(mockOwnerSession(OWNER_ID))

    const result = await confirmJobCompletionWorkflow(job.id)

    expect(result?.status).toBe('waiting_payment')
  })

  it('admin_confirm_idempotent', async () => {
    const job = await seedMarkedJob('job-c-5')
    installMockSession(mockOwnerSession(OWNER_ID))

    const first = await confirmJobCompletionWorkflow(job.id)
    const stamp = first?.workConfirmedCompleteAt
    const second = await confirmJobCompletionWorkflow(job.id)

    expect(second?.workConfirmedCompleteAt).toBe(stamp)
  })
})

// ── Reject phase ──────────────────────────────────────────────────────────

describe('rejectWorkerCompletionWorkflow — owner path', () => {
  it('admin_reject_clears_marked_stamp_no_status_change', async () => {
    const job = makeJob({ id: 'job-r-1', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    installMockSession(mockOwnerSession(OWNER_ID))
    const result = await rejectWorkerCompletionWorkflow(job.id)

    expect(result?.workMarkedCompleteAt).toBeUndefined()
    expect(result?.workConfirmedCompleteAt).toBeUndefined()
    expect(result?.status).toBe('in_progress')
  })

  it('admin_reject_emits_worker_push', async () => {
    const job = makeJob({ id: 'job-r-2', assignedMemberIds: ['tm-worker'] })
    await addJob(job)
    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    installMockSession(mockOwnerSession(OWNER_ID))
    await rejectWorkerCompletionWorkflow(job.id)

    const signals = getTimelineSignalsForJob(job.id)
    expect(signals.some((s) => s.type === 'admin_rejected_completion')).toBe(true)
  })
})

// ── Solo-owner shortcut ───────────────────────────────────────────────────

describe('markWorkCompleteWorkflow — solo-owner shortcut', () => {
  it('solo_owner_mark_complete_delegates_to_confirm', async () => {
    const job = makeJob({ id: 'job-so-1' })
    await addJob(job)
    await seedFundedPlan(job.id)
    installMockSession(mockOwnerSession(OWNER_ID))

    const result = await markWorkCompleteWorkflow(job.id)

    expect(result?.workMarkedCompleteAt).toBeGreaterThan(0)
    expect(result?.workConfirmedCompleteAt).toBeGreaterThan(0)
    expect(result?.workCompletedAt).toBeGreaterThan(0)
    expect(result?.status).toBe('waiting_payment')
  })

  it('solo_owner_acceptance_opens_immediately', async () => {
    const job = makeJob({ id: 'job-so-2' })
    await addJob(job)
    await seedFundedPlan(job.id)
    installMockSession(mockOwnerSession(OWNER_ID))

    await markWorkCompleteWorkflow(job.id)

    const acceptance = getAcceptanceByJobId(job.id)
    expect(acceptance).toBeDefined()
    expect(acceptance!.status).toBe('pending')
  })
})
