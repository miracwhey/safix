import { beforeEach, describe, expect, it } from 'vitest'

import {
  confirmFundingWorkflow,
  customerFundingEntryWorkflow,
  customerReleasePaymentWorkflow,
  finishJobWorkflow,
  markWorkCompleteWorkflow,
  requestFundingWorkflow,
  setJobStatusWorkflow,
  startJobWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import {
  cancelSchedule,
  scheduleJob,
  updateSchedule,
} from '../../src/lib/workflow/schedulingWorkflow'
import { addJob } from '../../src/lib/jobs'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  installMockSession,
  mockCustomerSession,
  mockOwnerSession,
  mockWorkerSession,
} from '../helpers/mockSession'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import type { Job } from '../../src/lib/jobs/types'
import { InMemoryTeamMemberRepository } from '../../src/lib/team/repository'
import { setTeamMemberRepository } from '../../src/lib/team/repository'
import type { TeamMember } from '../../src/lib/jobs/types'

function seedTeamMembers(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? `job-${Math.random().toString(16).slice(2)}`
  return {
    id,
    projectId: 'proj-1',
    title: 'Test Job',
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
    craftsmanUserId: 'owner-1',
    customerUserId: 'cust-1',
    providerId: 'prov-1',
    workCompletedAt: undefined,
    paymentReleasedAt: undefined,
    ...overrides,
  } as Job
}

beforeEach(() => {
  setupCleanRepositories()
  seedTeamMembers([])
})

describe('Workflow RBAC — markWorkCompleteWorkflow', () => {
  it('throws when an unrelated worker (different provider) tries to mark complete', async () => {
    const job = makeJob({ id: 'job-mark-1', providerId: 'prov-1' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-foreign', userId: 'w-foreign', providerId: 'prov-other', name: 'Foreign', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-foreign'))
    await expect(markWorkCompleteWorkflow('job-mark-1')).rejects.toThrow(RbacError)
  })

  it('passes for the job owner', async () => {
    const job = makeJob({ id: 'job-mark-2' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(markWorkCompleteWorkflow('job-mark-2')).resolves.toBeDefined()
  })

  it('passes for an assigned worker of the same provider', async () => {
    const job = makeJob({ id: 'job-mark-3', assignedMemberIds: ['tm-1'] })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'W1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    await expect(markWorkCompleteWorkflow('job-mark-3')).resolves.toBeDefined()
  })

  it('throws for a customer caller', async () => {
    const job = makeJob({ id: 'job-mark-4' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(markWorkCompleteWorkflow('job-mark-4')).rejects.toThrow(RbacError)
  })
})

describe('Workflow RBAC — requestFundingWorkflow', () => {
  it('throws when a worker (not owner) tries to request funding', async () => {
    const job = makeJob({ id: 'job-rf-1' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'W1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    await expect(requestFundingWorkflow('job-rf-1')).rejects.toThrow(RbacError)
  })

  it('throws when a customer tries to request funding', async () => {
    const job = makeJob({ id: 'job-rf-2' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(requestFundingWorkflow('job-rf-2')).rejects.toThrow(RbacError)
  })

  it('throws when a different owner tries to request funding', async () => {
    const job = makeJob({ id: 'job-rf-3', craftsmanUserId: 'owner-1' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-other'))
    await expect(requestFundingWorkflow('job-rf-3')).rejects.toThrow(RbacError)
  })
})

describe('Workflow RBAC — confirmFundingWorkflow', () => {
  it('throws when a worker triggers confirm directly', async () => {
    const job = makeJob({ id: 'job-cf-1' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'W1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    await expect(confirmFundingWorkflow('job-cf-1')).rejects.toThrow(RbacError)
  })

  it('throws when a different customer triggers confirm', async () => {
    const job = makeJob({ id: 'job-cf-2' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-other'))
    await expect(confirmFundingWorkflow('job-cf-2')).rejects.toThrow(RbacError)
  })
})

describe('Workflow RBAC — customerFundingEntryWorkflow', () => {
  // The guard runs after job + fundingRequest lookup so missing data still
  // short-circuits to `undefined`. Seed a funding request to exercise the
  // role check below.
  async function seedFundingRequest(job: Job): Promise<void> {
    const { ensureFundingRequest } = await import('../../src/lib/payments/fundingRequest')
    const { ensureEscrowPlan } = await import('../../src/lib/payments/escrow')
    await ensureEscrowPlan({
      sourceOfferId: `offer-${job.id}`,
      jobId: job.id,
      customerUserId: job.customerUserId!,
      providerId: job.providerId!,
      totalAmount: 1000,
    })
    await ensureFundingRequest({
      sourceOfferId: `offer-${job.id}`,
      jobId: job.id,
      escrowPlanId: `plan-${job.id}`,
      customerUserId: job.customerUserId!,
      providerId: job.providerId!,
      providerUserId: job.craftsmanUserId!,
      amount: 1000,
      currency: 'EUR',
    })
  }

  it('throws when a worker triggers customerFundingEntry', async () => {
    const job = makeJob({ id: 'job-fe-1' })
    await addJob(job)
    await seedFundingRequest(job)
    installMockSession(mockWorkerSession('w-1'))
    await expect(customerFundingEntryWorkflow('job-fe-1')).rejects.toThrow(RbacError)
  })

  it('throws when an owner triggers customerFundingEntry', async () => {
    const job = makeJob({ id: 'job-fe-2' })
    await addJob(job)
    await seedFundingRequest(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(customerFundingEntryWorkflow('job-fe-2')).rejects.toThrow(RbacError)
  })
})

describe('Workflow RBAC — customerReleasePaymentWorkflow money-bug regression', () => {
  it('blocks a worker from triggering customer release', async () => {
    const job = makeJob({ id: 'job-cr-1', status: 'waiting_payment', workCompletedAt: 1 })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'W1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    await expect(customerReleasePaymentWorkflow('job-cr-1')).rejects.toThrow(RbacError)
  })

  it('blocks owner-account from triggering customer release', async () => {
    const job = makeJob({ id: 'job-cr-2', status: 'waiting_payment', workCompletedAt: 1 })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(customerReleasePaymentWorkflow('job-cr-2')).rejects.toThrow(RbacError)
  })

  it('blocks one customer from releasing another customer\'s job', async () => {
    const job = makeJob({ id: 'job-cr-3', status: 'waiting_payment', workCompletedAt: 1 })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-other'))
    await expect(customerReleasePaymentWorkflow('job-cr-3')).rejects.toThrow(RbacError)
  })

  it('passes for the matching customer (other pre-conds met)', async () => {
    const job = makeJob({ id: 'job-cr-4', status: 'waiting_payment', workCompletedAt: 1 })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    // Caller is correct; any subsequent failure must come from non-RBAC reasons.
    await expect(customerReleasePaymentWorkflow('job-cr-4')).resolves.toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// New guards: startJobWorkflow, finishJobWorkflow, setJobStatusWorkflow,
// scheduleJob, updateSchedule, cancelSchedule
// ─────────────────────────────────────────────────────────────────────────────

describe('Workflow RBAC — startJobWorkflow', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-sjw-1' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(startJobWorkflow('job-sjw-1')).rejects.toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-sjw-2' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    await expect(startJobWorkflow('job-sjw-2')).rejects.toThrow(RbacError)
  })

  it('passes for the matching owner', async () => {
    const job = makeJob({ id: 'job-sjw-3' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    // in_progress is the idempotent case — guard passes and returns job
    await expect(startJobWorkflow('job-sjw-3')).resolves.toBeDefined()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-sjw-4' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-sjw', userId: 'w-sjw', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-sjw'))
    await expect(startJobWorkflow('job-sjw-4')).resolves.toBeDefined()
  })
})

describe('Workflow RBAC — finishJobWorkflow', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-fjw-1' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(finishJobWorkflow('job-fjw-1')).rejects.toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-fjw-2' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    await expect(finishJobWorkflow('job-fjw-2')).rejects.toThrow(RbacError)
  })

  it('passes for the matching owner', async () => {
    const job = makeJob({ id: 'job-fjw-3' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(finishJobWorkflow('job-fjw-3')).resolves.toBeDefined()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-fjw-4' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-fjw', userId: 'w-fjw', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-fjw'))
    await expect(finishJobWorkflow('job-fjw-4')).resolves.toBeDefined()
  })
})

describe('Workflow RBAC — setJobStatusWorkflow', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-sjs-1' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(setJobStatusWorkflow('job-sjs-1', 'in_progress')).rejects.toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-sjs-2' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    await expect(setJobStatusWorkflow('job-sjs-2', 'in_progress')).rejects.toThrow(RbacError)
  })

  it('passes for the matching owner (idempotent path)', async () => {
    const job = makeJob({ id: 'job-sjs-3', status: 'in_progress' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    // Same status → idempotent → guard passes and returns job
    await expect(setJobStatusWorkflow('job-sjs-3', 'in_progress')).resolves.toBeDefined()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-sjs-4', status: 'in_progress' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-sjs', userId: 'w-sjs', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-sjs'))
    await expect(setJobStatusWorkflow('job-sjs-4', 'in_progress')).resolves.toBeDefined()
  })
})

const SCHED_START = Date.now() + 86_400_000
const SCHED_END = SCHED_START + 7_200_000

describe('Workflow RBAC — scheduleJob', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-sch-1', status: 'booked' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(
      scheduleJob({ jobId: 'job-sch-1', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).rejects.toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-sch-2', status: 'booked' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    await expect(
      scheduleJob({ jobId: 'job-sch-2', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).rejects.toThrow(RbacError)
  })

  it('passes for the matching owner', async () => {
    const job = makeJob({ id: 'job-sch-3', status: 'booked' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(
      scheduleJob({ jobId: 'job-sch-3', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).resolves.toBeDefined()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-sch-4', status: 'booked' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-sch', userId: 'w-sch', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-sch'))
    await expect(
      scheduleJob({ jobId: 'job-sch-4', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).resolves.toBeDefined()
  })
})

describe('Workflow RBAC — updateSchedule', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-us-1', status: 'booked' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    await expect(
      updateSchedule({ jobId: 'job-us-1', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).rejects.toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-us-2', status: 'booked' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    await expect(
      updateSchedule({ jobId: 'job-us-2', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).rejects.toThrow(RbacError)
  })

  it('passes for the matching owner (falls through to scheduleJob when no existing schedule)', async () => {
    const job = makeJob({ id: 'job-us-3', status: 'booked' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    await expect(
      updateSchedule({ jobId: 'job-us-3', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).resolves.toBeDefined()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-us-4', status: 'booked' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-us', userId: 'w-us', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-us'))
    await expect(
      updateSchedule({ jobId: 'job-us-4', scheduledStart: SCHED_START, scheduledEnd: SCHED_END })
    ).resolves.toBeDefined()
  })
})

describe('Workflow RBAC — cancelSchedule (synchronous)', () => {
  it('throws for a customer session', async () => {
    const job = makeJob({ id: 'job-cs-1', status: 'scheduled' })
    await addJob(job)
    installMockSession(mockCustomerSession('cust-1'))
    expect(() => cancelSchedule('job-cs-1')).toThrow(RbacError)
  })

  it('throws for a foreign owner', async () => {
    const job = makeJob({ id: 'job-cs-2', status: 'scheduled' })
    await addJob(job)
    installMockSession(mockOwnerSession('other-owner'))
    expect(() => cancelSchedule('job-cs-2')).toThrow(RbacError)
  })

  it('passes for the matching owner (returns undefined when no schedule exists)', async () => {
    const job = makeJob({ id: 'job-cs-3', status: 'scheduled' })
    await addJob(job)
    installMockSession(mockOwnerSession('owner-1'))
    // Guard passes; no schedule seeded → returns undefined (does not throw)
    expect(() => cancelSchedule('job-cs-3')).not.toThrow()
  })

  it('passes for an assigned worker', async () => {
    const job = makeJob({ id: 'job-cs-4', status: 'scheduled' })
    await addJob(job)
    seedTeamMembers([
      { id: 'tm-cs', userId: 'w-cs', providerId: 'prov-1', name: 'W', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-cs'))
    expect(() => cancelSchedule('job-cs-4')).not.toThrow()
  })
})
