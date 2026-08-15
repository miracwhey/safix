/**
 * Canonical worker/employee Start-tab types.
 *
 * Block A had these co-located with their components; Block B moves them here
 * so the projection layer can import them without introducing circular
 * dependencies between lib/ and components/.
 */

/**
 * Operative state of the worker's day, derived from real CalendarEntry data.
 *
 * Omitted states compared to the Block A draft:
 * - `assignment_paused` — no real pause mechanism exists in the domain
 */
export type WorkerDayState =
  | 'not_started'           // Scheduled entries today, none started or completed yet
  | 'workday_no_assignment' // At least one completed today, more scheduled ahead
  | 'assignment_active'     // An entry is currently in_progress
  | 'assignment_open_item'  // All today done; last job has open documentation
  | 'workday_calm'          // No entries today (calm or day off)
  | 'day_complete'          // All today entries completed, docs closed

export type AssignmentSnapshot = {
  /** CalendarEntry.id — used for cross-tab navigation targets. */
  entryId: string
  title: string
  customer: string
  location: string
  /** Formatted as "HH:MM – HH:MM" */
  timeWindow: string
  /**
   * Minutes since assignment started.
   * Only set when it can be computed from real state (currently never, since
   * CalendarEntry has no startedAt timestamp).
   */
  runningMinutes?: number
  /**
   * Human-readable date label (e.g. "Donnerstag, 9. April").
   * Present only for future-day entries (workday_calm next assignment).
   */
  date?: string
}

/**
 * Quick actions available from the Start tab.
 *
 * Only actions backed by a real domain command are included:
 * - start_assignment → updateCalendarStatus(entry, 'in_progress')
 * - close_assignment → updateCalendarStatus(entry, 'awaiting_payment')
 *
 * Omitted: pause, resume, report_arrival, report_problem, get_signature,
 * continue_doku, start_workday, end_workday — no real commands or
 * worker-safe routes exist for these yet.
 */
export type WorkerQuickAction =
  | 'start_assignment'
  | 'close_assignment'

export type OpenItem = {
  id: string
  /** CalendarEntry.id — navigation target for this open item. */
  entryId: string
  label: string
  kind: 'doku' | 'signature' | 'report' | 'time' | 'feedback'
  assignmentTitle?: string
  urgent?: boolean
  /** 'previous' items get a badge; 'today' needs no label */
  fromDate?: 'today' | 'previous'
}

export type DaySummary = {
  total: number
  done: number
  remaining: number
}

export type DayHint = {
  id: string
  text: string
  from?: string
  receivedAt?: string
}
