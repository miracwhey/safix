/**
 * Block 7.2.7b · Correction Auto-Apply
 *
 * Wendet bei `kind='wrong_time'` den vorgeschlagenen Wert (`proposedValue`,
 * Format `HH:MM-HH:MM`) auf den verknüpften `calendar_entry` an, indem
 * `CalendarRepository.updateScheduling()` (Block 7.2.7a) gerufen wird.
 *
 * Best-effort: Wenn Format kaputt, calendarEntry weg oder Repo-Error fliegt,
 * wird ein Skip-Reason zurückgegeben — Caller (`approveCorrectionWorkflow`)
 * persistiert ihn an `correction_requests.apply_skip_reason` und das
 * Status-Update geht trotzdem durch.
 *
 * Bewusst NICHT in diesem Modul:
 *  - `missing_time` (kein Bestand-Entry → eigener `add()`-Pfad in 7.2.7c)
 *  - `wrong_assignment` (braucht erst Member-Picker im Worker-Submit)
 *  - `dateLabel`-Sync (wrong_time bleibt am gleichen Tag → unverändert)
 */

import { getCalendarEntryById } from '../calendar/calendarStore'
import { getCalendarRepository } from '../calendar/repository'
import { logError } from '../observability'
import type {
  CorrectionApplySkipReason,
  CorrectionRequest,
} from '../corrections'

export type ApplyOutcome = {
  applied: boolean
  targetEntryId?: string
  skipReason?: CorrectionApplySkipReason
}

const TIME_RANGE_PATTERN = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/

function parseTimePart(part: string): { hours: number; minutes: number } | null {
  const match = part.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null
  if (hours < 0 || hours > 23) return null
  if (minutes < 0 || minutes > 59) return null
  return { hours, minutes }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

/**
 * Parst `HH:MM-HH:MM` (leading-zero-tolerant, optionale Spaces ums `-`).
 * Sanity: end muss > start sein (strikt).  Returns `null` bei jedem Fail.
 */
export function parseTimeRange(
  value: string,
): { startsAtLabel: string; endsAtLabel: string } | null {
  if (!value) return null
  const match = value.trim().match(TIME_RANGE_PATTERN)
  if (!match) return null
  const start = parseTimePart(match[1])
  const end = parseTimePart(match[2])
  if (!start || !end) return null
  const startMinutes = start.hours * 60 + start.minutes
  const endMinutes = end.hours * 60 + end.minutes
  if (endMinutes <= startMinutes) return null
  return {
    startsAtLabel: `${pad2(start.hours)}:${pad2(start.minutes)}`,
    endsAtLabel: `${pad2(end.hours)}:${pad2(end.minutes)}`,
  }
}

async function applyWrongTime(
  correction: CorrectionRequest,
): Promise<ApplyOutcome> {
  const entryId = correction.calendarEntryId
  if (!entryId) {
    return { applied: false, skipReason: 'missing_calendar_entry' }
  }
  const entry = getCalendarEntryById(entryId)
  if (!entry) {
    return { applied: false, skipReason: 'missing_calendar_entry' }
  }
  const proposed = correction.proposedValue
  if (!proposed) {
    return { applied: false, skipReason: 'invalid_time_format' }
  }
  const parsed = parseTimeRange(proposed)
  if (!parsed) {
    return { applied: false, skipReason: 'invalid_time_format' }
  }
  try {
    await getCalendarRepository().updateScheduling(entryId, {
      dateKey: entry.dateKey,
      startsAtLabel: parsed.startsAtLabel,
      endsAtLabel: parsed.endsAtLabel,
    })
    return { applied: true, targetEntryId: entryId }
  } catch (error) {
    logError('correction.apply.repository_error', error, {
      correctionId: correction.id,
      entryId,
    })
    return { applied: false, skipReason: 'repository_error' }
  }
}

/**
 * Dispatch entry-point. Aktuell nur `wrong_time` implementiert; alle anderen
 * Kinds quittieren mit `kind_not_supported` (kein Warning — erwartet).
 */
export async function applyCorrectionToTarget(
  correction: CorrectionRequest,
): Promise<ApplyOutcome> {
  if (correction.kind === 'wrong_time') {
    return applyWrongTime(correction)
  }
  return { applied: false, skipReason: 'kind_not_supported' }
}
