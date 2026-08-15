/**
 * Jobs Screen Selectors — Pure adapters for the consolidated owner work surface.
 *
 * Reads the existing canonical action-queue selector + the raw job list and
 * exposes a small, testable shape the unified `/craftsman/jobs` screen can
 * render. Does NOT introduce a second source of truth: every classification
 * comes from `deriveActionQueue` (urgency-grouped queue items) or from the
 * existing job-status filters (`isCompletedJob`, planned/active families).
 *
 * The screen distinguishes four sections:
 *   - handlungsbedarf — items the craftsman must act on now (queue.needsAction)
 *   - aktiv          — work in progress + waiting (queue.inProgress + queue.waiting)
 *   - geplant        — upcoming scheduled/booked work (queue.comingUp)
 *   - alle           — full list incl. completed/cancelled, status-grouped
 *
 * `resolveJobsScreenSection` parses the `?focus=...` query param against a
 * whitelist; unknown values fall back to a smart default based on the queue
 * state. This mirrors the JobDetail focus-anchor whitelist pattern.
 */

import type { Job } from '../jobs/types'
import { isCompletedJob } from '../jobs'
import type { ActionQueueItem, ActionQueueResult } from './actionQueueSelectors'

// ── Types ────────────────────────────────────────────────────────────────────

export type JobsScreenSection = 'handlungsbedarf' | 'aktiv' | 'geplant' | 'alle'

export const JOBS_SCREEN_SECTION_IDS: readonly JobsScreenSection[] = [
  'handlungsbedarf',
  'aktiv',
  'geplant',
  'alle',
] as const

export type JobsScreenSectionStats = {
  handlungsbedarf: number
  aktiv: number
  geplant: number
  alle: number
}

/**
 * Discriminated render shape per section.
 *  - `queue` flat list of ActionQueueItem (handlungsbedarf, geplant)
 *  - `queue-grouped` ActionQueueItems split by sub-label (aktiv → In Arbeit + Wartet)
 *  - `jobs-grouped` raw Jobs split by status family (alle → Geplant/Aktiv/Erledigt)
 */
export type JobsScreenSectionContent =
  | { kind: 'queue'; items: ActionQueueItem[] }
  | { kind: 'queue-grouped'; groups: { label: string; items: ActionQueueItem[] }[] }
  | { kind: 'jobs-grouped'; groups: { label: string; jobs: Job[] }[] }

// ── Section resolution ───────────────────────────────────────────────────────

/**
 * Resolves the active section from the URL `?focus=...` param.
 *
 * Whitelist: handlungsbedarf, aktiv, geplant, alle.
 * Unknown / missing values fall back to a smart default:
 *   - if any urgent item exists → handlungsbedarf
 *   - else                       → aktiv
 *
 * Pure — no side effects. Always returns a defined section.
 */
export function resolveJobsScreenSection(
  focusParam: string | null | undefined,
  queue: ActionQueueResult,
): JobsScreenSection {
  if (focusParam === 'handlungsbedarf') return 'handlungsbedarf'
  if (focusParam === 'aktiv') return 'aktiv'
  if (focusParam === 'geplant') return 'geplant'
  if (focusParam === 'alle') return 'alle'
  return queue.needsAction.length > 0 ? 'handlungsbedarf' : 'aktiv'
}

// ── Section stats ────────────────────────────────────────────────────────────

/**
 * Per-section counts for the segmented chip strip.
 *
 * `alle` excludes cancelled jobs (they are not part of the operational view).
 */
export function deriveJobsScreenSectionStats(
  queue: ActionQueueResult,
  jobs: Job[],
): JobsScreenSectionStats {
  return {
    handlungsbedarf: queue.needsAction.length,
    aktiv: queue.inProgress.length + queue.waiting.length,
    geplant: queue.comingUp.length,
    alle: jobs.filter((j) => j.status !== 'cancelled').length,
  }
}

// ── Job grouping (Alle section) ──────────────────────────────────────────────

const PLANNED_ORDER: Record<string, number> = { scheduled: 0, booked: 1, new: 2 }

function isPlanned(j: Job): boolean {
  return j.status === 'new' || j.status === 'booked' || j.status === 'scheduled'
}

function isActive(j: Job): boolean {
  return j.status === 'in_progress' || j.status === 'waiting_payment'
}

function sortPlanned(a: Job, b: Job): number {
  return (PLANNED_ORDER[a.status] ?? 3) - (PLANNED_ORDER[b.status] ?? 3)
}

function sortActive(a: Job, b: Job): number {
  if (a.status === 'in_progress' && b.status !== 'in_progress') return -1
  if (b.status === 'in_progress' && a.status !== 'in_progress') return 1
  return 0
}

// ── Section content ──────────────────────────────────────────────────────────

/**
 * Returns the render shape for the given section.
 *
 * No re-derivation of urgency: queue groups are surfaced verbatim. The `alle`
 * section uses raw status filters that match the prior `CraftsmanJobsScreen`
 * grouping (Geplant/Aktiv/Erledigt) so behaviour is preserved when the user
 * wants the broad list.
 */
export function deriveJobsScreenSectionContent(
  section: JobsScreenSection,
  queue: ActionQueueResult,
  jobs: Job[],
): JobsScreenSectionContent {
  switch (section) {
    case 'handlungsbedarf':
      return { kind: 'queue', items: queue.needsAction }

    case 'aktiv': {
      const groups: { label: string; items: ActionQueueItem[] }[] = []
      if (queue.inProgress.length > 0) groups.push({ label: 'In Arbeit', items: queue.inProgress })
      if (queue.waiting.length > 0) groups.push({ label: 'Wartet', items: queue.waiting })
      return { kind: 'queue-grouped', groups }
    }

    case 'geplant':
      return { kind: 'queue', items: queue.comingUp }

    case 'alle': {
      // Exclude cancelled jobs from the broad list (matches the section count
      // contract in `deriveJobsScreenSectionStats`). Cancelled work is not
      // part of the operational view.
      const visible = jobs.filter((j) => j.status !== 'cancelled')
      const planned = visible.filter(isPlanned).slice().sort(sortPlanned)
      const active = visible.filter(isActive).slice().sort(sortActive)
      const completed = visible.filter(isCompletedJob)
      const groups: { label: string; jobs: Job[] }[] = []
      if (planned.length > 0) groups.push({ label: 'Geplant', jobs: planned })
      if (active.length > 0) groups.push({ label: 'Aktiv', jobs: active })
      if (completed.length > 0) groups.push({ label: 'Erledigt', jobs: completed })
      return { kind: 'jobs-grouped', groups }
    }
  }
}

// ── Active bottom-nav tab resolution ─────────────────────────────────────────

/**
 * Returns the bottom-nav tab the unified screen should highlight.
 *
 *   `home`        when entered with `?focus=handlungsbedarf` — the Dashboard
 *                 work-entry card lands the user here, so the Home tab stays
 *                 highlighted.
 *   `verwaltung`  for any other entry — the Backoffice "Aufträge" navigation
 *                 card is the canonical owner of this surface.
 *
 * Stable bottom nav rule: do not flip the highlighted tab as the user changes
 * sections inside the screen (only the *initial* focus param drives this).
 */
export function resolveJobsScreenActiveTab(
  focusParam: string | null | undefined,
): 'home' | 'verwaltung' {
  return focusParam === 'handlungsbedarf' ? 'home' : 'verwaltung'
}
