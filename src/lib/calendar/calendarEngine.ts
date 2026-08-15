import type { Job } from '../jobs/types'
import type { CalendarEntry, CalendarEntryStatus } from './calendarTypes'

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD dateKey string. */
export function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Returns true if a job should be materialised as a CalendarEntry.
 *  Includes 'booked' because WorkEntry counts booked+assigned jobs as
 *  "coming up" — TodayBlock must derive from the same truth. */
export function isCalendarRelevantJob(job: Job): boolean {
  return (
    job.status === 'booked' ||
    job.status === 'scheduled' ||
    job.status === 'in_progress' ||
    job.status === 'waiting_payment' ||
    job.status === 'completed'
  )
}

// ── Internal helpers ─────────────────────────────────────────────────────────

export function mapJobStatusToCalendarStatus(job: Job): CalendarEntryStatus {
  if (job.status === 'scheduled') return 'scheduled'
  if (job.status === 'in_progress') return 'in_progress'
  if (job.status === 'completed') return 'completed'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.status === 'waiting_payment') return 'awaiting_payment'
  // Remaining statuses (booked, new, proposal_sent, etc.) → pending (not yet truly scheduled)
  return 'pending'
}

/**
 * Extracts a real HH:MM time from the job's dateLabel if one exists.
 * E.g. "Heute, 14:00 Uhr" → "14:00", "Morgen, 09:30 Uhr" → "09:30"
 * Returns empty string when no real time is present.
 */
function extractRealTime(dateLabel: string): string {
  const match = dateLabel.match(/(\d{1,2}:\d{2})/)
  return match ? match[1] : ''
}

function getDefaultTimeWindow(job: Job): {
  startsAtLabel: string
  endsAtLabel: string
} {
  if (job.status === 'in_progress') {
    return {
      startsAtLabel: 'Jetzt',
      endsAtLabel: 'Offen',
    }
  }

  // Only use a real time from dateLabel — never fabricate a clock value.
  const realTime = extractRealTime(job.dateLabel)
  return {
    startsAtLabel: realTime,
    endsAtLabel: '',
  }
}

function getDateInfo(job: Job): {
  dateLabel: string
  dateKey: string
} {
  const dateLabel = job.dateLabel
  const now = new Date()

  // dateLabel may include time suffix, e.g. "Heute, 14:00 Uhr" — match on prefix
  if (dateLabel === 'Heute' || dateLabel.startsWith('Heute')) {
    return { dateLabel: 'Heute', dateKey: formatDateKey(now) }
  }

  if (dateLabel === 'Morgen' || dateLabel.startsWith('Morgen')) {
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return { dateLabel: 'Morgen', dateKey: formatDateKey(tomorrow) }
  }

  if (dateLabel === 'Gestern' || dateLabel.startsWith('Gestern')) {
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    return { dateLabel: 'Gestern', dateKey: formatDateKey(yesterday) }
  }

  // For unspecified dates ("Offen", etc.), use tomorrow as a reasonable upcoming default
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  return { dateLabel, dateKey: formatDateKey(tomorrow) }
}

export function createCalendarEntryFromJob(job: Job): CalendarEntry {
  const timeWindow = getDefaultTimeWindow(job)
  const dateInfo = getDateInfo(job)

  return {
    id: job.id,
    jobId: job.id,
    kind: 'job',
    // Propagate company scope from the job — this is the primary mechanism
    // by which new CalendarEntries get their provider_id set at creation time.
    ...(job.providerId ? { providerId: job.providerId } : {}),
    title: job.title,
    description: '',
    customerName: job.customer,
    location: job.location,
    dateLabel: dateInfo.dateLabel,
    dateKey: dateInfo.dateKey,
    startsAtLabel: timeWindow.startsAtLabel,
    endsAtLabel: timeWindow.endsAtLabel,
    assignedMemberIds: job.assignedMemberIds,
    status: mapJobStatusToCalendarStatus(job),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function updateCalendarEntryStatus(
  entry: CalendarEntry,
  nextStatus: CalendarEntryStatus
): CalendarEntry {
  return {
    ...entry,
    status: nextStatus,
    updatedAt: Date.now(),
  }
}

export function assignMembersToCalendarEntry(
  entry: CalendarEntry,
  memberIds: string[]
): CalendarEntry {
  return {
    ...entry,
    assignedMemberIds: memberIds,
    updatedAt: Date.now(),
  }
}
