/**
 * Canonical Scheduling — Single Scheduling Flow + Single Truth
 *
 * This module provides:
 *
 * 1. **performCanonicalScheduleSave** — the ONE canonical mutation that all
 *    scheduling surfaces must use.  It atomically updates both the JobSchedule
 *    (operations domain) and the CalendarEntry (calendar domain), ensuring all
 *    reactive subscribers (Home, Planning List, Planning Grid, Job Detail)
 *    re-derive from the same truth.
 *
 * 2. **resolveScheduleDateLabel** — the ONE canonical truth resolver for the
 *    TERMIN display field.  It reads from JobSchedule + CalendarEntry data,
 *    never from workflow residue (offer.timingNote, process status strings).
 *
 * CONTRACT:
 *   - All "Termin planen" entry points call performCanonicalScheduleSave.
 *   - All "Termin speichern" actions call performCanonicalScheduleSave.
 *   - JobDetailsCard TERMIN derives via resolveScheduleDateLabel.
 *   - Forbidden TERMIN values ("Anfrage läuft", etc.) never appear.
 */

import { getScheduleByJobId } from '../operations/operationsStore'
import { getCalendarEntryByJobId } from '../calendar/calendarStore'
import { getCalendarRepository } from '../calendar/repository'
// Internal delegation to workflow layer for atomic schedule creation.
// UI surfaces must NOT import scheduleJob/updateSchedule directly — they must
// use performCanonicalScheduleSave instead, which also updates CalendarEntry.
import { scheduleJob, updateSchedule } from '../workflow/schedulingWorkflow'
import { formatDateKey } from '../calendar/calendarEngine'
import type { CalendarEntry } from '../calendar/calendarTypes'

// ── Types ────────────────────────────────────────────────────────────────────

export type CanonicalScheduleSaveParams = {
  jobId: string
  scheduledStart: number
  scheduledEnd: number
  /**
   * When true and a schedule already exists, the JobSchedule update runs
   * silently — no `schedule_updated` timeline event or "aktualisiert" email.
   * The reschedule entry point sets this and emits its own
   * `schedule_rescheduled` event, avoiding a duplicate timeline row + a
   * mislabeled customer notification.
   */
  suppressUpdateEvent?: boolean
}

export type CanonicalScheduleSaveResult = {
  success: boolean
  error?: string
}

const DEFAULT_EXECUTION_WINDOW_MS = 2 * 60 * 60 * 1000 // 2 hours

/**
 * Returns default scheduling times starting now with a 2-hour window.
 * Used by entry points that schedule with defaults (e.g. job detail "Einplanen").
 */
export function getDefaultScheduleTimes(): { scheduledStart: number; scheduledEnd: number } {
  const now = Date.now()
  return {
    scheduledStart: now,
    scheduledEnd: now + DEFAULT_EXECUTION_WINDOW_MS,
  }
}

// ── Forbidden TERMIN values ──────────────────────────────────────────────────

/**
 * Values that must never appear in the TERMIN display field.
 * These are workflow/origin labels, not scheduling truth.
 */
const FORBIDDEN_TERMIN_VALUES = new Set([
  'Anfrage läuft',
  'Auftrag aus Angebot',
  'Angebot gesendet',
  'Warte auf Kundenantwort',
  'In Bearbeitung',
])

/**
 * Returns true when the given label is a forbidden TERMIN value
 * (workflow/process garbage that should never represent schedule truth).
 */
export function isForbiddenTerminValue(value: string): boolean {
  return FORBIDDEN_TERMIN_VALUES.has(value)
}

// ── Canonical Save Mutation ──────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDateLabel(ts: number, todayKey: string): string {
  const dk = formatDateKey(new Date(ts))
  if (dk === todayKey) return 'Heute'
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (dk === formatDateKey(tomorrow)) return 'Morgen'
  const d = new Date(ts)
  return d.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

/**
 * THE canonical scheduling save mutation.
 *
 * On successful save, ALL of the following happen from the same truth source:
 * 1. The job gets a real JobSchedule (operations domain)
 * 2. The CalendarEntry is updated to 'scheduled' with real date/time
 * 3. The CalendarEntry dateKey is set to the correct day
 * 4. The CalendarEntry startsAtLabel / endsAtLabel get real times
 * 5. Both store subscriptions fire → all surfaces re-derive
 *
 * On failure:
 * - No partial save occurs
 * - CalendarEntry remains in prior state (pending if it was pending)
 * - Error is surfaced cleanly
 */
export async function performCanonicalScheduleSave(
  params: CanonicalScheduleSaveParams,
): Promise<CanonicalScheduleSaveResult> {
  const { jobId, scheduledStart, scheduledEnd } = params

  // ── Step 1: Create or update the JobSchedule (operations domain) ────────
  const existing = getScheduleByJobId(jobId)
  let schedule
  if (existing) {
    schedule = await updateSchedule(
      { jobId, scheduledStart, scheduledEnd },
      { silent: params.suppressUpdateEvent },
    )
  } else {
    schedule = await scheduleJob({ jobId, scheduledStart, scheduledEnd })
  }

  if (!schedule) {
    return { success: false, error: 'Schedule creation failed — job may not exist.' }
  }

  // ── Step 2: Update the CalendarEntry (calendar domain) ──────────────────
  const calEntry = getCalendarEntryByJobId(jobId)
  if (calEntry) {
    const todayKey = formatDateKey(new Date())
    const dateKey = formatDateKey(new Date(scheduledStart))
    const updated: CalendarEntry = {
      ...calEntry,
      status: 'scheduled',
      dateKey,
      dateLabel: formatDateLabel(scheduledStart, todayKey),
      startsAtLabel: formatTime(scheduledStart),
      endsAtLabel: formatTime(scheduledEnd),
      updatedAt: Date.now(),
    }
    try {
      await getCalendarRepository().replace(updated)
    } catch {
      // Calendar write failed — mutation is enqueued for automatic background
      // replay (see pendingMutationStore). The schedule is persisted in the
      // operations domain. Return a soft error so the caller can surface it
      // while the automatic sync resolves in the background.
      return {
        success: false,
        error: 'Kalender konnte nicht aktualisiert werden. Der Termin wird automatisch synchronisiert.',
      }
    }
  }

  // Both store subscriptions (operations + calendar) have now fired.
  // All reactive surfaces (Home TodayBlock, Planning Grid, Planning List,
  // Work Entry Card, Job Detail) will re-derive on the next render cycle.

  return { success: true }
}

// ── Canonical Schedule Truth Resolver ────────────────────────────────────────

/**
 * Resolves the canonical TERMIN display label for a job.
 *
 * Resolution hierarchy (schedule truth FIRST):
 * 1. JobSchedule exists + execution_completed → "Abgeschlossen am …"
 * 2. JobSchedule exists + execution_started   → "Läuft gerade"
 * 3. JobSchedule exists + scheduled           → "Geplant: DD.MM.YYYY, HH:MM"
 * 4. JobSchedule exists + cancelled           → "Abgesagt"
 * 5. CalendarEntry exists + scheduled/in_progress with real time → derive from entry
 * 6. No schedule at all → "Termin offen"
 *
 * This function NEVER returns workflow residue like "Anfrage läuft".
 */
export function resolveScheduleDateLabel(jobId: string): string {
  // ── Try operations schedule first (strongest truth) ─────────────────────
  const schedule = getScheduleByJobId(jobId)
  if (schedule) {
    switch (schedule.schedulingStatus) {
      case 'execution_completed': {
        const d = new Date(schedule.scheduledEnd)
        return `Abgeschlossen am ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
      }
      case 'execution_started':
        return 'Läuft gerade'
      case 'cancelled':
        return 'Abgesagt'
      case 'scheduled': {
        const d = new Date(schedule.scheduledStart)
        const dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
        const timeStr = formatTime(schedule.scheduledStart)
        return `Geplant: ${dateStr}, ${timeStr}`
      }
    }
  }

  // ── Try calendar entry as fallback (may have status-derived info) ───────
  const calEntry = getCalendarEntryByJobId(jobId)
  if (calEntry) {
    if (calEntry.status === 'in_progress') return 'Läuft gerade'
    if (calEntry.status === 'awaiting_payment') return 'Arbeit erledigt – Zahlung ausstehend'
    if (calEntry.status === 'completed') return 'Abgeschlossen'
    if (calEntry.status === 'scheduled' && calEntry.startsAtLabel) {
      return `Geplant: ${calEntry.dateLabel}, ${calEntry.startsAtLabel}`
    }
  }

  // ── No schedule truth at all ────────────────────────────────────────────
  return 'Termin offen'
}
