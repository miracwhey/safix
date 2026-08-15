import type { JobSchedule } from './types'

// ---------------------------------------------------------------------------
// Readiness type
// ---------------------------------------------------------------------------

/**
 * Operational readiness of a scheduled job derived from timing and status.
 *
 * - `'upcoming'`      – scheduledStart is in the future (> 2 hours away)
 * - `'starting_soon'` – scheduledStart is within the next 2 hours
 * - `'active'`        – execution has been explicitly started
 * - `'overdue'`       – scheduledEnd has passed and execution is not yet complete
 * - `'completed'`     – execution has been marked as completed
 * - `'cancelled'`     – schedule has been cancelled
 */
export type ScheduleReadiness =
  | 'upcoming'
  | 'starting_soon'
  | 'active'
  | 'overdue'
  | 'completed'
  | 'cancelled'

/** Default look-ahead window used for "starting_soon" classification (2 hours). */
const STARTING_SOON_WINDOW_MS = 2 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Core derivation helpers
// ---------------------------------------------------------------------------

/**
 * Derives the operational readiness of a schedule relative to `nowMs`.
 * Pure function — does not read from any store.
 */
export function getScheduleReadiness(
  schedule: JobSchedule,
  nowMs: number
): ScheduleReadiness {
  if (schedule.schedulingStatus === 'cancelled') return 'cancelled'
  if (schedule.schedulingStatus === 'execution_completed') return 'completed'
  if (schedule.schedulingStatus === 'execution_started') return 'active'

  // Status is 'scheduled' — derive from timing
  if (nowMs > schedule.scheduledEnd) return 'overdue'

  const msUntilStart = schedule.scheduledStart - nowMs
  if (msUntilStart <= STARTING_SOON_WINDOW_MS) return 'starting_soon'

  return 'upcoming'
}

/**
 * Returns a short human-readable label for a `ScheduleReadiness` value.
 */
export function getScheduleReadinessLabel(readiness: ScheduleReadiness): string {
  switch (readiness) {
    case 'upcoming':
      return 'Geplant'
    case 'starting_soon':
      return 'Beginnt bald'
    case 'active':
      return 'In Ausführung'
    case 'overdue':
      return 'Überfällig'
    case 'completed':
      return 'Abgeschlossen'
    case 'cancelled':
      return 'Abgesagt'
  }
}

// ---------------------------------------------------------------------------
// Time-based collection filters (pure — take schedules array as param)
// ---------------------------------------------------------------------------

/**
 * Returns schedules whose `scheduledStart` is in the future.
 * Excludes cancelled and completed schedules.
 */
export function getUpcomingSchedules(
  schedules: JobSchedule[],
  nowMs: number
): JobSchedule[] {
  return schedules.filter(
    (s) =>
      s.scheduledStart > nowMs &&
      s.schedulingStatus !== 'cancelled' &&
      s.schedulingStatus !== 'execution_completed' &&
      s.schedulingStatus !== 'execution_started'
  )
}

/**
 * Returns schedules whose `scheduledStart` date falls on the same calendar day
 * as `nowMs`. Excludes cancelled schedules.
 */
export function getTodaySchedules(
  schedules: JobSchedule[],
  nowMs: number
): JobSchedule[] {
  const today = new Date(nowMs)
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime()
  const todayEnd = todayStart + 24 * 60 * 60 * 1000

  return schedules.filter(
    (s) =>
      s.scheduledStart >= todayStart &&
      s.scheduledStart < todayEnd &&
      s.schedulingStatus !== 'cancelled'
  )
}

/**
 * Returns schedules that are overdue: their `scheduledEnd` has passed and
 * execution has not been completed or cancelled.
 */
export function getOverdueSchedules(
  schedules: JobSchedule[],
  nowMs: number
): JobSchedule[] {
  return schedules.filter(
    (s) =>
      s.scheduledEnd < nowMs &&
      s.schedulingStatus !== 'execution_completed' &&
      s.schedulingStatus !== 'cancelled'
  )
}

/**
 * Returns schedules starting within `windowMs` milliseconds from `nowMs`.
 * Defaults to a 2-hour window. Only includes schedules with status `'scheduled'`.
 */
export function getStartingSoonSchedules(
  schedules: JobSchedule[],
  nowMs: number,
  windowMs: number = STARTING_SOON_WINDOW_MS
): JobSchedule[] {
  return schedules.filter(
    (s) =>
      s.schedulingStatus === 'scheduled' &&
      s.scheduledStart > nowMs &&
      s.scheduledStart - nowMs <= windowMs
  )
}

/**
 * Returns the subset of `jobIds` that have no schedule in the provided
 * `schedules` array. Useful for highlighting unplanned work.
 */
export function getUnscheduledJobIds(
  jobIds: string[],
  schedules: JobSchedule[]
): string[] {
  const scheduledJobIds = new Set(schedules.map((s) => s.jobId))
  return jobIds.filter((id) => !scheduledJobIds.has(id))
}

// ---------------------------------------------------------------------------
// Lifecycle group aggregate
// ---------------------------------------------------------------------------

export type SchedulingLifecycleGroups = {
  /** Schedules past their end time, not yet completed or cancelled */
  overdue: JobSchedule[]
  /** Schedules whose start falls on today's calendar date, excluding cancelled */
  today: JobSchedule[]
  /** Schedules starting within the next 2 hours (but not yet overdue) */
  startingSoon: JobSchedule[]
  /** Schedules with a future start time beyond the starting-soon window */
  upcoming: JobSchedule[]
  /** Schedules that have been explicitly cancelled */
  cancelled: JobSchedule[]
}

/**
 * Groups a list of schedules into operational lifecycle buckets.
 * Each schedule appears in at most one group — overdue takes highest priority,
 * then today, then startingSoon, then upcoming, then cancelled.
 * Pure function — does not read from any store.
 */
export function getSchedulingLifecycleGroups(
  schedules: JobSchedule[],
  nowMs: number
): SchedulingLifecycleGroups {
  const overdue: JobSchedule[] = []
  const today: JobSchedule[] = []
  const startingSoon: JobSchedule[] = []
  const upcoming: JobSchedule[] = []
  const cancelled: JobSchedule[] = []

  const todayDate = new Date(nowMs)
  const todayStart = new Date(
    todayDate.getFullYear(),
    todayDate.getMonth(),
    todayDate.getDate()
  ).getTime()
  const todayEnd = todayStart + 24 * 60 * 60 * 1000

  for (const s of schedules) {
    if (s.schedulingStatus === 'cancelled') {
      cancelled.push(s)
      continue
    }
    if (s.schedulingStatus === 'execution_completed') {
      // completed schedules are intentionally excluded from lifecycle groups
      continue
    }
    if (
      s.schedulingStatus !== 'execution_started' &&
      s.scheduledEnd < nowMs
    ) {
      overdue.push(s)
      continue
    }
    // Active (execution_started) schedules belong in today regardless of their
    // original scheduled date — work is underway and needs today's attention.
    if (s.schedulingStatus === 'execution_started') {
      today.push(s)
      continue
    }
    if (
      s.scheduledStart >= todayStart &&
      s.scheduledStart < todayEnd
    ) {
      today.push(s)
      continue
    }
    const msUntilStart = s.scheduledStart - nowMs
    if (msUntilStart <= STARTING_SOON_WINDOW_MS && msUntilStart > 0) {
      startingSoon.push(s)
      continue
    }
    upcoming.push(s)
  }

  return { overdue, today, startingSoon, upcoming, cancelled }
}
