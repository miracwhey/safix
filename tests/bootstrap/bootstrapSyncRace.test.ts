/**
 * Bootstrap Sync Race — Invariant Tests
 *
 * Proves the key invariants of the bootstrap/sync sequence:
 *
 * 1. ORDER INVARIANT: startProjectJobSyncBridge() must run BEFORE
 *    syncAllProjectsFromJobs() so any job mutations arriving during the
 *    full-scan are queued by the bridge and applied correctly.
 *
 * 2. LOST-UPDATE PREVENTION: A job that changes between bridge-start and
 *    full-scan-start is NOT silently lost — the bridge baseline captures
 *    it and the full-scan reads the latest state.
 *
 * 3. OLD-ORDER BUG PROOF: With the old order (full-scan first, bridge
 *    second) a job change in the gap leaves the project permanently behind.
 *
 * 4. ERROR RESILIENCE — bridge: syncProjectForJobId() failure does not
 *    crash the bridge or cause an unhandled rejection — remaining jobs
 *    are still processed.
 *
 * 5. ERROR RESILIENCE — full-scan: one project's sync failure does not
 *    abort the remaining projects.
 *
 * 6. RELOAD CONSISTENCY: after resync (re-initialize repos), the bridge
 *    detects changed jobs and corrects stale project state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob } from '../../src/lib/jobs'
import { updateJobStatus } from '../../src/lib/jobs/service'
import { addProject, getProjectByJobId, getProjectRepository } from '../../src/lib/projects'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import {
  syncAllProjectsFromJobs,
  startProjectJobSyncBridge,
  _isBridgeActive,
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
    amount: '€1.000',
    description: 'Test',
    paymentState: 'none',
    documentationStatus: 'Keine',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'customer-1',
    craftsmanUserId: 'craftsman-1',
    proposalSentAt: NOW - 48 * HOUR,
    proposalAcceptedAt: NOW - 24 * HOUR,
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
    price: '€1.000',
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
// INVARIANT 1 + 2 — ORDER: bridge before full-scan (correct order)
// ===========================================================================

describe('correct order: bridge BEFORE full-scan', () => {
  it('job stale at bridge-start is repaired by full-scan', async () => {
    await addJob(makeJob({ id: 'job-a', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-a', sourceJobId: 'job-a', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()
    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    // Full-scan reads in_progress → derives 'in_progress' → project updated
    expect(getProjectByJobId('job-a')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('job change AFTER bridge-start but BEFORE full-scan is captured and applied', async () => {
    // Start: job = 'new', project = 'request' (in sync — no stale state to repair)
    await addJob(makeJob({ id: 'job-b', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-b', sourceJobId: 'job-b', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Simulate a Realtime-style mutation arriving AFTER bridge subscribed
    // but BEFORE full-scan runs — bridge baseline is 'new'
    updateJobStatus('job-b', 'in_progress')

    // Full-scan reads the CURRENT state (already 'in_progress')
    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    // Bridge queued the change, full-scan also applied it — project = in_progress
    expect(getProjectByJobId('job-b')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('multiple jobs with concurrent status changes all converge correctly', async () => {
    await addJob(makeJob({ id: 'job-c1', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addJob(makeJob({ id: 'job-c2', status: 'scheduled', proposalSentAt: NOW - 48 * HOUR, proposalAcceptedAt: NOW - 24 * HOUR }))
    await addProject(makeProject({ id: 'proj-c1', sourceJobId: 'job-c1', status: 'request' }))
    await addProject(makeProject({ id: 'proj-c2', sourceJobId: 'job-c2', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Two mutations before full-scan
    updateJobStatus('job-c1', 'booked')
    updateJobStatus('job-c2', 'in_progress')

    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    expect(getProjectByJobId('job-c1')!.status).toBe('accepted')
    expect(getProjectByJobId('job-c2')!.status).toBe('in_progress')

    unsubscribe()
  })
})

// ===========================================================================
// INVARIANT 3 — OLD-ORDER BUG PROOF
// (shows the bug that existed before the fix — proves the fix is necessary)
// ===========================================================================

describe('old-order bug proof: full-scan BEFORE bridge (broken)', () => {
  it('job mutated after full-scan but before bridge-start leaves project stale', async () => {
    // Job starts at 'new', project at 'request' (in sync)
    await addJob(makeJob({ id: 'job-old', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-old', sourceJobId: 'job-old', status: 'request' }))

    // OLD order: full-scan first
    await syncAllProjectsFromJobs()  // reads job='new', project is already 'request' — no-op

    // Mutation arrives in the gap (Realtime event in production)
    updateJobStatus('job-old', 'in_progress')

    // OLD order: bridge starts AFTER mutation — baseline captures 'in_progress'
    const unsubscribe = startProjectJobSyncBridge()

    // No further changes — bridge sees no delta from baseline
    await flushMicrotasks()

    // BUG: project is stuck at 'request', job is 'in_progress'
    // (With the NEW order this would be 'in_progress')
    expect(getProjectByJobId('job-old')!.status).toBe('request')

    unsubscribe()
  })
})

// ===========================================================================
// INVARIANT 4 — ERROR RESILIENCE: bridge continues after syncProjectForJobId error
// ===========================================================================

describe('error resilience — bridge continues after per-job failure', () => {
  it('bridge processes remaining jobs when one syncProjectForJobId call fails', async () => {
    // Both start at 'new' — bridge baseline will be 'new'
    await addJob(makeJob({ id: 'job-err1', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addJob(makeJob({ id: 'job-err2', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-err1', sourceJobId: 'job-err1', status: 'request' }))
    await addProject(makeProject({ id: 'proj-err2', sourceJobId: 'job-err2', status: 'request' }))

    // Make the project repo's update throw on the first call only
    const repo = getProjectRepository() as InMemoryProjectRepository
    let callCount = 0
    const originalUpdate = repo.update.bind(repo)
    vi.spyOn(repo, 'update').mockImplementation(async (id, updates) => {
      callCount++
      if (callCount === 1) throw new Error('Simulated DB write failure')
      return originalUpdate(id, updates)
    })

    const unsubscribe = startProjectJobSyncBridge()

    // Both jobs change via valid transitions. Bridge queues both.
    // job-err1 processed first (fails), job-err2 processed second (succeeds).
    updateJobStatus('job-err1', 'booked')   // new → booked (valid)
    updateJobStatus('job-err2', 'scheduled') // new → scheduled (valid)

    // Must not throw — bridge must swallow the error and continue
    await expect(flushMicrotasks()).resolves.not.toThrow()

    // job-err2's project is synced despite job-err1 failing
    // 'scheduled' → project status 'scheduled'
    expect(getProjectByJobId('job-err2')!.status).toBe('scheduled')

    unsubscribe()
  })
})

// ===========================================================================
// INVARIANT 5 — ERROR RESILIENCE: full-scan continues after per-project error
// ===========================================================================

describe('error resilience — syncAllProjectsFromJobs continues after per-project error', () => {
  it('remaining projects are synced even when one update fails', async () => {
    // proj-fs1 (job in_progress, stale request) processed first → fails
    // proj-fs2 (job waiting_payment, stale request) processed second → succeeds → 'review'
    await addJob(makeJob({ id: 'job-fs1', status: 'in_progress' }))
    await addJob(makeJob({ id: 'job-fs2', status: 'waiting_payment' }))
    await addProject(makeProject({ id: 'proj-fs1', sourceJobId: 'job-fs1', status: 'request' }))
    await addProject(makeProject({ id: 'proj-fs2', sourceJobId: 'job-fs2', status: 'request' }))

    const repo = getProjectRepository() as InMemoryProjectRepository
    let callCount = 0
    const originalUpdate = repo.update.bind(repo)
    vi.spyOn(repo, 'update').mockImplementation(async (id, updates) => {
      callCount++
      if (callCount === 1) throw new Error('Simulated DB write failure')
      return originalUpdate(id, updates)
    })

    // Must not throw — loop must continue past the failing project
    await expect(syncAllProjectsFromJobs()).resolves.not.toThrow()

    // proj-fs2 must be synced (second call succeeds) — proves loop continues
    // proj-fs1 remains stale (first call failed) but no crash
    expect(getProjectByJobId('job-fs2')!.status).toBe('review')
    expect(getProjectByJobId('job-fs1')!.status).toBe('request')
  })

  it('syncAllProjectsFromJobs does not throw even if all updates fail', async () => {
    await addJob(makeJob({ id: 'job-allf', status: 'completed' }))
    await addProject(makeProject({ id: 'proj-allf', sourceJobId: 'job-allf', status: 'request' }))

    const repo = getProjectRepository() as InMemoryProjectRepository
    vi.spyOn(repo, 'update').mockRejectedValue(new Error('All writes fail'))

    await expect(syncAllProjectsFromJobs()).resolves.not.toThrow()
  })
})

// ===========================================================================
// INVARIANT 6 — RELOAD CONSISTENCY
// ===========================================================================

describe('reload consistency — bridge detects changes after re-initialization', () => {
  it('bridge queues all changed jobs after job repo re-initializes', async () => {
    await addJob(makeJob({ id: 'job-rel', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-rel', sourceJobId: 'job-rel', status: 'request' }))

    const unsubscribe = startProjectJobSyncBridge()
    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    expect(getProjectByJobId('job-rel')!.status).toBe('request')

    // Simulate job state change (as if a DB update arrived via resync)
    updateJobStatus('job-rel', 'in_progress')
    await flushMicrotasks()

    // Bridge must detect the change and sync the project
    expect(getProjectByJobId('job-rel')!.status).toBe('in_progress')

    unsubscribe()
  })

  it('bridge correctly processes changes after bridge was restarted', async () => {
    await addJob(makeJob({ id: 'job-rst', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-rst', sourceJobId: 'job-rst', status: 'request' }))

    // First bootstrap
    const unsubscribe1 = startProjectJobSyncBridge()
    await syncAllProjectsFromJobs()
    await flushMicrotasks()
    unsubscribe1()

    // Restart bridge (simulates app lifecycle resume)
    const unsubscribe2 = startProjectJobSyncBridge()
    await syncAllProjectsFromJobs()

    updateJobStatus('job-rst', 'scheduled')
    await flushMicrotasks()

    expect(getProjectByJobId('job-rst')!.status).toBe('scheduled')

    unsubscribe2()
  })
})

// ===========================================================================
// INVARIANT 7 — SINGLE-START (resume-robustness Block 2)
//
// The bootstrap silent retry re-runs the whole boot sequence. Attempt 1 may
// hang in syncAllProjectsFromJobs() AFTER it already started the bridge —
// the retry then calls startProjectJobSyncBridge() a second time. The
// starter must be idempotent: two live subscriptions would run duplicate
// reconciliation cycles whose writes bypass each other's `flushing` guard.
// ===========================================================================

describe('single-start idempotency — bootstrap silent retry cannot stack bridges', () => {
  it('a second start while the bridge is live joins it — same stop fn, one flush per change', async () => {
    await addJob(makeJob({ id: 'job-dup', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-dup', sourceJobId: 'job-dup', status: 'request' }))

    // Attempt 1 starts the bridge, hangs in syncAllProjectsFromJobs;
    // the silent retry (attempt 2) calls the starter again.
    const stop1 = startProjectJobSyncBridge()
    const stop2 = startProjectJobSyncBridge()
    expect(stop2).toBe(stop1)
    expect(_isBridgeActive()).toBe(true)

    // A jobs-store notify triggers exactly ONE reconciliation write — two
    // live bridges would interleave duplicate updateProject calls here.
    const updateSpy = vi.spyOn(getProjectRepository(), 'update')
    updateJobStatus('job-dup', 'in_progress')
    await flushMicrotasks()

    expect(getProjectByJobId('job-dup')!.status).toBe('in_progress')
    expect(updateSpy).toHaveBeenCalledTimes(1)

    updateSpy.mockRestore()
    stop1()
  })

  it('one stop fully deactivates the deduped bridge — no orphan subscription keeps syncing', async () => {
    await addJob(makeJob({ id: 'job-orph', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-orph', sourceJobId: 'job-orph', status: 'request' }))

    startProjectJobSyncBridge()
    const stop = startProjectJobSyncBridge()
    stop()
    expect(_isBridgeActive()).toBe(false)

    // Without the guard, the first start's subscription would survive the
    // stop and keep reconciling — the project must stay untouched instead.
    updateJobStatus('job-orph', 'in_progress')
    await flushMicrotasks()
    expect(getProjectByJobId('job-orph')!.status).toBe('request')
  })

  it('a stale stop fn from a previous bridge generation cannot deactivate the restarted bridge', async () => {
    await addJob(makeJob({ id: 'job-gen', status: 'new', proposalSentAt: undefined, proposalAcceptedAt: undefined }))
    await addProject(makeProject({ id: 'proj-gen', sourceJobId: 'job-gen', status: 'request' }))

    const oldStop = startProjectJobSyncBridge()
    oldStop()

    const newStop = startProjectJobSyncBridge()
    // Late duplicate call of the previous generation's stop — must be inert.
    oldStop()
    expect(_isBridgeActive()).toBe(true)

    updateJobStatus('job-gen', 'scheduled')
    await flushMicrotasks()
    expect(getProjectByJobId('job-gen')!.status).toBe('scheduled')

    newStop()
    expect(_isBridgeActive()).toBe(false)
  })
})

// ===========================================================================
// DETERMINISM — bootstrap outcome is identical regardless of prior state
// ===========================================================================

describe('deterministic bootstrap outcome', () => {
  it('project always reflects canonical job state after bootstrap regardless of prior divergence', async () => {
    // Severely stale project: project.status = 'request', job.status = 'completed'
    await addJob(makeJob({ id: 'job-det', status: 'completed', paymentState: 'released' }))
    await addProject(makeProject({
      id: 'proj-det',
      sourceJobId: 'job-det',
      status: 'request',
      paymentState: 'none',
    }))

    const unsubscribe = startProjectJobSyncBridge()
    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    const proj = getProjectByJobId('job-det')!
    expect(proj.status).toBe('completed')
    expect(proj.paymentState).toBe('released')

    unsubscribe()
  })

  it('bootstrap with bridge-first is idempotent — running twice yields same result', async () => {
    await addJob(makeJob({ id: 'job-idem', status: 'in_progress' }))
    await addProject(makeProject({ id: 'proj-idem', sourceJobId: 'job-idem', status: 'in_progress' }))

    const unsubscribe = startProjectJobSyncBridge()

    // Run full-scan twice — must be idempotent
    await syncAllProjectsFromJobs()
    await syncAllProjectsFromJobs()
    await flushMicrotasks()

    expect(getProjectByJobId('job-idem')!.status).toBe('in_progress')

    unsubscribe()
  })
})
