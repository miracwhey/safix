/**
 * Block 7.2.1b — `customerReleasePaymentWorkflow` precondition update.
 *
 * The workflow must require `workConfirmedCompleteAt` (admin-confirm)
 * rather than the legacy `workCompletedAt` alias. A worker-only mark
 * must NOT unlock release.
 *
 * Acceptance auto-release cron is unaffected — it loads
 * `acceptance.expires_at` directly and does not depend on the new stamps.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  confirmJobCompletionWorkflow,
  customerReleasePaymentWorkflow,
  markWorkCompleteWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addJob, getJobById, updateJobStatus } from '../../src/lib/jobs'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  installMockSession,
  mockCustomerSession,
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
import { InMemoryTeamMemberRepository, setTeamMemberRepository } from '../../src/lib/team/repository'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

const OWNER_ID = 'owner-release-after-confirm'
const WORKER_ID = 'worker-release-after-confirm'
const PROVIDER_ID = 'prov-release-after-confirm'
const CUSTOMER_ID = 'cust-release-after-confirm'

function seedTeamMembers(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

function makeJob(overrides: Partial<Job> = {}): Job {
  const id = overrides.id ?? `job-${Math.random().toString(16).slice(2)}`
  return {
    id,
    projectId: 'proj-release-after-confirm',
    title: 'Release after confirm',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: '',
    status: 'in_progress',
    amount: '4.000 €',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: ['tm-worker'],
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

describe('customerReleasePaymentWorkflow — admin-confirm precondition', () => {
  it('customer_release_blocked_when_only_marked', async () => {
    const job = makeJob({ id: 'job-rel-1' })
    await addJob(job)
    await seedFundedPlan(job.id)

    // Worker marks but the owner has NOT confirmed.
    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    // Force the status to waiting_payment so the status guard does not
    // mask the workConfirmedCompleteAt guard.
    await updateJobStatus(job.id, 'waiting_payment')

    installMockSession(mockCustomerSession(CUSTOMER_ID))
    const result = await customerReleasePaymentWorkflow(job.id)

    expect(result?.paymentReleasedAt).toBeUndefined()
  })

  it('customer_release_passes_when_confirmed', async () => {
    const job = makeJob({ id: 'job-rel-2' })
    await addJob(job)
    await seedFundedPlan(job.id)

    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    installMockSession(mockOwnerSession(OWNER_ID))
    await confirmJobCompletionWorkflow(job.id)

    const confirmed = getJobById(job.id)
    expect(confirmed?.workConfirmedCompleteAt).toBeGreaterThan(0)
    expect(confirmed?.status).toBe('waiting_payment')

    installMockSession(mockCustomerSession(CUSTOMER_ID))
    const result = await customerReleasePaymentWorkflow(job.id)

    // The workConfirmedCompleteAt guard let the call through — the release
    // pipeline ran and at minimum advanced the Acceptance from pending → accepted.
    expect(result).toBeDefined()
    const acceptance = getAcceptanceByJobId(job.id)
    expect(acceptance?.status).toBe('accepted')
  })

  it('cron_auto_release_unaffected_by_marked_only', async () => {
    // Auto-release cron loads `acceptance.expires_at` to decide expiry; it
    // does not look at the new stamps. Confirm that marking-only never
    // creates an Acceptance record (no auto-release window opens).
    const job = makeJob({ id: 'job-rel-3' })
    await addJob(job)
    await seedFundedPlan(job.id)

    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    expect(getAcceptanceByJobId(job.id)).toBeUndefined()

    // Final tranche is also still locked → cron has nothing to release.
    const plan = getEscrowPlanByJobId(job.id)!
    const finalTranche = getEscrowTranches(plan.id).find((t) => t.kind === 'final_release')!
    expect(finalTranche.status).not.toBe('eligible_for_release')
  })

  it('cron_auto_release_works_after_admin_confirm', async () => {
    const job = makeJob({ id: 'job-rel-4' })
    await addJob(job)
    await seedFundedPlan(job.id)

    installMockSession(mockWorkerSession(WORKER_ID))
    await markWorkCompleteWorkflow(job.id)

    installMockSession(mockOwnerSession(OWNER_ID))
    await confirmJobCompletionWorkflow(job.id)

    const acceptance = getAcceptanceByJobId(job.id)
    expect(acceptance).toBeDefined()
    expect(acceptance!.status).toBe('pending')
    expect(acceptance!.expiresAt).toBeGreaterThan(acceptance!.createdAt)
  })
})
