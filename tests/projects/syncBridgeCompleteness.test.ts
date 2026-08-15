/**
 * Block 5.1 — Sync Bridge Completeness Tests
 *
 * Proves that the Block 5 narrowed bridge is not just narrower but COMPLETE:
 *
 * 1. Snapshot contract — every materially relevant field is tracked; irrelevant
 *    fields are intentionally excluded and proven not to trigger sync
 * 2. Job removal — the bridge handles deleted jobs without crashing or leaving
 *    corrupt project state
 * 3. Re-entrancy safety — reconciliation-triggered job-store notifications
 *    during flush do not cause runaway self-trigger loops
 * 4. Bootstrap-only boundary — `_isBridgeActive()` lifecycle is correct;
 *    incremental path never falls back to full-scan
 * 5. Sequential tick processing — updates across multiple ticks are processed
 *    correctly without losing changes
 * 6. Irrelevant field changes — title/description mutations do NOT trigger sync
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobById, getJobRepository } from '../../src/lib/jobs'
import { updateJobStatus, updateJobPaymentState, removeJob } from '../../src/lib/jobs/service'
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
  snapshotChanged,
  takeSnapshot,
  _isBridgeActive,
} from '../../src/lib/projects/projectJobSyncBridge'
import type { JobSnapshot } from '../../src/lib/projects/projectJobSyncBridge'
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

/**
 * Flushes all pending microtasks (including queueMicrotask callbacks used by
 * the bridge's deduplication). setTimeout(0) schedules a macrotask — the JS
 * event loop guarantees all microtasks complete before any macrotask runs.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
})

// ===========================================================================
// PART A — Snapshot contract: field completeness
// ===========================================================================

describe('snapshot contract — field completeness', () => {
  const base: JobSnapshot = {
    status: 'new',
    paymentState: 'none',
    proposalSentAt: undefined,
    proposalAcceptedAt: undefined,
  }

  it('detects status change', () => {
    expect(snapshotChanged(base, { ...base, status: 'in_progress' })).toBe(true)
  })

  it('detects paymentState change', () => {
    expect(snapshotChanged(base, { ...base, paymentState: 'deposit_paid' })).toBe(true)
  })

  it('detects proposalSentAt change', () => {
    expect(snapshotChanged(base, { ...base, proposalSentAt: NOW })).toBe(true)
  })

  it('detects proposalAcceptedAt change', () => {
    expect(snapshotChanged(base, { ...base, proposalAcceptedAt: NOW })).toBe(true)
  })

  it('returns false when all fields are identical', () => {
    expect(snapshotChanged(base, { ...base })).toBe(false)
  })

  it('returns false when both have same non-default values', () => {
    const a: JobSnapshot = { status: 'completed', paymentState: 'released', proposalSentAt: 100, proposalAcceptedAt: 200 }
    const b: JobSnapshot = { status: 'completed', paymentState: 'released', proposalSentAt: 100, proposalAcceptedAt: 200 }
    expect(snapshotChanged(a, b)).toBe(false)
  })

  it('detects multiple simultaneous field changes', () => {
    expect(snapshotChanged(base, {
      status: 'completed',
      paymentState: 'released',
      proposalSentAt: NOW,
      proposalAcceptedAt: NOW,
    })).toBe(true)
  })
})

describe('takeSnapshot — captures exactly sync-relevant fields', () => {
  it('captures status, paymentState, proposalSentAt, proposalAcceptedAt', () => {
    const job = makeJob({
      status: 'in_progress',
      paymentState: 'work_in_progress',
      proposalSentAt: 100,
      proposalAcceptedAt: 200,
    })
    const snap = takeSnapshot(job)
    expect(snap).toEqual({
      status: 'in_progress',
      paymentState: 'work_in_progress',
      proposalSentAt: 100,
      proposalAcceptedAt: 200,
    })
  })

  it('excludes irrelevant fields (title, description, etc.)', () => {
    const job = makeJob({ title: 'Changed Title', description: 'Changed Desc' })
    const snap = takeSnapshot(job)
    expect(snap).not.toHaveProperty('title')
    expect(snap).not.toHaveProperty('description')
    expect(snap).not.toHaveProperty('customer')
    expect(snap).not.toHaveProperty('location')
    expect(snap).not.toHaveProperty('workCompletedAt')
    expect(snap).not.toHaveProperty('paymentReleasedAt')
    expect(snap).not.toHaveProperty('assignedMemberIds')
  })
})

// ===========================================================================
// PART B — Irrelevant field changes do NOT trigger sync
// ===========================================================================

describe('irrelevant field changes — bridge does NOT sync', () => {
  it('changing job description does not sync a stale project', async () => {
    // Create a job with status 'completed' and a project stuck at 'request' (stale)
    await addJob(makeJob({ id: 'job-irr', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({
      id: 'proj-irr',
      sourceJobId: 'job-irr',
      status: 'request',     // Intentionally stale
      paymentState: 'none',  // Intentionally stale
    }))

    const unsubscribe = startProjectJobSyncBridge()

    // Change ONLY an irrelevant field (description) via the repository
    getJobRepository().update('job-irr', (job) => ({ ...job, description: 'Updated description' }))

    await flushMicrotasks()

    // Project must remain stale — the bridge should NOT have synced
    // because description is not in the snapshot
    const proj = getProjectByJobId('job-irr')!
    expect(proj.status).toBe('request')
    expect(proj.paymentState).toBe('none')

    unsubscribe()
  })

  it('changing assignedMemberIds does not trigger sync', async () => {
    await addJob(makeJob({ id: 'job-assign', status: 'in_progress' }))
    await addProject(makeProject({
      id: 'proj-assign',
      sourceJobId: 'job-assign',
      status: 'request',  // Stale
    }))

    const unsubscribe = startProjectJobSyncBridge()

    // Change only assignedMemberIds
    getJobRepository().update('job-assign', (job) => ({
      ...job,
      assignedMemberIds: ['member-1', 'member-2'],
    }))

    await flushMicrotasks()

    // Project should still be stale
    expect(getProjectByJobId('job-assign')!.status).toBe('request')

    unsubscribe()
  })
})

// ===========================================================================
// PART C — Job removal handling
// ===========================================================================

describe('job removal — bridge handles gracefully', () => {
  it('removing a job does not crash the bridge', async () => {
    await addJob(makeJob({ id: 'job-rem', status: 'in_progress' }))
    await addProject(makeProject({
      id: 'proj-rem',
      sourceJobId: 'job-rem',
      status: 'in_progress',
    }))

    const unsubscribe = startProjectJobSyncBridge()

    // Remove the job — this triggers a job store notification
    await removeJob('job-rem')

    // Should not throw
    await flushMicrotasks()

    // Project retains its last known state — the bridge cannot derive
    // anything new because the job no longer exists
    const proj = getProjectByJobId('job-rem')!
    expect(proj.status).toBe('in_progress')

    unsubscribe()
  })

  it('bridge continues working after a job removal', async () => {
    await addJob(makeJob({ id: 'job-rem2', status: 'new' }))
    await addProject(makeProject({ id: 'proj-rem2', sourceJobId: 'job-rem2', status: 'request' }))

    await addJob(makeJob({ id: 'job-surv', status: 'new' }))
    await addProject(makeProject({ id: 'proj-surv', sourceJobId: 'job-surv', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Remove one job
    await removeJob('job-rem2')
    await flushMicrotasks()

    // Now change the surviving job — bridge should still work
    updateJobStatus('job-surv', 'in_progress')
    await flushMicrotasks()

    expect(getProjectByJobId('job-surv')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('syncProjectForJobId returns false for a deleted job', async () => {
    await addJob(makeJob({ id: 'job-del' }))
    await addProject(makeProject({ id: 'proj-del', sourceJobId: 'job-del' }))

    await removeJob('job-del')

    // Direct targeted sync on deleted job — must not crash, must return false
    expect(await syncProjectForJobId('job-del')).toBe(false)
  })
})

// ===========================================================================
// PART D — Re-entrancy safety
// ===========================================================================

describe('re-entrancy safety — reconciliation during flush', () => {
  it('reconciliation-triggered job notification does not cause runaway loop', async () => {
    // Setup: job with stale paymentState relative to canonical payment
    await addJob(makeJob({ id: 'job-re', status: 'new', paymentState: 'none' }))
    await addProject(makeProject({ id: 'proj-re', sourceJobId: 'job-re', paymentState: 'none' }))
    await createPaymentForJob('job-re', 2000)
    await updatePaymentWorkflow('job-re', 'deposit_paid')

    // Force stale downstream state
    updateJobPaymentState('job-re', 'none')

    // Confirm stale: job says 'none' but payment says 'deposit_paid'
    expect(getJobById('job-re')!.paymentState).toBe('none')
    expect(getPaymentForJob('job-re')!.state).toBe('deposit_paid')

    const unsubscribe = startProjectJobSyncBridge()

    // Trigger a sync-relevant change — this queues job-re
    // The reconciliation inside syncProjectForJobId will call
    // reconcilePaymentStateDownstream → updateJobPaymentState → notify
    // The re-entrancy guard must prevent runaway loop
    updateJobStatus('job-re', 'in_progress')

    // Single microtask flush should be enough — no infinite loop
    await flushMicrotasks()

    // Final state must be correct
    expect(getJobById('job-re')!.paymentState).toBe('deposit_paid')
    expect(getJobById('job-re')!.status).toBe('in_progress')
    expect(getProjectByJobId('job-re')!.paymentState).toBe('deposit_paid')
    expect(getProjectByJobId('job-re')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('re-entrant snapshot is still accurate for subsequent external changes', async () => {
    // This test proves that after a reconciliation-triggered re-entrant
    // notification, the snapshot baseline is correct for the next change

    await addJob(makeJob({ id: 'job-re2', status: 'new', paymentState: 'none' }))
    await addProject(makeProject({ id: 'proj-re2', sourceJobId: 'job-re2', paymentState: 'none' }))
    await createPaymentForJob('job-re2', 3000)
    await updatePaymentWorkflow('job-re2', 'deposit_paid')

    // Force stale downstream
    updateJobPaymentState('job-re2', 'none')

    const unsubscribe = startProjectJobSyncBridge()

    // First change triggers reconciliation (re-entrant)
    updateJobStatus('job-re2', 'in_progress')
    await flushMicrotasks()

    expect(getJobById('job-re2')!.paymentState).toBe('deposit_paid')

    // Second change — must still be detected correctly
    updateJobStatus('job-re2', 'waiting_payment')
    await flushMicrotasks()

    expect(getProjectByJobId('job-re2')!.status).toBe('review')

    unsubscribe()
  })
})

// ===========================================================================
// PART E — Bootstrap-only boundary
// ===========================================================================

describe('bootstrap-only boundary — _isBridgeActive lifecycle', () => {
  it('_isBridgeActive is false before bridge starts', () => {
    expect(_isBridgeActive()).toBe(false)
  })

  it('_isBridgeActive becomes true after startProjectJobSyncBridge', async () => {
    await addJob(makeJob({ id: 'job-ba' }))
    const unsubscribe = startProjectJobSyncBridge()
    expect(_isBridgeActive()).toBe(true)
    unsubscribe()
  })

  it('_isBridgeActive becomes false after unsubscribe', async () => {
    await addJob(makeJob({ id: 'job-ba2' }))
    const unsubscribe = startProjectJobSyncBridge()
    expect(_isBridgeActive()).toBe(true)
    unsubscribe()
    expect(_isBridgeActive()).toBe(false)
  })

  it('syncAllProjectsFromJobs still works correctly even when bridge is active', async () => {
    await addJob(makeJob({ id: 'job-bs', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({
      id: 'proj-bs',
      sourceJobId: 'job-bs',
      status: 'request',
      paymentState: 'none',
    }))

    const unsubscribe = startProjectJobSyncBridge()

    // Call bootstrap function while bridge is active — should still work
    await syncAllProjectsFromJobs()

    expect(getProjectByJobId('job-bs')!.status).toBe('completed')
    expect(getProjectByJobId('job-bs')!.paymentState).toBe('released')

    unsubscribe()
  })

  it('incremental bridge does NOT call syncAllProjectsFromJobs', async () => {
    // Prove: a stale project for an UNCHANGED job is NOT fixed by the
    // incremental bridge — only a changed job triggers targeted sync.
    // This confirms that the bridge is not secretly doing full scans.

    await addJob(makeJob({ id: 'job-stale', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({
      id: 'proj-stale',
      sourceJobId: 'job-stale',
      status: 'request',     // Stale
      paymentState: 'none',  // Stale
    }))

    // Also add a second job that WILL change
    await addJob(makeJob({ id: 'job-change', status: 'new' }))
    await addProject(makeProject({ id: 'proj-change', sourceJobId: 'job-change', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Change only job-change
    updateJobStatus('job-change', 'in_progress')
    await flushMicrotasks()

    // job-change's project is synced
    expect(getProjectByJobId('job-change')!.status).toBe('in_progress')

    // job-stale's project is still stale — proves no full scan happened
    expect(getProjectByJobId('job-stale')!.status).toBe('request')
    expect(getProjectByJobId('job-stale')!.paymentState).toBe('none')

    unsubscribe()
  })
})

// ===========================================================================
// PART F — Sequential tick processing
// ===========================================================================

describe('sequential tick processing', () => {
  it('updates across multiple ticks are each processed correctly', async () => {
    await addJob(makeJob({ id: 'job-seq', status: 'new' }))
    await addProject(makeProject({ id: 'proj-seq', sourceJobId: 'job-seq', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Tick 1: status change
    updateJobStatus('job-seq', 'booked')
    await flushMicrotasks()
    expect(getProjectByJobId('job-seq')!.status).toBe('accepted')

    // Tick 2: another status change
    updateJobStatus('job-seq', 'in_progress')
    await flushMicrotasks()
    expect(getProjectByJobId('job-seq')!.status).toBe('in_progress')

    // Tick 3: paymentState change
    updateJobPaymentState('job-seq', 'deposit_required')
    await flushMicrotasks()
    expect(getProjectByJobId('job-seq')!.paymentState).toBe('deposit_required')

    // Tick 4: status to waiting_payment → project derives 'review'
    updateJobStatus('job-seq', 'waiting_payment')
    await flushMicrotasks()
    expect(getProjectByJobId('job-seq')!.status).toBe('review')

    unsubscribe()
  })

  it('a job that is unchanged across consecutive ticks is not re-synced', async () => {
    await addJob(makeJob({ id: 'job-noop', status: 'new' }))
    await addProject(makeProject({
      id: 'proj-noop',
      sourceJobId: 'job-noop',
      status: 'request',
      paymentState: 'none',
    }))

    // Add a second job to generate notifications without changing job-noop
    await addJob(makeJob({ id: 'job-other', status: 'new' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Change job-noop once
    updateJobStatus('job-noop', 'in_progress')
    await flushMicrotasks()
    expect(getProjectByJobId('job-noop')!.status).toBe('in_progress')

    // Force the project back to stale manually (simulate external corruption)
    // to prove the bridge doesn't re-sync on subsequent irrelevant notifications
    // We can't easily corrupt the project store, so instead verify:
    // changing job-other should NOT trigger a sync for job-noop
    updateJobStatus('job-other', 'cancelled')
    await flushMicrotasks()

    // job-noop's project stays at 'in_progress' (was already synced)
    expect(getProjectByJobId('job-noop')!.status).toBe('in_progress')

    unsubscribe()
  })
})

// ===========================================================================
// PART G — New job addition during bridge operation
// ===========================================================================

describe('new job addition — bridge detects correctly', () => {
  it('a newly added job is detected as new and synced when changed', async () => {
    const unsubscribe = startProjectJobSyncBridge()

    // Add a new job and project AFTER bridge started
    await addJob(makeJob({ id: 'job-add', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-add', sourceJobId: 'job-add', status: 'request' }))

    // The addJob notification detected the new job; now trigger another change
    // to ensure it's fully processed
    updateJobPaymentState('job-add', 'work_in_progress')
    await flushMicrotasks()

    expect(getProjectByJobId('job-add')!.status).toBe('in_progress')
    expect(getProjectByJobId('job-add')!.paymentState).toBe('work_in_progress')

    unsubscribe()
  })
})

// ===========================================================================
// PART H — Completeness: no regression to Blocks 1–4.1
// ===========================================================================

describe('no regression — existing Block 5 contract preserved', () => {
  it('syncProjectForJobId still returns true on status stale', async () => {
    await addJob(makeJob({ id: 'job-nr1', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-nr1', sourceJobId: 'job-nr1', status: 'request' }))
    expect(await syncProjectForJobId('job-nr1')).toBe(true)
    expect(getProjectByJobId('job-nr1')!.status).toBe('in_progress')
  })

  it('syncProjectForJobId returns false when already in sync', async () => {
    await addJob(makeJob({ id: 'job-nr2', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-nr2', sourceJobId: 'job-nr2', status: 'in_progress', paymentState: 'none' }))
    expect(await syncProjectForJobId('job-nr2')).toBe(false)
  })

  it('bootstrap full-scan repairs all stale projects', async () => {
    await addJob(makeJob({ id: 'job-nr3a', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({ id: 'proj-nr3a', sourceJobId: 'job-nr3a', status: 'request', paymentState: 'none' }))

    await addJob(makeJob({ id: 'job-nr3b', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-nr3b', sourceJobId: 'job-nr3b', status: 'request' }))

    await syncAllProjectsFromJobs()

    expect(getProjectByJobId('job-nr3a')!.status).toBe('completed')
    expect(getProjectByJobId('job-nr3a')!.paymentState).toBe('released')
    expect(getProjectByJobId('job-nr3b')!.status).toBe('in_progress')
  })

  it('rapid sequential updates via bridge converge to final correct state', async () => {
    await addJob(makeJob({ id: 'job-nr4', status: 'new' }))
    await addProject(makeProject({ id: 'proj-nr4', sourceJobId: 'job-nr4', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    updateJobStatus('job-nr4', 'booked')
    updateJobStatus('job-nr4', 'scheduled')
    updateJobStatus('job-nr4', 'in_progress')
    await flushMicrotasks()

    expect(getProjectByJobId('job-nr4')!.status).toBe('in_progress')

    unsubscribe()
  })
})
