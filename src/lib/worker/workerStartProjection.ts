/**
 * Worker Start-tab view model projection.
 *
 * Pure function: maps real CalendarEntry + Job state into the flat ViewModel
 * that WorkerHomeScreen renders. No side effects, no store access.
 *
 * State derivation priority (first match wins):
 * 1. in_progress entry today          → assignment_active
 * 2. (completed | awaiting_payment) + scheduled today → workday_no_assignment
 * 3. (completed | awaiting_payment) only, open docs  → assignment_open_item
 * 4. (completed | awaiting_payment) only, docs closed → day_complete
 * 5. scheduled only today             → not_started
 * 6. no entries today                 → workday_calm
 */

import { formatDateKey } from '../calendar/calendarEngine'
import type { CalendarEntry } from '../calendar/calendarTypes'
import type { Job } from '../jobs/types'
import type {
  AssignmentSnapshot,
  DayHint,
  DaySummary,
  OpenItem,
  WorkerDayState,
} from './types'

export type WorkerStartViewModel = {
  dayState: WorkerDayState
  currentAssignment: AssignmentSnapshot | null
  nextAssignment: AssignmentSnapshot | null
  openItems: OpenItem[]
  summary: DaySummary
  /** Always empty — no real hint source exists in the current domain. */
  hints: DayHint[]
  /** YYYY-MM-DD key for today — used by action handlers to locate entries. */
  todayKey: string
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function toSnapshot(entry: CalendarEntry): AssignmentSnapshot {
  return {
    entryId: entry.id,
    title: entry.title,
    customer: entry.customerName,
    location: entry.location,
    timeWindow: `${entry.startsAtLabel}\u2013${entry.endsAtLabel}`,
  }
}

function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(year, month - 1, day))
}


/**
 * Returns true when a job's documentation is not yet complete.
 * Mirrors the Doku projection completeness check (workerDokuProjection):
 *   fotosComplete   = photoCount > 0
 *   berichtComplete = job_reports exist for this job
 *   isComplete      = fotosComplete && berichtComplete
 * Pending = either module not done yet.
 */
function isDocumentationPending(job: Job, jobReportCountsByJobId: ReadonlyMap<string, number>): boolean {
  return (job.photoCount ?? 0) === 0 || (jobReportCountsByJobId.get(job.id) ?? 0) === 0
}

// ── Projection ────────────────────────────────────────────────────────────────

/**
 * Derives the flat Start-tab view model from current worker state.
 *
 * @param userEntries  CalendarEntries already filtered to this worker's assignments
 * @param jobs         All jobs — used only for documentation status lookup
 * @param now          Injected for testability; defaults to current date
 */
export function deriveWorkerStartViewModel(
  userEntries: CalendarEntry[],
  jobs: Job[],
  now: Date = new Date(),
  jobReportCountsByJobId: ReadonlyMap<string, number> = new Map(),
): WorkerStartViewModel {
  const todayKey = formatDateKey(now)

  const todayEntries = userEntries.filter((e) => e.dateKey === todayKey)
  const futureEntries = userEntries.filter((e) => e.dateKey > todayKey)

  const inProgress = todayEntries.filter((e) => e.status === 'in_progress')
  // awaiting_payment = worker's operational completion; treated as done for
  // day-state derivation (worker has no further action until payment is released).
  const completed = todayEntries.filter((e) => e.status === 'completed' || e.status === 'awaiting_payment')
  const scheduled = todayEntries
    .filter((e) => e.status === 'scheduled')
    .sort((a, b) => a.startsAtLabel.localeCompare(b.startsAtLabel))
  const nonCancelled = todayEntries.filter((e) => e.status !== 'cancelled')

  // ── State derivation ──────────────────────────────────────────────────────
  let dayState: WorkerDayState
  let currentEntry: CalendarEntry | null = null
  let nextEntry: CalendarEntry | null = null
  // Only set for workday_calm future-day entries — used to attach date label to snapshot
  let nextEntryDateKey: string | undefined = undefined

  if (inProgress.length > 0) {
    dayState = 'assignment_active'
    currentEntry = inProgress[0]
    nextEntry = scheduled[0] ?? null
  } else if (completed.length > 0 && scheduled.length > 0) {
    dayState = 'workday_no_assignment'
    nextEntry = scheduled[0]
  } else if (completed.length > 0 && scheduled.length === 0) {
    const lastCompleted = completed[completed.length - 1]
    const linkedJob = lastCompleted.jobId
      ? (jobs.find((j) => j.id === lastCompleted.jobId) ?? null)
      : null
    if (linkedJob && isDocumentationPending(linkedJob, jobReportCountsByJobId)) {
      dayState = 'assignment_open_item'
      currentEntry = lastCompleted
    } else {
      dayState = 'day_complete'
    }
  } else if (scheduled.length > 0) {
    dayState = 'not_started'
    nextEntry = scheduled[0]
  } else {
    dayState = 'workday_calm'
    // Show next upcoming assignment across future days
    const nextFuture = futureEntries
      .filter((e) => e.status === 'scheduled' || e.status === 'in_progress')
      .sort((a, b) =>
        a.dateKey !== b.dateKey
          ? a.dateKey.localeCompare(b.dateKey)
          : a.startsAtLabel.localeCompare(b.startsAtLabel)
      )[0] ?? null
    nextEntry = nextFuture
    if (nextFuture) nextEntryDateKey = nextFuture.dateKey
  }

  // ── Open items ────────────────────────────────────────────────────────────
  const openItems: OpenItem[] = []
  if (dayState === 'assignment_open_item' && currentEntry?.jobId) {
    const job = jobs.find((j) => j.id === currentEntry!.jobId)
    if (job) {
      openItems.push({
        id: `doku-${currentEntry.id}`,
        entryId: currentEntry.id,
        label: 'Dokumentation fehlt',
        kind: 'doku',
        assignmentTitle: currentEntry.title,
        urgent: false,
        fromDate: 'today',
      })
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary: DaySummary = {
    total: nonCancelled.length,
    done: completed.length,
    remaining: nonCancelled.length - completed.length,
  }

  const nextSnapshot = nextEntry
    ? nextEntryDateKey
      ? { ...toSnapshot(nextEntry), date: formatDateLabel(nextEntryDateKey) }
      : toSnapshot(nextEntry)
    : null

  return {
    dayState,
    currentAssignment: currentEntry ? toSnapshot(currentEntry) : null,
    nextAssignment: nextSnapshot,
    openItems,
    summary,
    hints: [],
    todayKey,
  }
}
