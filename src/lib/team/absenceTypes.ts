/**
 * Absence domain types — Block 3.
 *
 * Worker-driven sick / vacation tracking. Active rows feed the Owner-Hub
 * Krank-Badge + Springer flow; cancelled rows are history.
 *
 * Date semantics:
 *   - startDate / endDate are calendar-day strings (YYYY-MM-DD), no time.
 *   - A single-day absence has startDate === endDate.
 *   - "Day N" presentation is computed against the local todayKey.
 *
 * Mirrors public.absences migrated 2026-05-07 (Block 3).
 */

export type AbsenceType = 'sick' | 'vacation' | 'other'
export type AbsenceStatus = 'active' | 'cancelled'

export type Absence = {
  id: string
  providerId: string
  memberId: string
  type: AbsenceType
  /** Calendar day (YYYY-MM-DD), inclusive. */
  startDate: string
  /** Calendar day (YYYY-MM-DD), inclusive. */
  endDate: string
  reasonNote: string | null
  status: AbsenceStatus
  sickNoteRequested: boolean
  /** ISO timestamp; set when sickNoteRequested flips to true. */
  sickNoteRequestedAt: string | null
  /** Supabase Storage path (sick-notes bucket) of the uploaded AU-Bescheinigung. */
  sickNoteUrl: string | null
  /** ISO timestamp; set when sick_note_url is first uploaded. */
  sickNoteSubmittedAt: string | null
  /** ISO timestamp; set when status flips to 'cancelled'. */
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

/** Inputs the workflow needs to report a new active absence. */
export type ReportAbsenceInput = {
  memberId: string
  providerId: string
  type: AbsenceType
  startDate: string
  endDate: string
  reasonNote?: string | null
  /** Override now() in tests. */
  now?: Date
}
