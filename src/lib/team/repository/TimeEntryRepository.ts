import type { TimeEntry, TimeEntryKind, TimeEntryStatus } from '../timeEntryTypes'

/**
 * Inputs for creating a new active time-entry.
 * The repository fills in `id`, `createdAt`, `updatedAt`, and `status='active'`.
 */
export type TimeEntryCreateInput = {
  providerId: string
  memberId: string
  kind: TimeEntryKind
  /** Required when kind === 'job'. */
  jobId: string | null
  startedAt: string
  note?: string | null
}

/**
 * Patch applied to an existing entry. The repository forwards exactly the
 * provided fields and updates `updatedAt` server-side via the trigger.
 */
export type TimeEntryUpdatePatch = Partial<{
  status: TimeEntryStatus
  endedAt: string | null
  durationMinutes: number | null
  note: string | null
  rejectedReason: string | null
  rejectedBy: string | null
}>

/** Errors a workflow may want to handle specifically. */
export class TimeEntryActiveConflictError extends Error {
  readonly kind: TimeEntryKind
  constructor(kind: TimeEntryKind) {
    super(`Active timer of kind '${kind}' already exists for member`)
    this.name = 'TimeEntryActiveConflictError'
    this.kind = kind
  }
}

export class TimeEntryNotFoundError extends Error {
  readonly entryId: string
  constructor(entryId: string) {
    super(`Time-entry not found: ${entryId}`)
    this.name = 'TimeEntryNotFoundError'
    this.entryId = entryId
  }
}

/**
 * Repository contract for the time-entry domain — Block 2.
 *
 * Mirrors the conventions established by TeamMemberRepository / CalendarRepository:
 *   - `initialize()` is awaited at bootstrap
 *   - synchronous reads via in-memory cache
 *   - reactive subscribers via `subscribe()`
 *   - writes optimistic locally, async to the persistence layer
 *
 * Distinct from those repositories: writes return Promises that reject on
 * conflict (e.g. unique-active-timer index violation) so the workflow layer
 * can surface a clean "Tag läuft bereits" message instead of silently
 * losing a row.
 */
export interface TimeEntryRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  subscribe(listener: () => void): () => void
  getAll(): TimeEntry[]
  getById(id: string): TimeEntry | undefined
  /**
   * Inserts a new active entry. Resolves with the canonical entry
   * (post-Supabase round-trip) so callers can use server-assigned defaults.
   *
   * Rejects with `TimeEntryActiveConflictError` if the unique partial index
   * (`time_entries_active_{day,job}_unique`) blocks the insert.
   */
  create(input: TimeEntryCreateInput): Promise<TimeEntry>
  /**
   * Applies the patch to the entry and resolves with the updated row.
   *
   * Rejects with `TimeEntryNotFoundError` when the row is not visible to
   * the caller (RLS) or not present.
   */
  update(id: string, patch: TimeEntryUpdatePatch): Promise<TimeEntry>
  /** Resets in-memory state. Mostly meaningful for InMemory implementations. */
  reset(): void
}
