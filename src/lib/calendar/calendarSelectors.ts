import type { CalendarEntry, CalendarEntryStatus } from './calendarTypes'
import type { TeamMember } from '../jobs/types'

export function getCalendarStatusLabel(status: CalendarEntryStatus): string {
  if (status === 'pending') return 'Terminplanung offen'
  if (status === 'scheduled') return 'Geplant'
  if (status === 'in_progress') return 'In Arbeit'
  if (status === 'awaiting_payment') return 'Wartet auf Zahlung'
  if (status === 'completed') return 'Abgeschlossen'
  return 'Abgesagt'
}

export function getScheduledEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter((entry) => entry.status === 'scheduled')
}

export function getInProgressEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter((entry) => entry.status === 'in_progress')
}

export function getCompletedEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter((entry) => entry.status === 'completed' || entry.status === 'awaiting_payment')
}

export function getVisibleCalendarEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getEntriesForMember(entries: CalendarEntry[], memberId: string): CalendarEntry[] {
  return entries.filter((entry) => entry.assignedMemberIds.includes(memberId))
}

/**
 * Resolves calendar entries visible to a logged-in user.
 *
 * Resolution order:
 * 1. Find a team member whose `userId` matches the provided `userId`.
 * 2. Return entries assigned to that member's `id`, filtered to entries that
 *    belong to the same company/provider (hard company scope).
 * 3. Fallback: treat `userId` as a direct member ID (supports legacy data and
 *    demo environments where member IDs are used as user identifiers).
 *
 * Company scope enforcement:
 *   When the resolved team member carries a `providerId`, only entries with a
 *   matching `providerId` (or no `providerId` at all, for legacy pre-scope
 *   entries) are returned.  This prevents cross-company visibility: a worker
 *   from company A cannot see entries of company B even if they share a
 *   team_member id by coincidence.
 *
 *   When the member has no `providerId` (legacy seed members, in-memory mode),
 *   the scope check is skipped to preserve backward compatibility.
 */
export function getEntriesForUser(
  entries: CalendarEntry[],
  teamMembers: TeamMember[],
  userId: string
): CalendarEntry[] {
  const member = teamMembers.find((m) => m.userId === userId)
  if (member) {
    const assigned = getEntriesForMember(entries, member.id)
    // Enforce company scope when the member's provider is known.
    // Entries without a providerId are legacy rows and pass through
    // (they remain visible to the owner via RLS fallback; workers
    // should not see them, but RLS handles that at the DB layer).
    if (member.providerId) {
      return assigned.filter(
        (e) => !e.providerId || e.providerId === member.providerId
      )
    }
    return assigned
  }
  // Fallback: direct match (backward compat / demo mode)
  return getEntriesForMember(entries, userId)
}

/**
 * Returns entries for a specific day (by dateKey) that are eligible
 * for the timed day grid: only scheduled and in_progress.
 * Pending/completed/cancelled entries are excluded from the grid.
 */
export function getTimedEntriesForDay(
  entries: CalendarEntry[],
  dateKey: string
): CalendarEntry[] {
  return entries.filter(
    (e) =>
      e.dateKey === dateKey &&
      (e.status === 'scheduled' || e.status === 'in_progress')
  )
}

/**
 * Returns pending entries across all days — work that still needs scheduling.
 */
export function getPendingEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter((e) => e.status === 'pending')
}

/**
 * Returns scheduled + in_progress entries for days strictly after the given
 * dateKey, sorted chronologically by dateKey then startsAtLabel.
 * Used by List mode's "Demnächst" / upcoming section.
 */
export function getUpcomingScheduledEntries(
  entries: CalendarEntry[],
  afterDateKey: string
): CalendarEntry[] {
  return entries
    .filter(
      (e) =>
        e.dateKey > afterDateKey &&
        (e.status === 'scheduled' || e.status === 'in_progress')
    )
    .sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey)
      return a.startsAtLabel.localeCompare(b.startsAtLabel)
    })
}
