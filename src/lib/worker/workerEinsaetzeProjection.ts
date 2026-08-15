/**
 * Worker Einsätze-tab projection.
 *
 * Pure function: maps real CalendarEntry state into Einsätze list and detail
 * view models. No side effects, no store access.
 *
 * Grouping rules
 * ─────────────────────────────────────────────────────────────────────────────
 * Heute   entries for todayKey, status ≠ cancelled
 *   Jetzt          in_progress entries
 *   Als Nächstes   first scheduled/pending entry (scheduled sorts before pending;
 *                  entries without a start time sort after timed entries)
 *   Später heute   remaining scheduled/pending entries
 *
 * Demnächst  future entries (dateKey > today), status ∈ {scheduled, in_progress, pending}
 *            grouped by dateKey, sorted chronologically
 *
 * Abgeschlossen  completed + awaiting_payment entries across all dates, newest first
 *                (awaiting_payment = work done by worker, payment still pending customer action)
 *
 * pending rule
 * ─────────────────────────────────────────────────────────────────────────────
 * pending today  → operationally visible; treated like scheduled but sorted after
 *                  (worker must be aware the job exists even without a confirmed slot)
 * pending future → visible in Demnächst alongside scheduled
 * pending past   → excluded (stale, not operational)
 */

import type { CalendarEntry } from '../calendar/calendarTypes'
import type { Job } from '../jobs/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type EinsaetzeHeuteGroups = {
  jetzt: CalendarEntry[]
  alsNaechstes: CalendarEntry[]
  spaeterHeute: CalendarEntry[]
}

export type EinsaetzeDemnaechstGroup = {
  dateKey: string
  dateLabel: string
  entries: CalendarEntry[]
}

export type EinsaetzeListViewModel = {
  heute: EinsaetzeHeuteGroups
  demnaechst: EinsaetzeDemnaechstGroup[]
  abgeschlossen: CalendarEntry[]
}

export type EinsaetzeDetailViewModel = {
  entry: CalendarEntry
  job: Job | null
  /** Entry can be started → updateCalendarStatus(id, 'in_progress') */
  canStart: boolean
  /** Entry can be completed → updateCalendarStatus(id, 'awaiting_payment') */
  canComplete: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sort key for time labels.
 * Entries without a start time (\uffff) sort after any real HH:MM label.
 */
function timeKey(entry: CalendarEntry): string {
  return entry.startsAtLabel || '\uffff'
}

/**
 * Comparator for today's operational (scheduled/pending) entries.
 * scheduled sorts before pending; within the same status, sorted by start time.
 */
function compareOperational(a: CalendarEntry, b: CalendarEntry): number {
  if (a.status !== b.status) {
    if (a.status === 'scheduled') return -1
    if (b.status === 'scheduled') return 1
  }
  return timeKey(a).localeCompare(timeKey(b))
}

// ── List projection ───────────────────────────────────────────────────────────

/**
 * Derives the Einsätze tab list view model from the worker's filtered entries.
 *
 * @param userEntries  CalendarEntries already filtered to this worker's assignments
 * @param todayKey     YYYY-MM-DD key for today
 */
export function deriveEinsaetzeListViewModel(
  userEntries: CalendarEntry[],
  todayKey: string
): EinsaetzeListViewModel {
  // ── Heute ─────────────────────────────────────────────────────────────────
  const todayActive = userEntries.filter(
    (e) => e.dateKey === todayKey && e.status !== 'cancelled'
  )
  const jetzt = todayActive.filter((e) => e.status === 'in_progress')
  const todayOperational = todayActive
    .filter((e) => e.status === 'scheduled' || e.status === 'pending')
    .sort(compareOperational)

  const alsNaechstes = todayOperational.slice(0, 1)
  const spaeterHeute = todayOperational.slice(1)

  // ── Demnächst ─────────────────────────────────────────────────────────────
  const futureEntries = userEntries
    .filter(
      (e) =>
        e.dateKey > todayKey &&
        (e.status === 'scheduled' || e.status === 'in_progress' || e.status === 'pending')
    )
    .sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey)
      return timeKey(a).localeCompare(timeKey(b))
    })

  const demnaechstMap = new Map<string, EinsaetzeDemnaechstGroup>()
  for (const entry of futureEntries) {
    const existing = demnaechstMap.get(entry.dateKey)
    if (existing) {
      existing.entries.push(entry)
    } else {
      demnaechstMap.set(entry.dateKey, {
        dateKey: entry.dateKey,
        dateLabel: entry.dateLabel,
        entries: [entry],
      })
    }
  }
  const demnaechst = Array.from(demnaechstMap.values())

  // ── Abgeschlossen ─────────────────────────────────────────────────────────
  // awaiting_payment = work done; payment is a customer action → operationally
  // complete from the worker's perspective; shown here until payment clears.
  const abgeschlossen = userEntries
    .filter((e) => e.status === 'completed' || e.status === 'awaiting_payment')
    .sort((a, b) => {
      if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey)
      return b.startsAtLabel.localeCompare(a.startsAtLabel)
    })

  return {
    heute: { jetzt, alsNaechstes, spaeterHeute },
    demnaechst,
    abgeschlossen,
  }
}

// ── Detail projection ─────────────────────────────────────────────────────────

/**
 * Derives the Einsätze detail view model for a single entry.
 *
 * @param entry  The CalendarEntry to display
 * @param jobs   All known jobs — used only for optional job context lookup
 */
export function deriveEinsaetzeDetailViewModel(
  entry: CalendarEntry,
  jobs: Job[]
): EinsaetzeDetailViewModel {
  const job = entry.jobId ? (jobs.find((j) => j.id === entry.jobId) ?? null) : null

  return {
    entry,
    job,
    canStart: entry.status === 'scheduled' || entry.status === 'pending',
    canComplete: entry.status === 'in_progress',
  }
}
