/**
 * Worker Konto tab — pure view-model projection.
 *
 * Maps real domain state (membership, calendar entries) into a flat view model
 * for WorkerKontoScreen. No side effects, no fetches — pure derivation.
 *
 * Design constraints:
 * - Time-tracking domain does not exist yet. Zeitübersicht is derived from
 *   CalendarEntry start/end times and is clearly labelled "geplant" (planned),
 *   NOT as payroll-accurate logged hours.
 * - Korrekturen exists as a standalone domain (src/lib/corrections).
 *   The KorrekturenCard in the screen reads directly from useWorkerCorrections()
 *   and is not part of this projection.
 * - Abwesenheit and Unterlagen domains do not exist yet.
 *   The screen renders honest bounded states for those sections.
 */

import type { CalendarEntry } from '../calendar/calendarTypes'
import type { WorkerMembership } from '../company/membership'

// ── Output types ─────────────────────────────────────────────────────────────

export type KontoHeaderViewModel = {
  /** Name from team_members.full_name, humanised from email as fallback */
  displayName: string
  email: string
  /** Trade/role label, e.g. "Elektriker" — falls back to "Mitarbeiter" */
  roleLabel: string
  /** Company name from providers table, null when unavailable */
  companyName: string | null
  /** Two-letter uppercase initials derived from displayName */
  initials: string
}

export type KontoZeitübersichtViewModel = {
  /** Formatted week range, e.g. "7. Apr – 13. Apr" */
  weekRange: string
  /**
   * Planned hours this week derived from assigned calendar entries.
   * Formatted as German decimal string, e.g. "8,5".
   * Label: "geplant" — these are scheduled time windows, NOT logged hours.
   */
  weekHoursLabel: string
  /**
   * Planned hours today.
   */
  todayHoursLabel: string
  /** Number of non-cancelled assignments this week */
  weekCount: number
  /** Number of non-cancelled assignments today */
  todayCount: number
  /** True when no assignments exist for this week at all */
  isEmpty: boolean
}

export type WorkerKontoViewModel = {
  header: KontoHeaderViewModel
  zeitubersicht: KontoZeitübersichtViewModel
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Humanises an email local-part into a display name.
 * "leon.becker" → "Leon Becker", "maxmuster" → "Maxmuster"
 */
function emailToDisplayName(email: string): string {
  const local = email.split('@')[0]
  return local
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function deriveDisplayName(memberName: string, email: string): string {
  const name = memberName.trim()
  if (name) return name
  return emailToDisplayName(email)
}

function deriveInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  return displayName.slice(0, 2).toUpperCase()
}

/**
 * Returns ISO week bounds (Monday → Sunday) for the given dateKey.
 * Uses noon time to avoid DST edge cases on date arithmetic.
 */
function getWeekBounds(todayKey: string): {
  weekStart: string
  weekEnd: string
  weekRange: string
} {
  const today = new Date(todayKey + 'T12:00:00')
  const dayOfWeek = today.getDay() === 0 ? 6 : today.getDay() - 1 // Mon=0

  const monday = new Date(today)
  monday.setDate(today.getDate() - dayOfWeek)

  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const toKey = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const toLabel = (d: Date): string =>
    d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })

  return {
    weekStart: toKey(monday),
    weekEnd: toKey(sunday),
    weekRange: `${toLabel(monday)} – ${toLabel(sunday)}`,
  }
}

/** Parses "HH:MM" → total minutes from midnight. Returns 0 on parse failure. */
function parseTimeMinutes(label: string): number {
  const parts = label.split(':')
  if (parts.length !== 2) return 0
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  return isNaN(h) || isNaN(m) ? 0 : h * 60 + m
}

/** Duration of one calendar entry in hours, based on start/end time labels. */
function entryDurationHours(entry: CalendarEntry): number {
  const startMin = parseTimeMinutes(entry.startsAtLabel)
  const endMin = parseTimeMinutes(entry.endsAtLabel)
  const diff = endMin - startMin
  return diff > 0 ? diff / 60 : 0
}

/** Formats a decimal hour value as German-style string, e.g. 8.5 → "8,5" */
function formatHours(hours: number): string {
  return hours.toFixed(1).replace('.', ',')
}

const ACTIVE_STATUSES = new Set(['scheduled', 'in_progress', 'completed'])

// ── Public projection function ────────────────────────────────────────────────

export function deriveWorkerKontoViewModel(input: {
  membership: WorkerMembership | null
  email: string | null
  companyName: string | null
  /** CalendarEntry list already filtered to this worker's assigned entries */
  workerEntries: CalendarEntry[]
  /** Current date as YYYY-MM-DD string */
  todayKey: string
}): WorkerKontoViewModel {
  const { membership, email, companyName, workerEntries, todayKey } = input

  const emailStr = email ?? ''
  const memberName = membership?.name ?? ''
  const displayName = deriveDisplayName(memberName, emailStr)
  const initials = deriveInitials(displayName || 'MA')
  const roleLabel = membership?.role?.trim() || 'Mitarbeiter'

  // ── Zeitübersicht ─────────────────────────────────────────────────────────

  const { weekStart, weekEnd, weekRange } = getWeekBounds(todayKey)

  const todayEntries = workerEntries.filter(
    (e) => e.dateKey === todayKey && ACTIVE_STATUSES.has(e.status),
  )
  const weekEntries = workerEntries.filter(
    (e) =>
      e.dateKey >= weekStart &&
      e.dateKey <= weekEnd &&
      ACTIVE_STATUSES.has(e.status),
  )

  const todayHours = todayEntries.reduce(
    (sum, e) => sum + entryDurationHours(e),
    0,
  )
  const weekHours = weekEntries.reduce(
    (sum, e) => sum + entryDurationHours(e),
    0,
  )

  return {
    header: {
      displayName,
      email: emailStr,
      roleLabel,
      companyName: companyName ?? null,
      initials,
    },
    zeitubersicht: {
      weekRange,
      weekHoursLabel: formatHours(weekHours),
      todayHoursLabel: formatHours(todayHours),
      weekCount: weekEntries.length,
      todayCount: todayEntries.length,
      isEmpty: weekEntries.length === 0,
    },
  }
}
