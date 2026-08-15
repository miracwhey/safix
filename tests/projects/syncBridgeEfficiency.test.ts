/**
 * Block 5 — Sync Bridge Efficiency Tests
 *
 * Proves that:
 * 1. Normal job-linked changes no longer trigger full-scan reconciliation
 * 2. Only the affected project/job context is processed on incremental updates
 * 3. Recovery/correction still works for the affected context
 * 4. Bootstrap/full-recovery path still works (syncAllProjectsFromJobs)
 * 5. Repeated rapid triggers do not cause redundant broad re-sync
 * 6. syncProjectForJobId correctly targets a single context
 * 7. No regression to Blocks 1–4.1 correctness
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobById } from '../../src/lib/jobs'
import { updateJobStatus, updateJobPaymentState } from '../../src/lib/jobs/service'
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import {
  createPaymentForJob,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import {
  updatePaymentWorkflow,
} from '../../src/lib/workflow/paymentWorkflow'
import {
  syncAllProjectsFromJobs,
  syncProjectForJobId,
  startProjectJobSyncBridge,
} from '../../src/lib/projects/projectJobSyncBridge'
import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = Date.now()
const HOUR = 3600_000

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€2.000',
    description: 'Test',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    proposalSentAt: NOW - 72 * HOUR,
    proposalAcceptedAt: NOW - 48 * HOUR,
    ...overrides,
  }
}

function makeProject(overrides?: Partial<Project>): Project {
  return {
    id: 'project-1',
    sourceJobId: 'job-1',
    title: 'Test Project',
    customer: 'Test Customer',
    craftsman: 'Test Craftsman',
    location: 'Berlin',
    dateLabel: 'Heute',
    price: '€2.000',
    status: 'request',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Flushes all pending microtasks (including queueMicrotask callbacks used by
 * the bridge's deduplication). setTimeout(0) schedules a macrotask — the JS
 * event loop guarantees all microtasks complete before any macrotask runs.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  setupCleanRepositories()
})

// ---------------------------------------------------------------------------
// PART 1 — syncProjectForJobId: targeted single-context sync
// ---------------------------------------------------------------------------

describe('syncProjectForJobId — targeted single-context sync', () => {
  it('syncs the project linked to a specific changed job', async () => {
    const job = makeJob({ id: 'job-t1', status: 'in_progress', paymentState: 'work_in_progress' })
    await addJob(job)
    await addProject(
      makeProject({
        id: 'proj-t1',
        sourceJobId: 'job-t1',
        status: 'request',
        paymentState: 'none',
      })
    )

    const didWork = await syncProjectForJobId('job-t1')
    expect(didWork).toBe(true)

    const project = getProjectByJobId('job-t1')!
    expect(project.status).toBe('in_progress')
    expect(project.paymentState).toBe('work_in_progress')
  })

  it('returns false when no job exists for the given jobId', async () => {
    const didWork = await syncProjectForJobId('nonexistent-job')
    expect(didWork).toBe(false)
  })

  it('returns false when no project is linked to the job', async () => {
    await addJob(makeJob({ id: 'orphan-job' }))
    const didWork = await syncProjectForJobId('orphan-job')
    expect(didWork).toBe(false)
  })

  it('returns false when project is already in sync with the job', async () => {
    await addJob(makeJob({ id: 'job-sync', status: 'in_progress', paymentState: 'work_in_progress' }))
    await addProject(
      makeProject({
        id: 'proj-sync',
        sourceJobId: 'job-sync',
        status: 'in_progress',
        paymentState: 'work_in_progress',
      })
    )

    const didWork = await syncProjectForJobId('job-sync')
    expect(didWork).toBe(false)
  })

  it('does NOT touch unrelated projects', async () => {
    // Set up two job/project pairs
    await addJob(makeJob({ id: 'job-a', status: 'in_progress', paymentState: 'work_in_progress' }))
    await addProject(makeProject({ id: 'proj-a', sourceJobId: 'job-a', status: 'request', paymentState: 'none' }))

    await addJob(makeJob({ id: 'job-b', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({ id: 'proj-b', sourceJobId: 'job-b', status: 'request', paymentState: 'none' }))

    // Sync only job-a
    await syncProjectForJobId('job-a')

    // proj-a is synced
    const projA = getProjectByJobId('job-a')!
    expect(projA.status).toBe('in_progress')

    // proj-b is NOT touched — still stale
    const projB = getProjectByJobId('job-b')!
    expect(projB.status).toBe('request')
    expect(projB.paymentState).toBe('none')
  })

  it('reconciles canonical payment state when stale', async () => {
    const job = makeJob({ id: 'job-pay', paymentState: 'none' })
    await addJob(job)
    await addProject(
      makeProject({ id: 'proj-pay', sourceJobId: 'job-pay', paymentState: 'none' })
    )
    await createPaymentForJob('job-pay', 2000)
    await updatePaymentWorkflow('job-pay', 'deposit_paid')

    // Force stale state
    await updateJobPaymentState('job-pay', 'none')

    // Now downstream is stale relative to canonical payment
    const payment = getPaymentForJob('job-pay')!
    expect(payment.state).toBe('deposit_paid')
    expect(getJobById('job-pay')!.paymentState).toBe('none')

    // Targeted sync should reconcile (reconcilePaymentStateDownstream is
    // now awaited inside syncProjectForJobId — Block 4)
    const didWork = await syncProjectForJobId('job-pay')
    expect(didWork).toBe(true)

    expect(getJobById('job-pay')!.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId('job-pay')!.paymentState).toBe('deposit_paid')
  })
})

// ---------------------------------------------------------------------------
// PART 2 — Bootstrap full-scan remains correct
// ---------------------------------------------------------------------------

describe('syncAllProjectsFromJobs — bootstrap full-scan path', () => {
  it('repairs all stale projects on bootstrap', async () => {
    await addJob(makeJob({ id: 'job-b1', status: 'in_progress', paymentState: 'work_in_progress' }))
    await addProject(makeProject({ id: 'proj-b1', sourceJobId: 'job-b1', status: 'request', paymentState: 'none' }))

    await addJob(makeJob({ id: 'job-b2', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({ id: 'proj-b2', sourceJobId: 'job-b2', status: 'request', paymentState: 'none' }))

    await syncAllProjectsFromJobs()

    expect(getProjectByJobId('job-b1')!.status).toBe('in_progress')
    expect(getProjectByJobId('job-b1')!.paymentState).toBe('work_in_progress')
    expect(getProjectByJobId('job-b2')!.status).toBe('completed')
    expect(getProjectByJobId('job-b2')!.paymentState).toBe('released')
  })

  it('is a no-op when all projects are in sync', async () => {
    await addJob(makeJob({ id: 'job-ok', status: 'in_progress', paymentState: 'work_in_progress' }))
    await addProject(makeProject({ id: 'proj-ok', sourceJobId: 'job-ok', status: 'in_progress', paymentState: 'work_in_progress' }))

    // Should not throw or change anything
    await syncAllProjectsFromJobs()

    expect(getProjectByJobId('job-ok')!.status).toBe('in_progress')
    expect(getProjectByJobId('job-ok')!.paymentState).toBe('work_in_progress')
  })

  it('reconciles payment state divergence on bootstrap', async () => {
    const job = makeJob({ id: 'job-bpay', paymentState: 'none' })
    await addJob(job)
    await addProject(makeProject({ id: 'proj-bpay', sourceJobId: 'job-bpay', paymentState: 'none' }))
    await createPaymentForJob('job-bpay', 2000)
    await updatePaymentWorkflow('job-bpay', 'deposit_paid')

    // Force stale downstream
    await updateJobPaymentState('job-bpay', 'none')

    await syncAllProjectsFromJobs()

    expect(getJobById('job-bpay')!.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId('job-bpay')!.paymentState).toBe('deposit_paid')
  })
})

// ---------------------------------------------------------------------------
// PART 3 — Incremental bridge: targeted, not full-scan
// ---------------------------------------------------------------------------

describe('startProjectJobSyncBridge — incremental targeted sync', () => {
  it('syncs only the changed job context after a job status update', async () => {
    await addJob(makeJob({ id: 'job-inc1', status: 'new' }))
    await addProject(makeProject({ id: 'proj-inc1', sourceJobId: 'job-inc1', status: 'request' }))

    await addJob(makeJob({ id: 'job-inc2', status: 'new' }))
    await addProject(makeProject({ id: 'proj-inc2', sourceJobId: 'job-inc2', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Change only job-inc1
    updateJobStatus('job-inc1', 'in_progress')

    // Wait for microtask flush
    await flushMicrotasks()

    // proj-inc1 should be synced
    expect(getProjectByJobId('job-inc1')!.status).toBe('in_progress')

    // proj-inc2 should NOT be touched — still 'request' (matches its unchanged job)
    expect(getProjectByJobId('job-inc2')!.status).toBe('request')

    unsubscribe()
  })

  it('handles rapid sequential updates to the same job via deduplication', async () => {
    await addJob(makeJob({ id: 'job-rapid', status: 'new' }))
    await addProject(makeProject({ id: 'proj-rapid', sourceJobId: 'job-rapid', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Rapid sequential updates to the same job
    updateJobStatus('job-rapid', 'booked')
    updateJobStatus('job-rapid', 'scheduled')
    updateJobStatus('job-rapid', 'in_progress')

    // Wait for microtask flush
    await flushMicrotasks()

    // Final state should reflect the last update
    expect(getProjectByJobId('job-rapid')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('handles updates to multiple different jobs in the same tick', async () => {
    await addJob(makeJob({ id: 'job-m1', status: 'new' }))
    await addProject(makeProject({ id: 'proj-m1', sourceJobId: 'job-m1', status: 'request' }))

    await addJob(makeJob({ id: 'job-m2', status: 'waiting_payment' }))
    await addProject(makeProject({ id: 'proj-m2', sourceJobId: 'job-m2', status: 'review' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Update both jobs in the same tick
    updateJobStatus('job-m1', 'in_progress')
    updateJobStatus('job-m2', 'completed')

    // Wait for microtask flush
    await flushMicrotasks()

    expect(getProjectByJobId('job-m1')!.status).toBe('in_progress')
    expect(getProjectByJobId('job-m2')!.status).toBe('completed')

    unsubscribe()
  })

  it('does not sync unrelated projects when one job changes', async () => {
    // Create a stale project for job-unrelated
    await addJob(makeJob({ id: 'job-changed', status: 'new' }))
    await addProject(makeProject({ id: 'proj-changed', sourceJobId: 'job-changed', status: 'request' }))

    await addJob(makeJob({ id: 'job-unrelated', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({
      id: 'proj-unrelated',
      sourceJobId: 'job-unrelated',
      status: 'request',  // Intentionally stale
      paymentState: 'none', // Intentionally stale
    }))

    const unsubscribe = startProjectJobSyncBridge()

    // Only change job-changed
    updateJobStatus('job-changed', 'in_progress')

    // Wait for microtask flush
    await flushMicrotasks()

    // Changed project is synced
    expect(getProjectByJobId('job-changed')!.status).toBe('in_progress')

    // Unrelated project remains stale — the bridge did NOT touch it
    // because job-unrelated did not change during this notification
    expect(getProjectByJobId('job-unrelated')!.status).toBe('request')
    expect(getProjectByJobId('job-unrelated')!.paymentState).toBe('none')

    unsubscribe()
  })

  it('properly handles paymentState changes through the bridge', async () => {
    await addJob(makeJob({ id: 'job-pstate', status: 'new', paymentState: 'none' }))
    await addProject(makeProject({ id: 'proj-pstate', sourceJobId: 'job-pstate', paymentState: 'none' }))

    const unsubscribe = startProjectJobSyncBridge()

    updateJobPaymentState('job-pstate', 'deposit_required')

    // Wait for microtask flush
    await flushMicrotasks()

    expect(getProjectByJobId('job-pstate')!.paymentState).toBe('deposit_required')

    unsubscribe()
  })

  it('cleanup function stops listening and clears pending state', async () => {
    await addJob(makeJob({ id: 'job-clean', status: 'new' }))
    await addProject(makeProject({ id: 'proj-clean', sourceJobId: 'job-clean', status: 'accepted' }))

    const unsubscribe = startProjectJobSyncBridge()
    unsubscribe()

    // Change the job AFTER unsubscribe
    updateJobStatus('job-clean', 'in_progress')

    await flushMicrotasks()

    // Project must remain 'accepted' (its pre-unsubscribe state) — the bridge
    // is no longer listening and must not have synced the in_progress change.
    expect(getProjectByJobId('job-clean')!.status).toBe('accepted')
  })
})

// ---------------------------------------------------------------------------
// PART 4 — Recovery correctness preserved
// ---------------------------------------------------------------------------

describe('recovery correctness — no regression to Blocks 1–4.1', () => {
  it('reconcilePaymentStateDownstream still works through syncProjectForJobId', async () => {
    await addJob(makeJob({ id: 'job-recov', paymentState: 'none' }))
    await addProject(makeProject({ id: 'proj-recov', sourceJobId: 'job-recov', paymentState: 'none' }))
    await createPaymentForJob('job-recov', 5000)
    await updatePaymentWorkflow('job-recov', 'deposit_paid')

    // Force downstream stale
    await updateJobPaymentState('job-recov', 'none')

    // Targeted sync should trigger reconciliation (now awaited — Block 4)
    await syncProjectForJobId('job-recov')

    expect(getJobById('job-recov')!.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId('job-recov')!.paymentState).toBe('deposit_paid')
  })

  it('reconcilePaymentStateDownstream still works through bootstrap path', async () => {
    await addJob(makeJob({ id: 'job-brecov', paymentState: 'none' }))
    await addProject(makeProject({ id: 'proj-brecov', sourceJobId: 'job-brecov', paymentState: 'none' }))
    await createPaymentForJob('job-brecov', 3000)
    await updatePaymentWorkflow('job-brecov', 'deposit_paid')

    // Force stale
    await updateJobPaymentState('job-brecov', 'none')

    await syncAllProjectsFromJobs()

    expect(getJobById('job-brecov')!.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId('job-brecov')!.paymentState).toBe('deposit_paid')
  })
})

// ---------------------------------------------------------------------------
// PART 5 — Architecture contract verification
// ---------------------------------------------------------------------------

describe('architecture contract — targeted sync contract', () => {
  it('syncProjectForJobId is exported and callable', () => {
    expect(typeof syncProjectForJobId).toBe('function')
  })

  it('syncAllProjectsFromJobs is still exported for bootstrap use', () => {
    expect(typeof syncAllProjectsFromJobs).toBe('function')
  })

  it('startProjectJobSyncBridge returns an unsubscribe function', async () => {
    await addJob(makeJob({ id: 'job-arch' }))
    const unsubscribe = startProjectJobSyncBridge()
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })

  it('incremental bridge detects new jobs added after subscription', async () => {
    const unsubscribe = startProjectJobSyncBridge()

    // Add a new job and its project
    await addJob(makeJob({ id: 'job-new', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-new', sourceJobId: 'job-new', status: 'request' }))

    // The addJob triggers a notification — the bridge should detect it as new
    // Then the addProject triggers another notification (projects store, not jobs store)
    // We need to trigger the jobs store again so the bridge processes the new job
    updateJobPaymentState('job-new', 'work_in_progress')

    await flushMicrotasks()

    const proj = getProjectByJobId('job-new')!
    expect(proj.status).toBe('in_progress')
    expect(proj.paymentState).toBe('work_in_progress')

    unsubscribe()
  })
})
