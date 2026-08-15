import {
  buildOperationsSummary,
  buildTeamLoad,
  buildTodayTeamLoad,
  getOverbookedMembers,
} from './operationsEngine'
import type { CalendarEntry } from './calendarTypes'

export function getTeamLoads(entries: CalendarEntry[]) {
  return buildTeamLoad(entries)
}

export function getTodayTeamLoads(entries: CalendarEntry[]) {
  return buildTodayTeamLoad(entries)
}

export function getOverbookedTeamLoads(entries: CalendarEntry[]) {
  return getOverbookedMembers(buildTodayTeamLoad(entries))
}

export function getOperationsSummary(
  entries: CalendarEntry[],
  totalTeamMembers: number
) {
  return buildOperationsSummary(buildTodayTeamLoad(entries), totalTeamMembers)
}
