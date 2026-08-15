import type { JobStatus } from '../../shared/coreTypes'
import type { Job } from '../types'

/**
 * Optional compare-and-set contract for `JobRepository.update()`.
 *
 * When `expectedStatus` is set, the write must only apply while the
 * persisted row still carries exactly this status
 * (`UPDATE … WHERE id = ? AND status = expectedStatus`).  A mismatch means
 * another writer (webhook, cron, second device) moved the row on since the
 * caller's pre-check — the repository must throw
 * `JobStatusCasConflictError` instead of clobbering the newer row, and must
 * NOT enqueue the stale payload for offline replay (a full-row replay would
 * bypass the CAS).
 *
 * The no-enqueue rule covers EVERY failed CAS write, including transient
 * DB/network errors: the pending-mutation replay path executes a plain
 * `UPDATE … WHERE id = ?` without the status predicate, so any queued
 * payload would later apply unconditionally.  On failure the repository
 * rolls back the optimistic cache, records the failure for observability,
 * and rethrows — the interactive caller retries, which re-reads the
 * current status.
 */
export interface JobUpdateOptions {
  expectedStatus?: JobStatus
}

/**
 * Thrown when a compare-and-set `update()` found the persisted job status
 * diverged from the caller's `expectedStatus`.  Interactive callers surface
 * this to the UI; it must never land in the pending-mutation queue.
 */
export class JobStatusCasConflictError extends Error {
  readonly isJobStatusCasConflict = true

  constructor(jobId: string, expectedStatus: JobStatus) {
    super(`Job ${jobId} status changed concurrently (expected '${expectedStatus}')`)
    this.name = 'JobStatusCasConflictError'
  }
}

export interface JobRepository {
  /**
   * Loads the initial job data from the underlying store.
   * Must be called once during application bootstrap before the repository
   * is registered via `setJobRepository()`.
   * For in-memory implementations this is a no-op.
   */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryJobRepository this is always `true` (data is available at
   * construction time).
   * For SupabaseJobRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  getAll(): Job[]
  getById(id: string): Job | undefined
  saveAll(jobs: Job[]): void
  add(job: Job): Promise<void>
  remove(jobId: string): Promise<void>
  update(
    jobId: string,
    updater: (job: Job) => Job,
    options?: JobUpdateOptions,
  ): Promise<void>
  /**
   * Atomically swap a member id in `assigned_member_ids` for the
   * Owner-driven Springer flow.
   *
   * Semantics (matches the Supabase RPC `reassign_job_member`):
   *   - If `fromMemberId` is in the array, replace it with `toMemberId`.
   *   - If `fromMemberId` is NOT in the array but `toMemberId` is also
   *     missing, append `toMemberId` (idempotent recovery from a partial
   *     failure).
   *   - If `toMemberId` is already present, no duplicate is added.
   *
   * Returns the updated job. Throws when the job is not visible to the
   * caller (RLS / not found) or the Owner-RBAC check fails.
   */
  reassignAssignedMember(
    jobId: string,
    fromMemberId: string,
    toMemberId: string,
  ): Promise<Job>
  subscribe(listener: () => void): () => void
  notify(): void
  reset(): void
}
