/**
 * Project-Job Sync Bridge
 *
 * Block 5 — Sync Bridge Efficiency
 * Block 5.1 — Completeness, snapshot integrity, edge-case coverage
 *
 * Keeps project status in sync with job state through two distinct paths:
 *
 * 1. **Bootstrap (full scan)** — `syncAllProjectsFromJobs()` runs once after
 *    repositories are initialised. It iterates every project/job pair to
 *    repair any stale state left by a prior partial-success sync.  This is
 *    the ONLY path that does a full scan — it is explicitly bootstrap-only.
 *
 * 2. **Incremental (targeted)** — `startProjectJobSyncBridge()` subscribes
 *    to job-store changes, detects which job IDs actually changed since the
 *    last notification, and calls `syncProjectForJobId()` only for those
 *    jobs.  Unrelated projects are never processed.
 *
 * Rapid-trigger safety: when multiple job-store notifications fire within
 * the same microtask (e.g. cascaded writes), pending job IDs are collected
 * into a Set and flushed once via `queueMicrotask`, preventing redundant
 * back-to-back syncs for the same context.
 *
 * Re-entrancy safety (Block 5.1): during a flush cycle, the bridge may
 * trigger additional job-store notifications (e.g. via
 * `reconcilePaymentStateDownstream`).  A `flushing` guard prevents these
 * nested notifications from queueing extra sync work — the snapshot is
 * still updated so the diff stays correct for the next external change.
 *
 * Block 2.1: Also reconciles canonical payment state into downstream
 * job/project fields when stale divergence is detected.
 */

import { getJobs, getJobById, subscribeJobs } from '../jobs/jobsStore'
import { getProjectByJobId, getProjects, updateProject } from '../projects/projectsStore'
import { isProjectStatusStale, syncProjectFromJob } from '../projects/projectStatusSync'
import { reconcilePaymentStateDownstream } from '../workflow/paymentWorkflow'
import { getPaymentForJob } from '../payments/service'
import { logInfo, logError } from '../observability'
import type { Job } from '../jobs/types'

// ---------------------------------------------------------------------------
// Module-level bridge state
// ---------------------------------------------------------------------------

/**
 * Tracks whether the incremental bridge is currently active.
 * Set to `true` by `startProjectJobSyncBridge()`, reset by its unsubscribe.
 * Exposed via `_isBridgeActive()` for testing.
 */
let _bridgeActive = false

/**
 * Stop function of the live bridge, or `null` when no bridge is running.
 * Idempotency slot (resume-robustness Block 2): the bootstrap silent retry
 * re-runs the whole boot sequence, and attempt 1 may already have started
 * the bridge before hanging in `syncAllProjectsFromJobs()`. A second
 * `startProjectJobSyncBridge()` must NOT create a second jobs-store
 * subscription — two live bridges would run duplicate reconciliation cycles
 * whose writes bypass each other's per-closure `flushing` guard (racing
 * duplicate `updateProject` writes). Same single-start contract as
 * `startNotificationBridge` and `startOutboxRunner`.
 */
let activeStop: (() => void) | null = null

/** @internal Exposed for testing — returns whether the incremental bridge is active. */
export function _isBridgeActive(): boolean {
  return _bridgeActive
}

// ---------------------------------------------------------------------------
// Snapshot helpers — used by the incremental bridge to detect changed jobs
// ---------------------------------------------------------------------------

/**
 * Captures the sync-relevant fields of a job for change detection.
 *
 * These fields — and ONLY these fields — determine whether a job change
 * requires a project sync.  The contract is derived from the downstream
 * functions that the bridge calls:
 *
 * - `deriveProjectStatusFromJob(job)` reads: `status`, `proposalSentAt`,
 *   `proposalAcceptedAt`
 * - `syncProjectFromJob(job)` additionally copies: `paymentState`
 *
 * Fields intentionally EXCLUDED (do NOT affect project sync):
 *   title, customer, location, dateLabel, amount, description,
 *   documentationStatus, assignedMemberIds, notes, photoCount, activities,
 *   providerId, craftsmanUserId, customerUserId, intakeContext,
 *   proposalTimingNote, workCompletedAt, paymentReleasedAt, disputeStatus,
 *   sourceConversationId, sourceOfferId
 *
 * Changing any excluded field does NOT trigger an incremental project sync.
 * This is by design — those fields have no effect on `project.status` or
 * `project.paymentState`.
 */
export interface JobSnapshot {
  /** Job lifecycle status — primary input to `deriveProjectStatusFromJob`. */
  status: Job['status']
  /** Payment state — copied directly to `project.paymentState` by `syncProjectFromJob`. */
  paymentState: Job['paymentState']
  /** Proposal sent timestamp — affects proposal lifecycle stage derivation. */
  proposalSentAt?: number
  /** Proposal accepted timestamp — affects proposal lifecycle stage derivation. */
  proposalAcceptedAt?: number
}

/** @internal Exported for testing — captures a snapshot of sync-relevant fields. */
export function takeSnapshot(job: Job): JobSnapshot {
  return {
    status: job.status,
    paymentState: job.paymentState,
    proposalSentAt: job.proposalSentAt,
    proposalAcceptedAt: job.proposalAcceptedAt,
  }
}

/** @internal Exported for testing — returns true when any sync-relevant field differs. */
export function snapshotChanged(a: JobSnapshot, b: JobSnapshot): boolean {
  return (
    a.status !== b.status ||
    a.paymentState !== b.paymentState ||
    a.proposalSentAt !== b.proposalSentAt ||
    a.proposalAcceptedAt !== b.proposalAcceptedAt
  )
}

function buildSnapshotMap(jobs: Job[]): Map<string, JobSnapshot> {
  const map = new Map<string, JobSnapshot>()
  for (const job of jobs) {
    map.set(job.id, takeSnapshot(job))
  }
  return map
}

// ---------------------------------------------------------------------------
// Targeted single-context sync
// ---------------------------------------------------------------------------

/**
 * Syncs the project linked to a specific job.
 *
 * This is the targeted replacement for the old full-scan path on incremental
 * changes.  It processes exactly one project (the one whose `sourceJobId`
 * matches `jobId`) and, if a canonical payment record exists, reconciles
 * stale downstream payment state.
 *
 * Returns `true` if any sync work was performed.
 *
 * When the job does not exist (e.g. after deletion) or has no linked project,
 * the function returns `false` without error — the project retains its last
 * known state.  This is intentional: a deleted job provides no state to
 * derive from, so the project cannot be updated.
 */
export async function syncProjectForJobId(jobId: string): Promise<boolean> {
  const job = getJobById(jobId)
  if (!job) return false

  const project = getProjectByJobId(jobId)
  if (!project) return false

  let didWork = false

  // Check both status derivation AND direct paymentState divergence.
  // Block 5.1: paymentState divergence is checked independently of status
  // so that a paymentState-only change on the job is always propagated
  // to the linked project, even when the derived status already matches.
  const statusStale = isProjectStatusStale(project, job)
  const paymentStateStale = project.paymentState !== job.paymentState

  // Use canonical payment state when available to avoid writing stale
  // job-mirror state to the project only to immediately overwrite it.
  const payment = getPaymentForJob(job.id)
  const canonicalPaymentState = payment?.state

  if (statusStale || paymentStateStale) {
    const updates = syncProjectFromJob(job, canonicalPaymentState)
    await updateProject(project.id, updates)
    didWork = true
  }

  // Additionally reconcile canonical payment truth if the job or project
  // still diverges from the canonical payment record (e.g. after a
  // partial-failure sync).
  if (payment) {
    const jobStale = job.paymentState !== payment.state
    const projectStale = project.paymentState !== payment.state

    if (jobStale || projectStale) {
      await reconcilePaymentStateDownstream(job.id)
      didWork = true
    }
  }

  return didWork
}

// ---------------------------------------------------------------------------
// Bootstrap full-scan (unchanged semantics, explicit bootstrap-only intent)
// ---------------------------------------------------------------------------

/**
 * Syncs all projects with their source jobs on first load.
 *
 * **Bootstrap-only** — must NOT be called on incremental job changes.
 * For incremental sync use `syncProjectForJobId()` instead.
 *
 * Intended to be called AFTER `startProjectJobSyncBridge()` has started,
 * so any Realtime events that arrive during the full-scan are already
 * queued by the bridge and applied after the scan completes.
 *
 * Per-project errors are caught and logged individually — a single
 * write failure does not abort the remaining projects.
 *
 * Also runs reconcilePaymentStateDownstream() for any job that has a
 * canonical payment record, so stale downstream payment state left by
 * a prior partial-success sync is repaired deterministically on reload.
 */
export async function syncAllProjectsFromJobs(): Promise<void> {
  const jobs = getJobs()
  const projects = getProjects()

  let syncCount = 0
  let reconcileCount = 0

  for (const project of projects) {
    if (!project.sourceJobId) continue

    const job = jobs.find((j) => j.id === project.sourceJobId)
    if (!job) continue

    try {
      // Block 5.1: check both status AND paymentState divergence independently
      const statusStale = isProjectStatusStale(project, job)
      const paymentStateStale = project.paymentState !== job.paymentState

      // Use canonical payment state when available to avoid writing stale
      // job-mirror state to the project only to immediately overwrite it.
      const payment = getPaymentForJob(job.id)
      const canonicalPaymentState = payment?.state

      if (statusStale || paymentStateStale) {
        const updates = syncProjectFromJob(job, canonicalPaymentState)
        await updateProject(project.id, updates)
        syncCount++
      }

      if (payment) {
        const jobStale = job.paymentState !== payment.state
        const projectStale = project.paymentState !== payment.state

        if (jobStale || projectStale) {
          await reconcilePaymentStateDownstream(job.id)
          reconcileCount++
        }
      }
    } catch (err) {
      logError(
        'bootstrap.project_sync_failed',
        err instanceof Error ? err : new Error(String(err)),
        { projectId: project.id, jobId: project.sourceJobId },
      )
    }
  }

  if (syncCount > 0 || reconcileCount > 0) {
    logInfo('bootstrap.project_sync', {
      syncedCount: syncCount,
      reconcileCount,
      totalProjects: projects.length,
    })
  }
}

// ---------------------------------------------------------------------------
// Incremental bridge — targeted, deduplicated, context-scoped
// ---------------------------------------------------------------------------

/**
 * Subscribes to job-store changes and syncs **only the affected project
 * context(s)** on each notification.
 *
 * Architecture:
 * - Maintains a snapshot map of sync-relevant fields for every known job.
 * - On each job-store notification, diffs current jobs against the snapshot
 *   to identify which job IDs actually changed (or were added).
 * - Collects changed IDs into a pending Set and schedules a single flush
 *   via `queueMicrotask` — this deduplicates rapid back-to-back triggers.
 * - The flush calls `syncProjectForJobId(id)` for each pending ID.
 *
 * Re-entrancy safety (Block 5.1):
 * - During a flush, the bridge may trigger additional job-store notifications
 *   via `reconcilePaymentStateDownstream`.  A `flushing` guard suppresses
 *   queueing during those nested notifications.  The snapshot is still
 *   updated so the next external diff is accurate.
 *
 * Removed jobs:
 * - When a job disappears from the store, it is no longer in the snapshot.
 *   The bridge does NOT queue removed jobs for sync because
 *   `syncProjectForJobId(id)` would return false (no job to derive state
 *   from).  The linked project retains its last known state.  This is
 *   intentional — stale-after-deletion recovery is deferred to the
 *   bootstrap-only full-scan path (`syncAllProjectsFromJobs()`).
 *
 * Call this once during bootstrap, BEFORE `syncAllProjectsFromJobs()`, so
 * that any Realtime job mutations arriving during the full-scan are captured
 * and applied by the bridge after the scan completes.
 *
 * Safe to call multiple times — while a bridge is live, subsequent calls
 * return the existing stop function instead of starting a second bridge.
 */
export function startProjectJobSyncBridge(): () => void {
  // Idempotent: while a bridge is live, repeated starts (bootstrap silent
  // retry after a hang PAST the bridge-start checkpoint) join the existing
  // bridge instead of stacking a second subscription.
  if (activeStop) return activeStop

  _bridgeActive = true

  let previousSnapshot = buildSnapshotMap(getJobs())

  // --- Microtask deduplication state ---
  const pendingJobIds = new Set<string>()
  let flushScheduled = false

  // --- Re-entrancy guard (Block 5.1) ---
  // Set to true while flushPendingSync is executing.  Job-store
  // notifications that fire during the flush (e.g. from reconciliation
  // writes) still update the snapshot but do NOT queue new sync work.
  let flushing = false

  async function flushPendingSync(): Promise<void> {
    flushing = true
    flushScheduled = false
    if (pendingJobIds.size === 0) {
      flushing = false
      return
    }

    const ids = [...pendingJobIds]
    pendingJobIds.clear()

    let syncCount = 0
    for (const jobId of ids) {
      try {
        if (await syncProjectForJobId(jobId)) {
          syncCount++
        }
      } catch (err) {
        logError(
          'bridge.incremental_sync_failed',
          err instanceof Error ? err : new Error(String(err)),
          { jobId },
        )
      }
    }

    flushing = false

    if (syncCount > 0) {
      logInfo('bridge.incremental_sync', {
        changedJobIds: ids,
        syncedCount: syncCount,
      })
    }
  }

  function scheduleFlush(): void {
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(flushPendingSync)
    }
  }

  const unsubscribe = subscribeJobs(() => {
    const currentJobs = getJobs()
    const currentSnapshot = buildSnapshotMap(currentJobs)

    // Only detect changes and queue sync work when NOT in a flush cycle.
    // During flush, job-store notifications are side effects of the bridge's
    // own reconciliation writes — the snapshot update below keeps the diff
    // accurate for the next external change, but we must not re-queue work
    // that is already being handled.
    if (!flushing) {
      // Detect changed / added jobs.
      // Removed jobs are intentionally NOT queued: syncProjectForJobId would
      // return false (no job to derive state from) so the project retains its
      // last known state.  Stale-after-deletion recovery is delegated to the
      // bootstrap-only full-scan path.
      for (const [jobId, snap] of currentSnapshot) {
        const prev = previousSnapshot.get(jobId)
        if (!prev || snapshotChanged(prev, snap)) {
          pendingJobIds.add(jobId)
        }
      }
    }

    // Always update the snapshot — even during flush — so the diff baseline
    // stays accurate for the next subscriber invocation.
    previousSnapshot = currentSnapshot

    if (!flushing && pendingJobIds.size > 0) {
      scheduleFlush()
    }
  })

  let stopped = false
  const stop = (): void => {
    // One-shot: a stale stop fn (kept by a caller from before a restart)
    // must neither double-unsubscribe nor deactivate a newer live bridge.
    if (stopped) return
    stopped = true
    unsubscribe()
    pendingJobIds.clear()
    flushScheduled = false
    if (activeStop === stop) {
      activeStop = null
      _bridgeActive = false
    }
  }
  activeStop = stop
  return stop
}
