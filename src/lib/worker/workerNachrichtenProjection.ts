/**
 * Worker Nachrichten projection.
 *
 * Pure function: maps real CalendarEntry state + optional real internal thread
 * enrichment into worker-visible thread view models.
 * No side effects, no store access.
 *
 * Segment classification rules
 * ────────────────────────────────────────────────────────────────────────────
 * Einsätze  CalendarEntry records assigned to this worker (status ≠ cancelled).
 *           Each entry becomes one WorkerNachrichtenThread. The thread ID is
 *           'einsatz-{entry.id}', stable across renders and used for routing.
 *           When a real InternalMessageThread exists for the entry, its
 *           lastMessageBody / lastMessageAt / isUnread are merged in.
 *
 * Büro      Singleton office thread for the worker's company.
 *           Thread ID is the real DB UUID (no prefix).
 *           Present when officeThreadData is passed in (i.e. after getOrCreate
 *           resolves on the list screen). Empty state when null.
 *
 * Team      Singleton team thread for the worker's company.
 *           Thread ID is the real DB UUID (no prefix).
 *           Present when teamThreadData is passed in. Empty state when null.
 *
 * Real messaging support
 * ────────────────────────────────────────────────────────────────────────────
 * The internalMessages domain provides real company-internal message threads.
 * All three segment types are now powered by real DB state when thread data
 * is passed in. Send path is handled per-thread in WorkerNachrichtenThreadScreen.
 */

import type { CalendarEntry } from '../calendar/calendarTypes'

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkerThreadSegment = 'einsaetze' | 'team' | 'buero'

export type WorkerEinsatzContext = {
  /** Real CalendarEntry ID — enables back-link to Einsätze detail. */
  entryId: string
  title: string
  date: string
  location: string
}

export type WorkerNachrichtenThread = {
  id: string                         // 'einsatz-{entry.id}' for Einsatz; real UUID for office/team
  segment: WorkerThreadSegment
  title: string                      // Real job title or group name
  subtitle: string                   // Real customer name or context
  initials: string                   // Derived from title
  lastMessage: string                // Real last message body or '' if none
  timestamp: string                  // From last message timestamp or entry date
  unread: boolean                    // Real unread state when thread data exists
  needsResponse: boolean             // Reserved — always false for now
  einsatzContext?: WorkerEinsatzContext
}

export type WorkerNachrichtenViewModel = {
  einsaetze: WorkerNachrichtenThread[]
  team: WorkerNachrichtenThread[]
  buero: WorkerNachrichtenThread[]
  canSend: boolean
}

/**
 * Slim enrichment data extracted from a real InternalMessageThread for an
 * assignment thread. Passed from the screen into the projection to avoid a
 * direct dependency on the internalMessages domain types.
 */
export type WorkerThreadEnrichment = {
  lastMessageBody?: string
  lastMessageAt?: number
  isUnread: boolean
}

/**
 * Data for a real office or team thread singleton.
 * Passed from the screen into the projection after getOrCreate resolves.
 * Thread ID is the real DB UUID — used directly as the route target.
 */
export type WorkerGroupThreadData = {
  /** Real thread UUID. Used as the thread ID in navigation. */
  id: string
  title: string
  subtitle: string
  lastMessageBody?: string
  lastMessageAt?: number
  isUnread: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function deriveInitials(title: string): string {
  const words = title.trim().split(/\s+/)
  if (words.length >= 2) {
    return ((words[0][0] ?? '') + (words[1][0] ?? '')).toUpperCase()
  }
  return title.slice(0, 2).toUpperCase()
}

function prevDateKey(today: string): string {
  const [year, month, day] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
}

export function deriveTimestamp(
  entry: CalendarEntry,
  todayKey: string,
  lastMessageAt?: number,
): string {
  if (lastMessageAt) {
    const d = new Date(lastMessageAt)
    const msgKey = d.toISOString().slice(0, 10)
    if (msgKey === todayKey) {
      return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    }
    if (msgKey === prevDateKey(todayKey)) return 'Gestern'
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
  }
  // Fallback to entry date when no messages exist yet.
  if (entry.dateKey === todayKey) {
    return entry.startsAtLabel || 'Heute'
  }
  if (entry.dateKey === prevDateKey(todayKey)) {
    return 'Gestern'
  }
  return entry.dateLabel
}

/** Timestamp derivation for office/team threads (no CalendarEntry anchor). */
function deriveGroupTimestamp(lastMessageAt: number | undefined, todayKey: string): string {
  if (!lastMessageAt) return ''
  const d = new Date(lastMessageAt)
  const msgKey = d.toISOString().slice(0, 10)
  if (msgKey === todayKey) {
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  if (msgKey === prevDateKey(todayKey)) return 'Gestern'
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
}

/**
 * Comparator for Einsatz thread ordering.
 *
 * Priority:
 *   1. in_progress — active assignment first
 *   2. scheduled/pending today — by start time
 *   3. scheduled/pending future — by dateKey then start time
 *   4. completed — newest first
 *   (cancelled is excluded before this comparator is reached)
 */
export function einsatzThreadOrder(
  a: CalendarEntry,
  b: CalendarEntry,
  todayKey: string,
): number {
  // Active first
  if (a.status === 'in_progress' && b.status !== 'in_progress') return -1
  if (b.status === 'in_progress' && a.status !== 'in_progress') return 1

  // Completed last
  if (a.status === 'completed' && b.status !== 'completed') return 1
  if (b.status === 'completed' && a.status !== 'completed') return -1
  if (a.status === 'completed' && b.status === 'completed') {
    if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey)
    return (b.startsAtLabel || '').localeCompare(a.startsAtLabel || '')
  }

  // Today before future
  const aToday = a.dateKey === todayKey
  const bToday = b.dateKey === todayKey
  if (aToday && !bToday) return -1
  if (bToday && !aToday) return 1

  // Within the same phase: by date then start time
  if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey)
  return (a.startsAtLabel || '\uffff').localeCompare(b.startsAtLabel || '\uffff')
}

// ── Internal builder ──────────────────────────────────────────────────────────

function buildGroupThread(
  data: WorkerGroupThreadData,
  segment: 'buero' | 'team',
  todayKey: string,
): WorkerNachrichtenThread {
  return {
    id: data.id,
    segment,
    title: data.title,
    subtitle: data.subtitle,
    initials: deriveInitials(data.title),
    lastMessage: data.lastMessageBody ?? '',
    timestamp: deriveGroupTimestamp(data.lastMessageAt, todayKey),
    unread: data.isUnread,
    needsResponse: false,
  }
}

// ── Projection ────────────────────────────────────────────────────────────────

/**
 * Derives the worker Nachrichten view model from the worker's real CalendarEntries,
 * optional assignment thread enrichment, and optional office/team thread data.
 *
 * @param userEntries         CalendarEntries already filtered to this worker's assignments
 * @param todayKey            YYYY-MM-DD key for today (timestamp derivation + sorting)
 * @param enrichmentByEntryId Optional map of calendarEntryId → real assignment thread enrichment.
 *                            When present, last-message preview, timestamps and unread
 *                            indicators reflect real DB state.
 * @param officeThreadData    Optional real office thread data. When present, Büro segment
 *                            shows a real thread row with live last-message and unread state.
 * @param teamThreadData      Optional real team thread data. When present, Team segment
 *                            shows a real thread row with live last-message and unread state.
 */
export function deriveNachrichtenViewModel(
  userEntries: CalendarEntry[],
  todayKey: string,
  enrichmentByEntryId?: Map<string, WorkerThreadEnrichment>,
  officeThreadData?: WorkerGroupThreadData | null,
  teamThreadData?: WorkerGroupThreadData | null,
): WorkerNachrichtenViewModel {
  const einsaetze: WorkerNachrichtenThread[] = userEntries
    .filter((e) => e.status !== 'cancelled')
    .sort((a, b) => einsatzThreadOrder(a, b, todayKey))
    .map((entry) => {
      const enrichment = enrichmentByEntryId?.get(entry.id)
      return {
        id: `einsatz-${entry.id}`,
        segment: 'einsaetze' as const,
        title: entry.title,
        subtitle: entry.customerName,
        initials: deriveInitials(entry.title),
        lastMessage: enrichment?.lastMessageBody ?? '',
        timestamp: deriveTimestamp(entry, todayKey, enrichment?.lastMessageAt),
        unread: enrichment?.isUnread ?? false,
        needsResponse: false,
        einsatzContext: {
          entryId: entry.id,
          title: entry.title,
          date: entry.dateLabel,
          location: entry.location,
        },
      }
    })

  const buero: WorkerNachrichtenThread[] = officeThreadData
    ? [buildGroupThread(officeThreadData, 'buero', todayKey)]
    : []

  const team: WorkerNachrichtenThread[] = teamThreadData
    ? [buildGroupThread(teamThreadData, 'team', todayKey)]
    : []

  return {
    einsaetze,
    buero,
    team,
    // canSend is true when real thread data is wired in by the screen.
    // When enrichmentByEntryId is undefined (e.g. during bootstrap or in tests
    // that call the projection in isolation), send is treated as unavailable.
    // The actual composer gating in the thread detail screen uses realThreadId,
    // not this flag — but we keep canSend honest.
    canSend: enrichmentByEntryId !== undefined,
  }
}

/**
 * Finds a thread by ID across all segments.
 * Returns undefined if the thread is not found.
 */
export function findNachrichtenThread(
  vm: WorkerNachrichtenViewModel,
  threadId: string,
): WorkerNachrichtenThread | undefined {
  return [...vm.einsaetze, ...vm.team, ...vm.buero].find((t) => t.id === threadId)
}
