import type { Absence, AbsenceType } from '../absenceTypes'

/** Inputs the workflow needs to insert a new active absence row. */
export type AbsenceCreateInput = {
  providerId: string
  memberId: string
  type: AbsenceType
  startDate: string
  endDate: string
  reasonNote?: string | null
}

/**
 * Patch applied to an existing absence row. The repository forwards exactly the
 * provided fields; updated_at is set server-side via the trigger.
 */
export type AbsenceUpdatePatch = Partial<{
  status: 'active' | 'cancelled'
  cancelledAt: string | null
  sickNoteRequested: boolean
  sickNoteRequestedAt: string | null
  /** Storage path set when worker submits AU-Bescheinigung. */
  sickNoteUrl: string | null
  sickNoteSubmittedAt: string | null
}>

export class AbsenceNotFoundError extends Error {
  readonly absenceId: string
  constructor(absenceId: string) {
    super(`Absence not found: ${absenceId}`)
    this.name = 'AbsenceNotFoundError'
    this.absenceId = absenceId
  }
}

/**
 * Repository contract for the absence domain — Block 3.
 *
 * Lifecycle mirrors TimeEntryRepository: in-memory cache, async writes
 * (optimistic locally, awaited round-trip), reactive subscribers.
 *
 * Reads are scoped via RLS: workers see their own rows, owners see
 * provider-scoped rows.
 */
export interface AbsenceRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  subscribe(listener: () => void): () => void
  getAll(): Absence[]
  getById(id: string): Absence | undefined
  /**
   * Inserts a new active absence row. Resolves with the canonical row
   * (post-Supabase round-trip) so the workflow can pass an id to the
   * notification fan-out.
   */
  create(input: AbsenceCreateInput): Promise<Absence>
  /**
   * Applies the patch to the absence and resolves with the updated row.
   *
   * Rejects with AbsenceNotFoundError if the row is not visible to the
   * caller (RLS) or no longer present.
   */
  update(id: string, patch: AbsenceUpdatePatch): Promise<Absence>
  reset(): void
}
