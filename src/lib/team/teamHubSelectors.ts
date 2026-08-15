import type { CalendarEntry } from '../calendar/calendarTypes'
import type { CorrectionRequest } from '../corrections/types'
import { isJobOperational } from '../jobs/helpers'
import type { Job, TeamMember } from '../jobs/types'
import type { Absence } from './absenceTypes'
import { deriveActiveSickToday } from './absenceSelectors'

const ACTIVE_JOB_STATUSES = new Set<Job['status']>(['new', 'scheduled', 'in_progress'])

const OVERLOAD_THRESHOLD = 3

export type RosterStatus = 'on_site' | 'scheduled_today' | 'free_today' | 'overloaded' | 'sick'

export type RosterAssignment = {
  title: string
  location: string
  timeLabel: string
}

export type TodayRosterEntry = {
  memberId: string
  displayName: string
  initials: string
  avatarUrl: string | null
  phone: string | null
  status: RosterStatus
  assignments: RosterAssignment[]
  totalActiveJobs: number
  /** Set when status='sick'. Drives the "Tag X" badge + Krankschein-CTA. */
  sickInfo: { absenceId: string; dayCount: number; reasonNote: string | null; sickNoteRequested: boolean; sickNoteUrl: string | null } | null
}

export type TeamHubActionItems = {
  openCorrectionsCount: number
  pendingStubs: TeamMember[]
  highLoadMembers: { memberId: string; displayName: string; activeJobCount: number }[]
}

export type WeeklyHoursSollEntry = {
  memberId: string
  displayName: string
  initials: string
  targetHours: number | null
}

export type TeamHubCounts = {
  activeCount: number
  stubCount: number
  inactiveCount: number
}

export function deriveInitials(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function deriveTeamHubCounts(members: TeamMember[]): TeamHubCounts {
  let activeCount = 0
  let stubCount = 0
  let inactiveCount = 0
  for (const m of members) {
    if (m.role === 'owner') continue
    if (m.isActive === false) {
      inactiveCount++
      continue
    }
    if (!m.userId) {
      stubCount++
      continue
    }
    activeCount++
  }
  return { activeCount, stubCount, inactiveCount }
}

export function deriveTodayRoster(
  members: TeamMember[],
  calendarEntries: CalendarEntry[],
  jobs: Job[],
  todayKey: string,
  absences: Absence[] = [],
): TodayRosterEntry[] {
  const todayEntries = calendarEntries.filter(
    (e) => e.dateKey === todayKey && e.status !== 'cancelled' && e.status !== 'completed',
  )

  const operationalJobs = jobs.filter(
    (j) => ACTIVE_JOB_STATUSES.has(j.status) && isJobOperational(j),
  )

  const sickToday = deriveActiveSickToday(absences, todayKey)

  return members
    .filter((m) => m.role !== 'owner' && m.isActive !== false && !!m.userId)
    .map((member) => {
      const memberEntries = todayEntries.filter((e) => e.assignedMemberIds.includes(member.id))
      const assignments: RosterAssignment[] = memberEntries.map((e) => ({
        title: e.title,
        location: e.location,
        timeLabel: e.startsAtLabel && e.endsAtLabel
          ? `${e.startsAtLabel}–${e.endsAtLabel}`
          : e.startsAtLabel || '',
      }))

      const totalActiveJobs = operationalJobs.filter((j) =>
        j.assignedMemberIds.includes(member.id),
      ).length

      const sickInfo = sickToday.get(member.id) ?? null

      // Sick wins over all other statuses — a sick worker should never show
      // "scheduled_today" or "on_site" even if there are stale calendar
      // entries on the day they reported sick.
      let status: RosterStatus
      if (sickInfo) {
        status = 'sick'
      } else if (totalActiveJobs >= OVERLOAD_THRESHOLD) {
        status = 'overloaded'
      } else if (assignments.length > 0) {
        status = memberEntries.some((e) => e.status === 'in_progress') ? 'on_site' : 'scheduled_today'
      } else {
        status = 'free_today'
      }

      return {
        memberId: member.id,
        displayName: member.name,
        initials: deriveInitials(member.name),
        avatarUrl: member.avatarUrl ?? null,
        phone: member.phone ?? null,
        status,
        assignments,
        totalActiveJobs,
        sickInfo,
      }
    })
}

export function deriveTeamHubActionItems(
  members: TeamMember[],
  corrections: CorrectionRequest[],
  jobs: Job[],
): TeamHubActionItems {
  const openCorrectionsCount = corrections.filter(
    (c) => c.status === 'open' || c.status === 'in_review',
  ).length

  const pendingStubs = members.filter(
    (m) => m.role !== 'owner' && m.isActive !== false && !m.userId,
  )

  const operationalJobs = jobs.filter(
    (j) => ACTIVE_JOB_STATUSES.has(j.status) && isJobOperational(j),
  )

  const highLoadMembers = members
    .filter((m) => m.role !== 'owner' && m.isActive !== false && !!m.userId)
    .map((m) => ({
      memberId: m.id,
      displayName: m.name,
      activeJobCount: operationalJobs.filter((j) => j.assignedMemberIds.includes(m.id)).length,
    }))
    .filter((entry) => entry.activeJobCount >= OVERLOAD_THRESHOLD)
    .sort((a, b) => b.activeJobCount - a.activeJobCount)

  return { openCorrectionsCount, pendingStubs, highLoadMembers }
}

export function deriveTeamHubSubtitle(
  members: TeamMember[],
  corrections: CorrectionRequest[],
): string {
  const counts = deriveTeamHubCounts(members)
  const openCorrections = corrections.filter(
    (c) => c.status === 'open' || c.status === 'in_review',
  ).length

  const parts: string[] = []
  if (counts.activeCount === 0 && counts.stubCount === 0) {
    return 'Noch keine Mitarbeiter'
  }
  parts.push(`${counts.activeCount} aktiv`)
  if (counts.stubCount > 0) parts.push(`${counts.stubCount} wartet`)
  if (openCorrections > 0) {
    parts.push(`${openCorrections} ${openCorrections === 1 ? 'Korrektur' : 'Korrekturen'} offen`)
  }
  return parts.join(' · ')
}

export function deriveWeeklyHoursSoll(members: TeamMember[]): WeeklyHoursSollEntry[] {
  return members
    .filter((m) => m.role !== 'owner' && m.isActive !== false && !!m.userId)
    .map((m) => ({
      memberId: m.id,
      displayName: m.name,
      initials: deriveInitials(m.name),
      targetHours: m.weeklyTargetHours ?? null,
    }))
}

export function rosterStatusLabel(status: RosterStatus): string {
  switch (status) {
    case 'on_site': return 'auf Baustelle'
    case 'scheduled_today': return 'eingeplant'
    case 'free_today': return 'frei'
    case 'overloaded': return 'überlastet'
    case 'sick': return 'krank'
  }
}

/**
 * Filters the member list for the Hub's "Mitarbeiter" section.
 *
 *   - Owners are always excluded (Hub lists workers and stubs only).
 *   - Inactive members are hidden by default; the owner can toggle them in.
 *   - The query is case-insensitive and matches against name, email, or role.
 *     Empty / whitespace-only queries skip the search filter entirely.
 */
export function deriveFilteredMembers(
  members: TeamMember[],
  query: string,
  showInactive: boolean,
): TeamMember[] {
  const normalizedQuery = (query ?? '').trim().toLowerCase()
  return members
    .filter((m) => m.role !== 'owner')
    .filter((m) => showInactive || m.isActive !== false)
    .filter((m) => {
      if (!normalizedQuery) return true
      const haystack = [
        (m.name ?? '').toLowerCase(),
        (m.email ?? '').toLowerCase(),
        (m.role ?? '').toLowerCase(),
      ]
      return haystack.some((s) => s.includes(normalizedQuery))
    })
}
