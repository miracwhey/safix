import type { CalendarEntry } from './calendarTypes'
import { formatDateKey } from './calendarEngine'

export type TeamLoad = {
  memberId: string
  jobs: CalendarEntry[]
}

export type OperationsSummary = {
  totalAssignments: number
  busyMembers: number
  overbookedMembers: number
  freeMembers: number
}

function isTodayEntry(entry: CalendarEntry): boolean {
  return entry.dateLabel === 'Heute' || entry.dateKey === formatDateKey(new Date())
}

/**
 * Active = work that actually consumes a member's capacity today. Completed,
 * awaiting_payment, cancelled and (not-yet-scheduled) pending entries must not
 * count, or a member who finished 3 jobs today is falsely flagged overbooked.
 * Mirrors getTimedEntriesForDay (calendarSelectors).
 */
function isActiveEntry(entry: CalendarEntry): boolean {
  return entry.status === 'scheduled' || entry.status === 'in_progress'
}

export function buildTeamLoad(entries: CalendarEntry[]): TeamLoad[] {
  const map = new Map<string, CalendarEntry[]>()

  for (const entry of entries) {
    for (const memberId of entry.assignedMemberIds) {
      const list = map.get(memberId) ?? []
      list.push(entry)
      map.set(memberId, list)
    }
  }

  return Array.from(map.entries()).map(([memberId, jobs]) => ({
    memberId,
    jobs,
  }))
}

export function buildTodayTeamLoad(entries: CalendarEntry[]): TeamLoad[] {
  return buildTeamLoad(entries.filter((e) => isTodayEntry(e) && isActiveEntry(e)))
}

export function getOverbookedMembers(teamLoads: TeamLoad[]): TeamLoad[] {
  return teamLoads.filter((load) => load.jobs.length > 2)
}

export function getBusyMembers(teamLoads: TeamLoad[]): TeamLoad[] {
  return teamLoads.filter((load) => load.jobs.length > 0)
}

export function buildOperationsSummary(
  teamLoads: TeamLoad[],
  totalTeamMembers: number
): OperationsSummary {
  const totalAssignments = teamLoads.reduce(
    (sum, load) => sum + load.jobs.length,
    0
  )
  const busyMembers = getBusyMembers(teamLoads).length
  const overbookedMembers = getOverbookedMembers(teamLoads).length
  const freeMembers = Math.max(totalTeamMembers - busyMembers, 0)

  return {
    totalAssignments,
    busyMembers,
    overbookedMembers,
    freeMembers,
  }
}
