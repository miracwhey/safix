/**
 * Pure selectors for the 3-tab Operations screen (Planung, Team, Doku).
 *
 * Each derivation function takes store snapshots and returns a typed summary.
 * All business logic (conflicts, completeness, billability) is encapsulated
 * here — the screen only renders, never classifies.
 *
 * Honest labeling: these selectors only claim what the underlying data
 * actually supports. No synthetic time tracking, no fabricated durations.
 */

import type { CalendarEntry } from '../calendar/calendarTypes'
import type { Job, TeamMember } from '../jobs/types'
import {
  getTimedEntriesForDay,
  getPendingEntries,
} from '../calendar/calendarSelectors'
import { buildTodayTeamLoad, getOverbookedMembers } from '../calendar/operationsEngine'
import {
  getTeamWorkloadDistribution,
  getUnassignedJobs,
} from '../jobs/teamWorkloadSelectors'
import { isJobOperational } from '../jobs/helpers'

// ── Shared helpers ───────────────────────────────────────────────────────────

function parseDateKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDateLabel(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function resolveDisplayName(memberId: string, nameMap: Map<string, string>, index: number): string {
  return nameMap.get(memberId) || `Teammitglied ${index + 1}`
}

function jobHasOpenDoku(job: Job, ownerNotesCount: number = 0): boolean {
  return (
    (job.status === 'in_progress' || job.status === 'waiting_payment') &&
    job.photoCount === 0 &&
    ownerNotesCount === 0
  )
}

function isAbrechenbar(job: Job, ownerNotesCount: number = 0): boolean {
  return (
    (job.status === 'waiting_payment' || job.status === 'completed') &&
    (job.photoCount > 0 || ownerNotesCount > 0)
  )
}

// ── Planung Tab ──────────────────────────────────────────────────────────────

export type PlanungSubMode = 'uebersicht' | 'kalender'

export type PlanungSummary = {
  todayCount: number
  pendingCount: number
  /** Operative problems: unassigned planned, overbooked members, entries without progress */
  problemCount: number
}

export type WeekDayGroup = {
  dateKey: string
  label: string
  entries: CalendarEntry[]
}

export type PlanungTabData = {
  summary: PlanungSummary
  // Jetzt/Nächster
  activeEntry: CalendarEntry | null
  nextEntry: CalendarEntry | null
  // Sub-mode content
  dayEntries: CalendarEntry[]
  weekGroups: WeekDayGroup[]
  // Lücken
  pendingEntries: CalendarEntry[]
  unassignedScheduled: CalendarEntry[]
  overbookedNames: string[]
  // Meta
  dateLabel: string
}

export function derivePlanungTab(
  calendarEntries: CalendarEntry[],
  dateKey: string,
  teamMembers: TeamMember[],
): PlanungTabData {
  const todayKey = formatDateKey(new Date())
  const nameMap = new Map(teamMembers.map((m) => [m.id, m.name]))

  // Day entries for selected date
  const dayEntries = getTimedEntriesForDay(calendarEntries, dateKey).sort((a, b) => {
    if (a.startsAtLabel && b.startsAtLabel) return a.startsAtLabel.localeCompare(b.startsAtLabel)
    if (a.startsAtLabel) return -1
    if (b.startsAtLabel) return 1
    return 0
  })

  // Today's active & next
  const todayEntries = getTimedEntriesForDay(calendarEntries, todayKey)
  const activeEntry = todayEntries.find((e) => e.status === 'in_progress') ?? null
  const nextEntry = activeEntry
    ? null
    : todayEntries
        .filter((e) => e.status === 'scheduled')
        .sort((a, b) => a.startsAtLabel.localeCompare(b.startsAtLabel))[0] ?? null

  // Pending (unscheduled)
  const pendingEntries = getPendingEntries(calendarEntries)

  // Week view: today + next 6 days
  const weekGroups: WeekDayGroup[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date()
    d.setDate(d.getDate() + i)
    const dk = formatDateKey(d)
    const entries = getTimedEntriesForDay(calendarEntries, dk).sort((a, b) =>
      a.startsAtLabel.localeCompare(b.startsAtLabel),
    )
    if (entries.length > 0) {
      weekGroups.push({
        dateKey: dk,
        label: i === 0 ? 'Heute' : formatDateLabel(dk),
        entries,
      })
    }
  }

  // Lücken: unassigned scheduled job entries only — custom entries need no team assignment
  const unassignedScheduled = calendarEntries.filter(
    (e) =>
      e.kind === 'job' &&
      (e.status === 'scheduled' || e.status === 'in_progress') &&
      e.assignedMemberIds.length === 0,
  )

  // Overbooked members
  const todayLoad = buildTodayTeamLoad(calendarEntries)
  const overbooked = getOverbookedMembers(todayLoad)
  const overbookedNames = overbooked.map((m) => nameMap.get(m.memberId) ?? m.memberId)

  // Summary: problem count = real operative issues bundled
  const problemCount = unassignedScheduled.length + overbooked.length

  const summary: PlanungSummary = {
    todayCount: todayEntries.length,
    pendingCount: pendingEntries.length,
    problemCount,
  }

  return {
    summary,
    activeEntry,
    nextEntry,
    dayEntries,
    weekGroups,
    pendingEntries,
    unassignedScheduled,
    overbookedNames,
    dateLabel: formatDateLabel(dateKey),
  }
}

// ── Team Tab ─────────────────────────────────────────────────────────────────

export type TeamMemberStatus = 'active' | 'idle' | 'overbooked'
export type TeamSubMode = 'aktiv' | 'alle' | 'probleme' | 'zeiten'

export type TeamMemberSummary = {
  member: TeamMember
  displayName: string
  status: TeamMemberStatus
  currentJob: Job | null
  nextPlannedJob: Job | null
  totalActiveJobs: number
  todayEntryCount: number
  hasOpenDoku: boolean
}

export type TeamSummary = {
  activeCount: number
  freeCount: number
  problemCount: number
}

export type TeamTabData = {
  summary: TeamSummary
  members: TeamMemberSummary[]
  unassignedJobs: Job[]
  dokuOpenJobs: Job[]
}

export function deriveTeamTab(
  jobs: Job[],
  teamMembers: TeamMember[],
  calendarEntries: CalendarEntry[],
): TeamTabData {
  const nameMap = new Map(teamMembers.map((m) => [m.id, m.name]))
  const todayKey = formatDateKey(new Date())
  const todayEntries = getTimedEntriesForDay(calendarEntries, todayKey)

  // Build member-to-today-entry count
  const todayCountByMember = new Map<string, number>()
  for (const entry of todayEntries) {
    for (const mid of entry.assignedMemberIds) {
      todayCountByMember.set(mid, (todayCountByMember.get(mid) ?? 0) + 1)
    }
  }

  const workloads = getTeamWorkloadDistribution(jobs, teamMembers)
  const unassigned = getUnassignedJobs(jobs)

  const members: TeamMemberSummary[] = workloads.map((wl, index) => {
    const currentJob = wl.activeJobs.find((j) => j.status === 'in_progress') ?? null
    const nextPlannedJob = wl.scheduledJobs[0] ?? null
    const totalActive = wl.activeJobs.length

    let status: TeamMemberStatus = 'idle'
    if (totalActive > 2) status = 'overbooked'
    else if (totalActive > 0) status = 'active'

    const hasOpenDoku = wl.activeJobs.some(jobHasOpenDoku)

    return {
      member: teamMembers.find((m) => m.id === wl.memberId)!,
      displayName: resolveDisplayName(wl.memberId, nameMap, index),
      status,
      currentJob,
      nextPlannedJob,
      totalActiveJobs: totalActive,
      todayEntryCount: todayCountByMember.get(wl.memberId) ?? 0,
      hasOpenDoku,
    }
  })

  // Jobs with open documentation (in_progress/waiting_payment, no photos/notes)
  const dokuOpenJobs = jobs.filter(
    (j) => isJobOperational(j) && jobHasOpenDoku(j),
  )

  const activeCount = members.filter((m) => m.status === 'active' || m.status === 'overbooked').length
  const freeCount = members.filter((m) => m.status === 'idle').length
  const problemCount = members.filter((m) => m.status === 'overbooked').length
    + unassigned.length
    + dokuOpenJobs.length

  return {
    summary: { activeCount, freeCount, problemCount },
    members,
    unassignedJobs: unassigned,
    dokuOpenJobs,
  }
}

// ── Team Zeiten (time tracking) ─────────────────────────────────────────────

export type DayHours = {
  dateKey: string
  dayLabel: string // "Mo", "Di", ...
  hours: number
  entryCount: number
}

export type MemberTimesheet = {
  memberId: string
  displayName: string
  weekTotal: number // hours
  days: DayHours[]
}

export type TeamZeitenData = {
  weekLabel: string
  teamTotal: number
  members: MemberTimesheet[]
}

function parseTimeLabel(label: string): number | null {
  if (!label) return null
  const match = label.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  return parseInt(match[1], 10) + parseInt(match[2], 10) / 60
}

function getEntryDurationHours(entry: CalendarEntry): number {
  const start = parseTimeLabel(entry.startsAtLabel)
  const end = parseTimeLabel(entry.endsAtLabel)
  if (start === null || end === null) return 0
  const diff = end - start
  return diff > 0 ? diff : 0
}

const SHORT_DAYS_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

export function deriveTeamZeiten(
  calendarEntries: CalendarEntry[],
  teamMembers: TeamMember[],
): TeamZeitenData {
  const nameMap = new Map(teamMembers.map((m) => [m.id, m.name]))

  // Build week range: Monday of current week through Sunday
  const now = new Date()
  const dayOfWeek = now.getDay() // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(now)
  monday.setDate(now.getDate() + mondayOffset)

  const weekDays: { dateKey: string; dayLabel: string }[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    weekDays.push({
      dateKey: formatDateKey(d),
      dayLabel: SHORT_DAYS_DE[d.getDay()],
    })
  }

  const weekStart = weekDays[0].dateKey
  const weekEnd = weekDays[6].dateKey

  // Filter entries to this week and with valid times
  const weekEntries = calendarEntries.filter((e) => {
    if (e.status === 'cancelled') return false
    if (e.dateKey < weekStart || e.dateKey > weekEnd) return false
    return getEntryDurationHours(e) > 0
  })

  // Build per-member, per-day aggregation
  const memberDayMap = new Map<string, Map<string, { hours: number; count: number }>>()

  for (const entry of weekEntries) {
    const duration = getEntryDurationHours(entry)
    const memberIds = entry.assignedMemberIds.length > 0
      ? entry.assignedMemberIds
      : ['_unassigned']

    for (const mid of memberIds) {
      if (!memberDayMap.has(mid)) memberDayMap.set(mid, new Map())
      const dayMap = memberDayMap.get(mid)!
      const existing = dayMap.get(entry.dateKey) ?? { hours: 0, count: 0 }
      dayMap.set(entry.dateKey, {
        hours: existing.hours + duration,
        count: existing.count + 1,
      })
    }
  }

  // Build member timesheets
  const members: MemberTimesheet[] = []

  // Include all known team members (even with 0 hours)
  const allMemberIds = new Set([
    ...teamMembers.map((m) => m.id),
    ...memberDayMap.keys(),
  ])

  for (const mid of allMemberIds) {
    if (mid === '_unassigned') continue
    const dayMap = memberDayMap.get(mid)
    const days: DayHours[] = weekDays.map((wd) => {
      const data = dayMap?.get(wd.dateKey)
      return {
        dateKey: wd.dateKey,
        dayLabel: wd.dayLabel,
        hours: data?.hours ?? 0,
        entryCount: data?.count ?? 0,
      }
    })
    const weekTotal = days.reduce((sum, d) => sum + d.hours, 0)

    members.push({
      memberId: mid,
      displayName: nameMap.get(mid) ?? `Teammitglied`,
      weekTotal,
      days,
    })
  }

  // Sort: most hours first
  members.sort((a, b) => b.weekTotal - a.weekTotal)

  const teamTotal = members.reduce((sum, m) => sum + m.weekTotal, 0)

  // Week label
  const mondayDate = parseDateKey(weekStart)
  const sundayDate = parseDateKey(weekEnd)
  const weekLabel = `${mondayDate.getDate()}.${mondayDate.getMonth() + 1}. – ${sundayDate.getDate()}.${sundayDate.getMonth() + 1}.${sundayDate.getFullYear()}`

  return {
    weekLabel,
    teamTotal,
    members,
  }
}

// ── Doku Tab ─────────────────────────────────────────────────────────────────

export type DokuCompleteness = 'complete' | 'partial' | 'missing'
export type DokuSubMode = 'offen' | 'heute' | 'abrechenbar'

export type DokuEntry = {
  job: Job
  memberNames: string[]
  customerName: string
  scheduledDate: string
  scheduledTime: string
  completedAt: number | null
  photoCount: number
  notesCount: number
  completeness: DokuCompleteness
  isAbrechenbar: boolean
  /**
   * Block 7.2.1b — `true` when a worker has reported the job finished but
   * the owner has not yet confirmed (admin-confirm-gate). UI surfaces an
   * explicit "wartet auf Bestätigung"-bucket on top of the doku list.
   */
  awaitingAdminConfirmation: boolean
}

export type DokuSummary = {
  openCount: number
  completeCount: number
  billableCount: number
}

export type DokuTabData = {
  summary: DokuSummary
  entries: DokuEntry[]
}

export function deriveDokuTab(
  jobs: Job[],
  calendarEntries: CalendarEntry[],
  teamMembers: TeamMember[],
  subMode: DokuSubMode,
  ownerNotesCounts: ReadonlyMap<string, number> = new Map(),
): DokuTabData {
  const nameMap = new Map(teamMembers.map((m) => [m.id, m.name]))
  const todayKey = formatDateKey(new Date())

  const workRelevantJobs = jobs.filter(
    (j) =>
      isJobOperational(j) &&
      (j.status === 'in_progress' || j.status === 'waiting_payment' || j.status === 'completed'),
  )

  const calByJob = new Map(calendarEntries.map((e) => [e.jobId, e]))

  const allEntries: DokuEntry[] = workRelevantJobs.map((job) => {
    const cal = calByJob.get(job.id)
    const memberNames = job.assignedMemberIds
      .map((id, i) => resolveDisplayName(id, nameMap, i))

    const ownerNotesCount = ownerNotesCounts.get(job.id) ?? 0
    const hasDocs = job.photoCount > 0 || ownerNotesCount > 0
    let completeness: DokuCompleteness
    if (job.workCompletedAt && hasDocs) {
      completeness = 'complete'
    } else if (job.workCompletedAt) {
      completeness = 'partial'
    } else {
      completeness = 'missing'
    }

    const awaitingAdminConfirmation =
      !!job.workMarkedCompleteAt && !job.workConfirmedCompleteAt

    return {
      job,
      memberNames,
      customerName: job.customer,
      scheduledDate: cal?.dateLabel ?? '',
      scheduledTime: cal?.startsAtLabel ?? '',
      completedAt: job.workCompletedAt ?? null,
      photoCount: job.photoCount,
      notesCount: ownerNotesCount,
      completeness,
      isAbrechenbar: isAbrechenbar(job, ownerNotesCount),
      awaitingAdminConfirmation,
    }
  })

  // Sort: incomplete first, then by most recent
  allEntries.sort((a, b) => {
    const aScore = a.completeness === 'missing' ? 0 : a.completeness === 'partial' ? 1 : 2
    const bScore = b.completeness === 'missing' ? 0 : b.completeness === 'partial' ? 1 : 2
    if (aScore !== bScore) return aScore - bScore
    return (b.completedAt ?? 0) - (a.completedAt ?? 0)
  })

  // Summary (always computed from all, regardless of filter)
  const openCount = allEntries.filter((e) => e.completeness !== 'complete').length
  const completeCount = allEntries.filter((e) => e.completeness === 'complete').length
  const billableCount = allEntries.filter((e) => e.isAbrechenbar).length

  // Apply sub-mode filter
  let filtered: DokuEntry[]
  switch (subMode) {
    case 'offen':
      filtered = allEntries.filter((e) => e.completeness !== 'complete')
      break
    case 'heute':
      filtered = allEntries.filter((e) => {
        const cal = calByJob.get(e.job.id)
        return cal?.dateKey === todayKey
      })
      break
    case 'abrechenbar':
      filtered = allEntries.filter((e) => e.isAbrechenbar)
      break
    default:
      filtered = allEntries
  }

  return {
    summary: { openCount, completeCount, billableCount },
    entries: filtered,
  }
}
