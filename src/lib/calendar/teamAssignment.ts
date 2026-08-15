import type { CalendarEntry } from './calendarTypes'

export function assignMember(
  entry: CalendarEntry,
  memberId: string
): CalendarEntry {
  if (entry.assignedMemberIds.includes(memberId)) {
    return entry
  }

  return {
    ...entry,
    assignedMemberIds: [...entry.assignedMemberIds, memberId],
    updatedAt: Date.now(),
  }
}

export function removeMember(
  entry: CalendarEntry,
  memberId: string
): CalendarEntry {
  return {
    ...entry,
    assignedMemberIds: entry.assignedMemberIds.filter((id) => id !== memberId),
    updatedAt: Date.now(),
  }
}
