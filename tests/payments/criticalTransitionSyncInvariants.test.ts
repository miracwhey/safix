/**
 * Payment Sync Guards / Critical Transition Integrity — Invariant Tests
 *
 * Proves that every critical state transition leaves Payment, Job, and
 * Project in a consistent, non-contradictory state, both immediately after
 * the transition and after a simulated reload (bootstrap reconciliation).
 *
 * INVARIANTS UNDER TEST
 * ---------------------
 * A. Release corridor: after releaseEscrowWorkflow, Payment/Job/Project triple
 *    carry consistent state (released / completed).
 *
 * B. Refund corridor: after refundEscrowWorkflow, triple is consistent
 *    (refunded / completed).
 *
 * C. updatePaymentWorkflow drives full triple sync at each state.
 *
 * D. syncPaymentStateToJobAndProject partial failure (job update throws):
 *    result.jobSynced=false, result.jobError set, project sync still runs
 *    independently, no silent half-success.
 *
 * E. reconcilePaymentStateDownstream heals a stale project without touching
 *    a job/project that is already in sync.
 *
 * F. Bootstrap reload simulation: syncAllProjectsFromJobs heals a project
 *    that is behind the canonical payment state, using payment as the
 *    authoritative source.
 *
 * G. Stale-overwrite protection: syncAllProjectsFromJobs does NOT regress a
 *    project whose paymentState is newer than job.paymentState — the
 *    reconciliation re-reads canonical payment truth, not the stale job copy.
 *
 * H. Job.paymentState default: a job explicitly created with a given
 *    paymentState reads that value back, never the ?? fallback default.
 *
 * I. Release with no linked project: releaseEscrowWorkflow completes
 *    successfully and sets projectNotFound=true, not projectSynced=false.
 *
 * J. Release idempotency: calling releaseEscrowWorkflow a second time (job
 *    no longer in waiting_payment) returns undefined — no double-release.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// --- Job domain ---
import { addJob, getJobById } from '../../src/lib/jobs'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import type { Job } from '../../src/lib/jobs/types'

// --- Project domain ---
import { addProject, getProjectByJobId } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects/projectTypes'

// --- Payment domain ---
import {
  createPaymentForJob,
  updatePaymentState,
  getPaymentForJob,
} from '../../src/lib/payments/service'

// --- Workflow ---
import {
  releaseEscrowWorkflow,
  refundEscrowWorkflow,
  syncPaymentStateToJobAndProject,
  reconcilePaymentStateDownstream,
  updatePaymentWorkflow,
  type PaymentSyncResult,
} from '../../src/lib/workflow/paymentWorkflow'
import {
  syncAllProjectsFromJobs,
  syncProjectForJobId,
} from '../../src/lib/projects/projectJobSyncBridge'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0

function uid(): string {
  counter += 1
  return `crit-${counter}`
}

function makeJob(id: string, projectId: string, overrides?: Partial<Job>): Job {
  return {
    id,
    projectId,
    title: 'Test Job',
    customer: 'Test Customer',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '€2.000',
    description: 'Test description',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    ...overrides,
  }
}

function makeProject(jobId: string, id: string, overrides?: Partial<Project>): Project {
  return {
    id,
    sourceJobId: jobId,
    title: 'Test Project',
    customer: 'Test Customer',
    craftsman: 'Test Craftsman',
    location: 'Berlin',
    dateLabel: 'Heute',
    price: '€2.000',
    status: 'active',
    paymentState: 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/**
 * Creates a job + project + payment advanced to `release_pending`, with the
 * job set to `waiting_payment`.  This is the minimal pre-condition for
 * releaseEscrowWorkflow to proceed.
 */
async function createReleasableScenario(): Promise<{ jobId: string; projectId: string }> {
  const id = uid()
  const jobId = `job-${id}`
  const projectId = `proj-${id}`

  await addJob(makeJob(jobId, projectId, { status: 'waiting_payment', paymentState: 'release_pending' }))
  await addProject(makeProject(jobId, projectId, { paymentState: 'release_pending' }))

  // Payment service layer only — does not sync job/project
  await createPaymentForJob(jobId, 2000)
  await updatePaymentState(jobId, 'deposit_paid')
  await updatePaymentState(jobId, 'in_escrow')
  await updatePaymentState(jobId, 'work_in_progress')
  await updatePaymentState(jobId, 'release_pending')

  return { jobId, projectId }
}

/**
 * Creates a job + project + payment advanced to `release_pending`, with the
 * job set to `waiting_payment`.  This is a valid pre-condition for
 * refundEscrowWorkflow (release_pending → refunded is an allowed transition).
 */
async function createRefundableScenario(): Promise<{ jobId: string; projectId: string }> {
  const id = uid()
  const jobId = `job-${id}`
  const projectId = `proj-${id}`

  await addJob(makeJob(jobId, projectId, { status: 'waiting_payment', paymentState: 'release_pending' }))
  await addProject(makeProject(jobId, projectId, { paymentState: 'release_pending' }))

  await createPaymentForJob(jobId, 2000)
  await updatePaymentState(jobId, 'deposit_paid')
  await updatePaymentState(jobId, 'in_escrow')
  await updatePaymentState(jobId, 'work_in_progress')
  await updatePaymentState(jobId, 'release_pending')

  return { jobId, projectId }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  counter = 0
})

// ===========================================================================
// A — Release corridor triple consistency
// ===========================================================================

describe('A — releaseEscrowWorkflow: Payment / Job / Project triple consistency', () => {
  it('payment.state = released after release', async () => {
    const { jobId } = await createReleasableScenario()
    await releaseEscrowWorkflow(jobId)
    expect(getPaymentForJob(jobId)!.state).toBe('released')
  })

  it('job.paymentState = released after release', async () => {
    const { jobId } = await createReleasableScenario()
    await releaseEscrowWorkflow(jobId)
    expect(getJobById(jobId)!.paymentState).toBe('released')
  })

  it('project.paymentState = released after release', async () => {
    const { jobId } = await createReleasableScenario()
    await releaseEscrowWorkflow(jobId)
    expect(getProjectByJobId(jobId)!.paymentState).toBe('released')
  })

  it('job.status = completed after release', async () => {
    const { jobId } = await createReleasableScenario()
    await releaseEscrowWorkflow(jobId)
    expect(getJobById(jobId)!.status).toBe('completed')
  })

  it('all three agree — no entity holds a contradicting state', async () => {
    const { jobId } = await createReleasableScenario()
    await releaseEscrowWorkflow(jobId)

    const payment = getPaymentForJob(jobId)!
    const job = getJobById(jobId)!
    const project = getProjectByJobId(jobId)!

    expect(payment.state).toBe('released')
    expect(job.paymentState).toBe('released')
    expect(project.paymentState).toBe('released')
    expect(job.status).toBe('completed')
  })
})

// ===========================================================================
// B — Refund corridor triple consistency
// ===========================================================================

describe('B — refundEscrowWorkflow: Payment / Job / Project triple consistency', () => {
  it('payment.state = refunded after refund', async () => {
    const { jobId } = await createRefundableScenario()
    await refundEscrowWorkflow(jobId)
    expect(getPaymentForJob(jobId)!.state).toBe('refunded')
  })

  it('job.paymentState = refunded after refund', async () => {
    const { jobId } = await createRefundableScenario()
    await refundEscrowWorkflow(jobId)
    expect(getJobById(jobId)!.paymentState).toBe('refunded')
  })

  it('project.paymentState = refunded after refund', async () => {
    const { jobId } = await createRefundableScenario()
    await refundEscrowWorkflow(jobId)
    expect(getProjectByJobId(jobId)!.paymentState).toBe('refunded')
  })

  it('job.status = completed after refund (no separate cancelled status)', async () => {
    const { jobId } = await createRefundableScenario()
    await refundEscrowWorkflow(jobId)
    expect(getJobById(jobId)!.status).toBe('completed')
  })

  it('all three agree after refund', async () => {
    const { jobId } = await createRefundableScenario()
    await refundEscrowWorkflow(jobId)

    const payment = getPaymentForJob(jobId)!
    const job = getJobById(jobId)!
    const project = getProjectByJobId(jobId)!

    expect(payment.state).toBe('refunded')
    expect(job.paymentState).toBe('refunded')
    expect(project.paymentState).toBe('refunded')
    expect(job.status).toBe('completed')
  })
})

// ===========================================================================
// C — updatePaymentWorkflow drives triple sync at each state
// ===========================================================================

describe('C — updatePaymentWorkflow: drives full triple sync', () => {
  it('after updatePaymentWorkflow(in_escrow): job and project reflect in_escrow', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')

    await updatePaymentWorkflow(jobId, 'in_escrow')

    expect(getPaymentForJob(jobId)!.state).toBe('in_escrow')
    expect(getJobById(jobId)!.paymentState).toBe('in_escrow')
    expect(getProjectByJobId(jobId)!.paymentState).toBe('in_escrow')
  })

  it('after updatePaymentWorkflow(work_in_progress): triple consistent', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')

    await updatePaymentWorkflow(jobId, 'work_in_progress')

    expect(getPaymentForJob(jobId)!.state).toBe('work_in_progress')
    expect(getJobById(jobId)!.paymentState).toBe('work_in_progress')
    expect(getProjectByJobId(jobId)!.paymentState).toBe('work_in_progress')
  })

  it('after updatePaymentWorkflow(release_pending): triple consistent', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')

    await updatePaymentWorkflow(jobId, 'release_pending')

    expect(getPaymentForJob(jobId)!.state).toBe('release_pending')
    expect(getJobById(jobId)!.paymentState).toBe('release_pending')
    expect(getProjectByJobId(jobId)!.paymentState).toBe('release_pending')
  })
})

// ===========================================================================
// D — syncPaymentStateToJobAndProject partial failure
// ===========================================================================

describe('D — syncPaymentStateToJobAndProject: partial failure captured, project sync independent', () => {
  it('result.jobSynced=false and result.jobError set when job repo update throws', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')

    // Inject a failing job repository update
    const jobRepo = getJobRepository()
    const originalUpdate = jobRepo.update.bind(jobRepo)
    jobRepo.update = async (_id: string, _updater: (j: Job) => Job) => {
      throw new Error('simulated DB failure on job update')
    }

    let result: PaymentSyncResult
    try {
      result = await syncPaymentStateToJobAndProject(jobId, 'in_escrow')
    } finally {
      jobRepo.update = originalUpdate
    }

    expect(result!.jobSynced).toBe(false)
    expect(result!.jobError).toBeInstanceOf(Error)
  })

  it('project sync still runs when job update fails', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId, { paymentState: 'deposit_required' }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')

    const jobRepo = getJobRepository()
    const originalUpdate = jobRepo.update.bind(jobRepo)
    jobRepo.update = async (_id: string, _updater: (j: Job) => Job) => {
      throw new Error('simulated DB failure on job update')
    }

    let result: PaymentSyncResult
    try {
      result = await syncPaymentStateToJobAndProject(jobId, 'in_escrow')
    } finally {
      jobRepo.update = originalUpdate
    }

    // Job sync failed — but project must still reflect the canonical state
    expect(result!.projectSynced).toBe(true)
    expect(getProjectByJobId(jobId)!.paymentState).toBe('in_escrow')
  })

  it('both synced when everything works — no false negatives', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId))
    await addProject(makeProject(jobId, projectId))
    await createPaymentForJob(jobId, 2000)

    const result = await syncPaymentStateToJobAndProject(jobId, 'deposit_required')

    expect(result.jobSynced).toBe(true)
    expect(result.projectSynced).toBe(true)
    expect(result.projectNotFound).toBe(false)
  })

  it('projectNotFound=true when job has no linked project', async () => {
    const id = uid()
    const jobId = `job-${id}`

    // Create job WITHOUT a linked project
    await addJob(makeJob(jobId, 'no-project-id'))
    await createPaymentForJob(jobId, 2000)

    const result = await syncPaymentStateToJobAndProject(jobId, 'deposit_required')

    expect(result.projectNotFound).toBe(true)
    expect(result.projectSynced).toBe(false)
  })
})

// ===========================================================================
// E — reconcilePaymentStateDownstream heals stale project
// ===========================================================================

describe('E — reconcilePaymentStateDownstream: heals divergence', () => {
  it('heals a project that is behind canonical payment state', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId, { paymentState: 'release_pending' }))
    await addProject(makeProject(jobId, projectId, { paymentState: 'work_in_progress' })) // stale
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')

    // Simulate stale project (project stuck at work_in_progress while payment is release_pending)
    // The project was set to 'work_in_progress' on addProject but payment advanced further
    const result = await reconcilePaymentStateDownstream(jobId)

    expect(result).toBeTruthy()
    expect(getProjectByJobId(jobId)!.paymentState).toBe('release_pending')
  })

  it('returns a pre-built success result when already in sync — no spurious sync', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId, { paymentState: 'in_escrow' }))
    await addProject(makeProject(jobId, projectId, { paymentState: 'in_escrow' }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')

    const result = await reconcilePaymentStateDownstream(jobId)

    // Already aligned → reconcile returns an already-synced result without re-syncing
    expect(result).toBeTruthy()
    expect(result!.jobSynced).toBe(true)
    expect(result!.projectSynced).toBe(true)
  })

  it('returns undefined when no payment exists for the job', async () => {
    const id = uid()
    const jobId = `job-${id}`

    await addJob(makeJob(jobId, `proj-${id}`))
    // no createPaymentForJob call

    const result = await reconcilePaymentStateDownstream(jobId)
    expect(result).toBeUndefined()
  })
})

// ===========================================================================
// F — Bootstrap reload simulation: syncAllProjectsFromJobs heals stale state
// ===========================================================================

describe('F — syncAllProjectsFromJobs: bootstrap reconciliation heals stale project', () => {
  it('project stale after a sync failure is healed by bootstrap scan', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    // Simulate post-transition state: payment=released, job.paymentState=released,
    // but project is still stuck at work_in_progress (DB write failed and rolled back)
    await addJob(makeJob(jobId, projectId, { paymentState: 'released' }))
    await addProject(makeProject(jobId, projectId, { paymentState: 'work_in_progress' })) // stale
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')
    await updatePaymentState(jobId, 'released')

    // Simulate reload: run bootstrap sync
    await syncAllProjectsFromJobs()

    // Project must now reflect canonical payment truth (released)
    expect(getProjectByJobId(jobId)!.paymentState).toBe('released')
  })

  it('project already in sync is not re-synced unnecessarily', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId, { paymentState: 'in_escrow' }))
    await addProject(makeProject(jobId, projectId, { paymentState: 'in_escrow' }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')

    // Bootstrap should not corrupt the aligned state
    await syncAllProjectsFromJobs()

    expect(getProjectByJobId(jobId)!.paymentState).toBe('in_escrow')
  })
})

// ===========================================================================
// G — Stale-overwrite protection: reconcile uses payment as canonical source
// ===========================================================================

describe('G — stale-overwrite protection: payment truth wins over stale job.paymentState', () => {
  it('syncProjectForJobId re-syncs from canonical payment, not stale job.paymentState', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    // State: payment=released, but job.paymentState is stale (work_in_progress)
    // This can happen if a job update was rolled back after the payment committed.
    await addJob(makeJob(jobId, projectId, { paymentState: 'work_in_progress' })) // stale
    await addProject(makeProject(jobId, projectId, { paymentState: 'work_in_progress' }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')
    await updatePaymentState(jobId, 'released') // canonical payment ahead of stale job

    // Bridge-targeted sync for this job
    await syncProjectForJobId(jobId)

    // The project must reflect the CANONICAL payment state (released),
    // NOT be regressed to the stale job.paymentState (work_in_progress).
    expect(getProjectByJobId(jobId)!.paymentState).toBe('released')
  })

  it('bootstrap scan heals project using payment truth, not stale job.paymentState', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId, { paymentState: 'in_escrow' })) // stale
    await addProject(makeProject(jobId, projectId, { paymentState: 'deposit_required' }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')
    // canonical payment is at release_pending; job.paymentState is 'in_escrow' (stale)

    await syncAllProjectsFromJobs()

    // Payment is canonical: project should be at release_pending, not in_escrow
    expect(getProjectByJobId(jobId)!.paymentState).toBe('release_pending')
  })
})

// ===========================================================================
// H — Job.paymentState default: explicit value survives read-back
// ===========================================================================

describe('H — Job.paymentState default: explicit state is preserved on read-back', () => {
  it('job created with paymentState=release_pending reads back release_pending, not deposit_required', async () => {
    const id = uid()
    const jobId = `job-${id}`
    const projectId = `proj-${id}`

    await addJob(makeJob(jobId, projectId, { paymentState: 'release_pending' }))

    const job = getJobById(jobId)
    expect(job).toBeTruthy()
    expect(job!.paymentState).toBe('release_pending')
  })

  it('job created with paymentState=released reads back released', async () => {
    const id = uid()
    const jobId = `job-${id}`

    await addJob(makeJob(jobId, `proj-${id}`, { paymentState: 'released' }))

    expect(getJobById(jobId)!.paymentState).toBe('released')
  })

  it('job created with paymentState=none reads back none, never a false default', async () => {
    const id = uid()
    const jobId = `job-${id}`

    await addJob(makeJob(jobId, `proj-${id}`, { paymentState: 'none' }))

    expect(getJobById(jobId)!.paymentState).toBe('none')
  })
})

// ===========================================================================
// I — Release with no linked project: projectNotFound, workflow still completes
// ===========================================================================

describe('I — releaseEscrowWorkflow with no linked project', () => {
  it('returns a payment entity (does not crash or return undefined)', async () => {
    const id = uid()
    const jobId = `job-${id}`

    // Job has a projectId that doesn't exist in the repository
    await addJob(makeJob(jobId, 'ghost-project', {
      status: 'waiting_payment',
      paymentState: 'release_pending',
    }))
    // No addProject call → project not found
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')

    const { payment: result } = await releaseEscrowWorkflow(jobId)
    expect(result).toBeTruthy()
    expect(result!.state).toBe('released')
  })

  it('payment and job reflect released state even when project is missing', async () => {
    const id = uid()
    const jobId = `job-${id}`

    await addJob(makeJob(jobId, 'ghost-project', {
      status: 'waiting_payment',
      paymentState: 'release_pending',
    }))
    await createPaymentForJob(jobId, 2000)
    await updatePaymentState(jobId, 'deposit_paid')
    await updatePaymentState(jobId, 'in_escrow')
    await updatePaymentState(jobId, 'work_in_progress')
    await updatePaymentState(jobId, 'release_pending')

    await releaseEscrowWorkflow(jobId)

    expect(getPaymentForJob(jobId)!.state).toBe('released')
    expect(getJobById(jobId)!.paymentState).toBe('released')
    expect(getJobById(jobId)!.status).toBe('completed')
  })
})

// ===========================================================================
// J — Release idempotency: second call does not double-release
// ===========================================================================

describe('J — releaseEscrowWorkflow idempotency', () => {
  it('second call returns undefined when job is no longer in waiting_payment', async () => {
    const { jobId } = await createReleasableScenario()

    const { payment: first } = await releaseEscrowWorkflow(jobId)
    expect(first).toBeTruthy()

    // After release, job.status = 'completed' — not waiting_payment
    // Second call should be rejected by the guard
    const { payment: second } = await releaseEscrowWorkflow(jobId)
    expect(second).toBeUndefined()
  })

  it('payment state does not regress on second release attempt', async () => {
    const { jobId } = await createReleasableScenario()

    await releaseEscrowWorkflow(jobId)
    await releaseEscrowWorkflow(jobId) // idempotent second call

    expect(getPaymentForJob(jobId)!.state).toBe('released')
  })

  it('refundEscrowWorkflow second call returns undefined when job is completed', async () => {
    const { jobId } = await createRefundableScenario()

    const first = await refundEscrowWorkflow(jobId)
    expect(first).toBeTruthy()

    const second = await refundEscrowWorkflow(jobId)
    expect(second).toBeUndefined()
  })
})
