/**
 * Time-Entry domain types — Block 2.
 *
 * Worker-driven, automatic time tracking with two parallel timers per member:
 *   - 'day' timer: full work day, no job_id, single-active per member
 *   - 'job' timer: per-job, requires job_id assigned to the member, single-active per member
 *
 * `durationMinutes` is the authoritative field for weekly aggregates. It is set
 * when status flips from 'active' to 'closed' by the workflow layer. While
 * status='active' it is null, and the UI computes a live running duration from
 * `startedAt`.
 *
 * Status transitions:
 *   active  → closed   (worker stops timer; ended_at + duration_minutes set)
 *   closed  → rejected (owner rejects with reason)
 *
 * Mirrors `public.time_entries` migrated 2026-05-07 (Block 2).
 */

export type TimeEntryKind = 'day' | 'job'
export type TimeEntryStatus = 'active' | 'closed' | 'rejected'

export type TimeEntry = {
  id: string
  providerId: string
  memberId: string
  kind: TimeEntryKind
  /** Required when kind === 'job'; null when kind === 'day'. */
  jobId: string | null
  /** ISO timestamp (UTC, from DB). */
  startedAt: string
  /** ISO timestamp; null while status === 'active'. */
  endedAt: string | null
  /** Authoritative; null while status === 'active'. */
  durationMinutes: number | null
  note: string | null
  status: TimeEntryStatus
  /** Required when status === 'rejected' (db CHECK). */
  rejectedReason: string | null
  rejectedBy: string | null
  /**
   * ISO timestamp; stamped by the `time_entries_reject_stamp` trigger on the
   * active/closed→rejected transition (Block 2.1 hardening C3). Null while
   * status !== 'rejected'.
   */
  rejectedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Inputs the workflow needs to start a 'day' timer. */
export type StartDayInput = {
  memberId: string
  providerId: string
  note?: string | null
  /** Override now() in tests. */
  now?: Date
}

/** Inputs the workflow needs to start a 'job' timer. */
export type StartJobInput = {
  memberId: string
  providerId: string
  jobId: string
  note?: string | null
  now?: Date
}
