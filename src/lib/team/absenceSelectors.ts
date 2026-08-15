import type { Job, TeamMember } from '../jobs/types'
import type { Absence } from './absenceTypes'
import { deriveInitials } from './teamHubSelectors'

/**
 * Active sick rows mapped per memberId. Active = status='active' AND
 * todayKey ∈ [startDate..endDate]. Vacation/other types are not surfaced as
 * "sick" in the Owner-Hub roster — only type='sick' is rolled into the
 * roster's sick-status. Vacation/other live in the history view.
 *
 * Returns one entry per affected member; if a member has multiple overlapping
 * sick rows (rare), the most recent (latest startDate) wins so the day-count
 * matches what the user just reported.
 */
export function deriveActiveSickToday(
  absences: Absence[],
  todayKey: string,
): Map<string, { absenceId: string; dayCount: number; reasonNote: string | null; sickNoteRequested: boolean; sickNoteUrl: string | null }> {
  const out = new Map<string, { absenceId: string; dayCount: number; reasonNote: string | null; sickNoteRequested: boolean; sickNoteUrl: string | null }>()
  const sortedSick = absences
    .filter(
      (a) =>
        a.status === 'active' &&
        a.type === 'sick' &&
        a.startDate <= todayKey &&
        a.endDate >= todayKey,
    )
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))

  for (const absence of sortedSick) {
    if (out.has(absence.memberId)) continue
    out.set(absence.memberId, {
      absenceId: absence.id,
      dayCount: deriveAbsenceDaysCount(absence, todayKey),
      reasonNote: absence.reasonNote,
      sickNoteRequested: absence.sickNoteRequested,
      sickNoteUrl: absence.sickNoteUrl,
    })
  }
  return out
}

/**
 * Tag-Counter: 1 on the start day, 2 on the second day, etc. Capped at the
 * end_date so a 3-day absence still reads "Tag 3" on the third day even if
 * todayKey is past end_date (defensive — caller usually filters first).
 */
export function deriveAbsenceDaysCount(absence: Absence, todayKey: string): number {
  const start = parseDateKey(absence.startDate)
  const today = parseDateKey(todayKey)
  const end = parseDateKey(absence.endDate)
  const clampedToday = today.getTime() > end.getTime() ? end : today
  const diffMs = clampedToday.getTime() - start.getTime()
  const days = Math.floor(diffMs / 86400_000) + 1
  return Math.max(1, days)
}

/**
 * Active sick rows that overlap any day in the given interval. Used by the
 * worker history screen to show "active streak" vs past entries.
 */
export function deriveAbsenceHistory(
  absences: Absence[],
  memberId: string,
): Absence[] {
  return absences
    .filter((a) => a.memberId === memberId)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
}

export type SpringerCandidate = {
  memberId: string
  displayName: string
  initials: string
  avatarUrl: string | null
  /** Number of jobs the candidate would be added to. Higher = better for one-click. */
  affectedJobCount: number
}

/**
 * Candidates for taking over a sick member's jobs today.
 *
 * Inputs:
 *   - members: full team roster (the caller filters to provider scope upstream).
 *   - jobsForSickMember: today's operational jobs assigned to the sick member.
 *   - excludeMemberIds: members to filter out (the sick member, other concurrently-sick members).
 *
 * Selection rules:
 *   - Only active members with a profile_id (no Stubs — they can't act).
 *   - Sort by affectedJobCount DESC (one Springer covering all jobs is preferred over splitting).
 *   - Tie-break: alphabetical by name.
 *
 * NOTE: Skill-based matching is deferred (Plan §12 Out-of-Scope).
 */
export function deriveSpringerCandidates(
  members: TeamMember[],
  jobsForSickMember: Job[],
  excludeMemberIds: Set<string>,
): SpringerCandidate[] {
  return members
    .filter(
      (m) =>
        m.role !== 'owner' &&
        m.isActive !== false &&
        !!m.userId &&
        !excludeMemberIds.has(m.id),
    )
    .map((m) => ({
      memberId: m.id,
      displayName: m.name,
      initials: deriveInitials(m.name),
      avatarUrl: m.avatarUrl ?? null,
      affectedJobCount: jobsForSickMember.length,
    }))
    .sort((a, b) => {
      if (b.affectedJobCount !== a.affectedJobCount) return b.affectedJobCount - a.affectedJobCount
      return a.displayName.localeCompare(b.displayName)
    })
}

/**
 * Preview the reassign result before the Owner confirms — drives the
 * "übernimmt 3 Aufträge" copy in the SpringerConfirmSheet.
 */
export function deriveReassignmentPreview(
  jobs: Job[],
  fromMemberId: string,
  _toMemberId: string,
): { jobIds: string[]; jobTitles: string[] } {
  const affected = jobs.filter((j) => j.assignedMemberIds.includes(fromMemberId))
  return {
    jobIds: affected.map((j) => j.id),
    jobTitles: affected.map((j) => j.title || j.id),
  }
}

function parseDateKey(key: string): Date {
  // YYYY-MM-DD → midnight local. The 'T00:00:00' suffix prevents Safari from
  // parsing it as UTC and shifting the day in non-UTC timezones.
  return new Date(`${key}T00:00:00`)
}
