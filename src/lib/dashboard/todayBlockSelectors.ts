/**
 * Today Block Selectors
 *
 * Derives a compact MINI DAY PLANNER summary for the craftsman home screen.
 *
 * The today block answers:
 *   – What is scheduled for today?
 *   – What is my next upcoming appointment?
 *   – When, where, and for whom?
 *
 * It uses the same CalendarEntry data that powers the full schedule/calendar screen.
 * No split-brain home-only logic — one scheduling truth.
 *
 * Time truth rules:
 *   – Only show real time values extracted from scheduling data.
 *   – If no real time exists, omit time — never fabricate "09:00".
 *   – "Jetzt" is a valid real-time label for in_progress entries.
 *
 * The block is a mini day planner with 4 explicit modes:
 *   1. today_has_items — real scheduled/in-progress items exist for today
 *   2. today_empty_but_upcoming — nothing today, but next real scheduled item exists
 *   3. only_pending_exists — work exists but none is truly scheduled yet
 *   4. no_relevant_work — no relevant work at all
 *
 * It is internally bounded/scrollable when many items exist.
 */

import type { CalendarEntry } from '../calendar/calendarTypes'

// ── Types ────────────────────────────────────────────────────────────────────

export type TodayBlockMode =
  | 'today_has_items'
  | 'today_empty_but_upcoming'
  | 'only_pending_exists'
  | 'no_relevant_work'

export type TodayBlockItem = {
  id: string
  jobId: string
  title: string
  customerName: string
  location: string
  /** Real time label (e.g. "14:00", "Jetzt") or empty string if no real time */
  timeLabel: string
  /** Human planning status ("In Arbeit" or "Geplant") */
  statusLabel: string
  /** Whether timeLabel represents a real scheduled time */
  hasRealTime: boolean
}

export type TodayBlockSummary = {
  /** Whether the block should render at all */
  visible: boolean
  /** Which display mode to use */
  mode: TodayBlockMode
  /** Number of appointments/jobs scheduled for today */
  todayCount: number
  /** Planner header label — always "Heute" */
  headline: string
  /** Body context message for empty/quiet modes, or count summary for item modes */
  subtitle: string
  /** Optional secondary support line for empty/quiet modes */
  secondarySubtitle: string
  /** Today's scheduled items (only populated in today_has_items mode) */
  items: TodayBlockItem[]
  /** Next upcoming scheduled item preview (for today_empty_but_upcoming mode) */
  upcomingItem: TodayBlockItem | null
  /** Upcoming preview hint, e.g. "Nächster Einsatz Mittwoch" */
  upcomingHint: string
  /** CTA label */
  ctaLabel: string
  /** CTA route */
  ctaRoute: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true when the label represents a real time value (not empty/missing). */
function isRealTime(label: string): boolean {
  if (!label) return false
  // "Jetzt" is a valid real-time indicator for in-progress items
  if (label === 'Jetzt') return true
  // HH:MM pattern
  return /^\d{1,2}:\d{2}$/.test(label)
}

function toBlockItem(entry: CalendarEntry & { jobId: string }): TodayBlockItem {
  const hasReal = isRealTime(entry.startsAtLabel)
  return {
    id: entry.id,
    jobId: entry.jobId,
    title: entry.title,
    customerName: entry.customerName,
    location: entry.location,
    timeLabel: hasReal ? entry.startsAtLabel : '',
    statusLabel: entry.status === 'in_progress' ? 'In Arbeit' : 'Geplant',
    hasRealTime: hasReal,
  }
}

// ── Main derivation ──────────────────────────────────────────────────────────

/**
 * Derives the today block summary from calendar entries.
 *
 * Render contract (4 explicit modes):
 *   MODE 1 — today_has_items:
 *     Real today scheduled/in-progress items exist.
 *     Planner body shows today rows, internally scrollable.
 *
 *   MODE 2 — today_empty_but_upcoming:
 *     No today items, but future scheduled work exists.
 *     Planner body shows compact empty-today message + upcoming preview.
 *
 *   MODE 3 — only_pending_exists:
 *     Work exists in the system but none is truly scheduled.
 *     Planner body stays quiet and honest: "Keine Einsätze heute terminiert".
 *     Pending entries NEVER appear as today planned items.
 *
 *   MODE 4 — no_relevant_work:
 *     No relevant scheduled/upcoming/pending work exists at all.
 *     Planner body remains a small quiet shell.
 *
 * The block is visible in all modes (planner shell always present).
 * It is hidden ONLY during initial load before any data arrives
 * (the screen orchestrator controls that via its own readiness state).
 *
 * @param entries  All calendar entries (from the same store the schedule screen uses)
 * @param todayKey Date key for "today" in YYYY-MM-DD format (e.g. "2026-03-30")
 */
export function deriveTodayBlock(
  entries: CalendarEntry[],
  todayKey: string,
): TodayBlockSummary {
  // Only consider scheduled or in_progress entries — completed/cancelled/pending are irrelevant
  // for the actual plan. Pending entries (booked jobs) are deliberately excluded: they are not
  // truly scheduled and must never appear as planned today content.
  const active = entries.filter(
    (e): e is CalendarEntry & { jobId: string } =>
      (e.status === 'scheduled' || e.status === 'in_progress') && !!e.jobId,
  )

  // Check for pending entries (booked but not yet scheduled) — used to distinguish
  // "only pending work exists" from "no relevant work at all".
  const hasPending = entries.some((e) => e.status === 'pending')

  // Split into today entries and future entries
  const todayEntries = active
    .filter((e) => e.dateKey === todayKey)
    .sort((a, b) => {
      // Real times first, then alphabetical; "Jetzt" sorts before HH:MM
      const aReal = isRealTime(a.startsAtLabel)
      const bReal = isRealTime(b.startsAtLabel)
      if (aReal && !bReal) return -1
      if (!aReal && bReal) return 1
      return a.startsAtLabel.localeCompare(b.startsAtLabel)
    })

  const futureEntries = active
    .filter((e) => e.dateKey > todayKey)
    .sort((a, b) => {
      const dayCompare = a.dateKey.localeCompare(b.dateKey)
      if (dayCompare !== 0) return dayCompare
      const aReal = isRealTime(a.startsAtLabel)
      const bReal = isRealTime(b.startsAtLabel)
      if (aReal && !bReal) return -1
      if (!aReal && bReal) return 1
      return a.startsAtLabel.localeCompare(b.startsAtLabel)
    })

  const todayCount = todayEntries.length

  // ── MODE 1: today_has_items — real scheduled/in-progress items for today ──
  if (todayCount > 0) {
    const allItems = todayEntries.map(toBlockItem)
    return {
      visible: true,
      mode: 'today_has_items',
      todayCount,
      headline: 'Heute',
      subtitle: todayCount === 1
        ? `1 Einsatz heute`
        : `${todayCount} Einsätze heute`,
      secondarySubtitle: '',
      items: allItems,
      upcomingItem: null,
      upcomingHint: '',
      ctaLabel: 'Planung öffnen →',
      ctaRoute: '/craftsman/operations',
    }
  }

  // ── MODE 2: today_empty_but_upcoming — nothing today, future scheduled exists ──
  if (futureEntries.length > 0) {
    const next = futureEntries[0]
    return {
      visible: true,
      mode: 'today_empty_but_upcoming',
      todayCount: 0,
      headline: 'Heute',
      subtitle: 'Heute nichts geplant',
      secondarySubtitle: '',
      items: [],
      upcomingItem: toBlockItem(next),
      upcomingHint: `Nächster Einsatz ${next.dateLabel}`,
      ctaLabel: 'Planung öffnen →',
      ctaRoute: '/craftsman/operations',
    }
  }

  // ── MODE 3: only_pending_exists — work exists but none is truly scheduled ──
  if (hasPending) {
    return {
      visible: true,
      mode: 'only_pending_exists',
      todayCount: 0,
      headline: 'Heute',
      subtitle: 'Heute nichts terminiert',
      secondarySubtitle: 'Plane deinen nächsten Einsatz in der Planung.',
      items: [],
      upcomingItem: null,
      upcomingHint: '',
      ctaLabel: 'Planung öffnen →',
      ctaRoute: '/craftsman/operations',
    }
  }

  // ── MODE 4: no_relevant_work — no relevant work at all ────────────────
  return {
    visible: true,
    mode: 'no_relevant_work',
    todayCount: 0,
    headline: 'Heute',
    subtitle: 'Keine Einsätze geplant',
    secondarySubtitle: 'Neue Termine erscheinen hier.',
    items: [],
    upcomingItem: null,
    upcomingHint: '',
    ctaLabel: 'Planung öffnen →',
    ctaRoute: '/craftsman/operations',
  }
}
