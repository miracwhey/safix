import type { CalendarEntry, CalendarEntryStatus } from '../calendarTypes'

/** Options shared by write methods that can be called from passive projection paths. */
export interface CalendarWriteOpts {
  /**
   * When true, the write is a passive projection (e.g. syncCalendarEntriesForJobs,
   * ensureCalendarEntryForJob).  On failure, only `logError` is called — no
   * `recordPersistenceFailure`, no pending-mutation enqueue, no banner escalation.
   * User-initiated writes (updateCalendarStatus, addCustomCalendarEntry, …) must
   * NOT set this flag so their failures remain visible in the SyncStatusBar.
   */
  passive?: boolean
}

export interface CalendarRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  subscribe(listener: () => void): () => void
  getAll(): CalendarEntry[]
  getById(id: string): CalendarEntry | undefined
  getByJobId(jobId: string): CalendarEntry | undefined
  add(entry: CalendarEntry, opts?: CalendarWriteOpts): Promise<void>
  replace(entry: CalendarEntry, opts?: CalendarWriteOpts): Promise<void>
  /**
   * Partial status-only update: sends `{ status, updated_at }` to the DB —
   * never touches provider_id, job_id, or any identity field.  Use this for
   * automated reconciliation (syncCalendarEntriesForJobs) where sending the
   * full row risks RLS WITH CHECK failures on stale or mismatched fields.
   */
  updateStatus(id: string, status: CalendarEntryStatus, opts?: CalendarWriteOpts): Promise<void>
  /**
   * Narrow scheduling update — sends only the three scheduling columns plus
   * `updated_at` to the DB. Identity / ownership fields (provider_id, job_id,
   * assigned_member_ids, status, title, description) are **not** touched, so
   * RLS WITH CHECK clauses on those columns cannot trip.
   *
   * Caller convention: `dateLabel` (the human-readable form) is intentionally
   * not part of this signature — when a caller updates the day, it must keep
   * the label in sync via a separate `replace()` (full-row write) or by
   * deriving the label client-side. For pure time-only updates within the
   * same day, the existing label stays correct.
   *
   * Missing entry: silent no-op, mirroring `replace()` / `updateStatus()`.
   */
  updateScheduling(
    id: string,
    scheduling: { dateKey: string; startsAtLabel: string; endsAtLabel: string },
    opts?: CalendarWriteOpts,
  ): Promise<void>
  /**
   * Awaits every supabase write that add() / replace() kicked off and is still
   * in flight.  Used by `resyncRepositories` to make sure subscriber-driven
   * optimistic writes — fired during the initialize(true) cascade — get a
   * chance to record their failure BEFORE clearPersistenceFailures runs.
   * In-memory implementations have no async writes and may resolve immediately.
   */
  drainInFlightWrites?(maxWaitMs?: number): Promise<void>
}
