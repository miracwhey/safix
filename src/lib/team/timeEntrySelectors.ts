/**
 * Pure selectors over the time-entry domain — Block 2.
 *
 * No side effects, no store reads. All inputs flow as parameters so the
 * selectors are trivially testable and reusable across owner / worker UIs.
 */

import type { TeamMember } from '../jobs/types'
import type { TimeEntry } from './timeEntryTypes'

// ─────────────────────────────────────────────────────────────────────────────
// Active-timer state for the Worker hero
// ─────────────────────────────────────────────────────────────────────────────

export type ActiveDayState =
  | { state: 'idle' }
  | { state: 'active'; entryId: string; startedAt: string; note: string | null }

export type ActiveJobState =
  | { state: 'idle' }
  | { state: 'active'; entryId: string; jobId: string; startedAt: string; note: string | null }

/**
 * Returns the worker's currently-running 'day' timer (kind === 'day' &&
 * status === 'active' && member matches), or 'idle' if none.
 *
 * The DB unique-partial-index `time_entries_active_day_unique` guarantees at
 * most one match in practice; we still defensively pick the most recent
 * `startedAt` if a stale record slipped through replication.
 */
export function deriveActiveDayState(entries: TimeEntry[], memberId: string): ActiveDayState {
  const matches = entries
    .filter((e) => e.kind === 'day' && e.status === 'active' && e.memberId === memberId)
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))
  const head = matches[0]
  if (!head) return { state: 'idle' }
  return { state: 'active', entryId: head.id, startedAt: head.startedAt, note: head.note }
}

/**
 * Returns the worker's currently-running 'job' timer, or 'idle' if none.
 */
export function deriveActiveJobState(entries: TimeEntry[], memberId: string): ActiveJobState {
  const matches = entries
    .filter((e) => e.kind === 'job' && e.status === 'active' && e.memberId === memberId)
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))
  const head = matches[0]
  if (!head || !head.jobId) return { state: 'idle' }
  return {
    state: 'active',
    entryId: head.id,
    jobId: head.jobId,
    startedAt: head.startedAt,
    note: head.note,
  }
}

/**
 * Live elapsed minutes between `startedAt` and `now`. Returns 0 for invalid
 * dates rather than NaN (UI-friendly).
 */
export function computeElapsedMinutes(startedAtIso: string, now: Date = new Date()): number {
  const startedMs = new Date(startedAtIso).getTime()
  if (Number.isNaN(startedMs)) return 0
  const diffMin = Math.max(0, Math.floor((now.getTime() - startedMs) / 60000))
  return diffMin
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Ist (closed entries summed within Mon-Sun local week)
// ─────────────────────────────────────────────────────────────────────────────

/** Boundary for the week, both ISO timestamps; semi-open: [start, end). */
export type WeekRange = { startIso: string; endIso: string }

/**
 * Sum of `durationMinutes` over closed 'day' entries that started within the
 * given week range, for one member.
 *
 * - Excludes status='active' (no duration yet).
 * - Excludes status='rejected' (owner-disputed time does not count).
 * - Only kind='day' counts toward weekly Ist (job-time is tracked separately
 *   for project audit, not weekly headline).
 */
export function deriveWeeklyHoursIst(
  entries: TimeEntry[],
  memberId: string,
  range: WeekRange,
): number {
  const startMs = new Date(range.startIso).getTime()
  const endMs = new Date(range.endIso).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0
  let total = 0
  for (const e of entries) {
    if (e.memberId !== memberId) continue
    if (e.kind !== 'day') continue
    if (e.status !== 'closed') continue
    if (e.durationMinutes == null) continue
    const startedMs = new Date(e.startedAt).getTime()
    if (Number.isNaN(startedMs)) continue
    if (startedMs < startMs || startedMs >= endMs) continue
    total += e.durationMinutes
  }
  return total
}

// ─────────────────────────────────────────────────────────────────────────────
// Soll/Ist bar visualisation
// ─────────────────────────────────────────────────────────────────────────────

export type HoursColor = 'gray' | 'amber' | 'blue' | 'red'

export type HoursBarData = {
  /** Raw percentage (0..∞). */
  pct: number
  /** Visual width, capped at 150 to avoid runaway bars. */
  capPct: number
  color: HoursColor
}

/**
 * Color semantics (SaFix-Hub convention):
 *   - gray  → no target hours configured
 *   - amber → under-utilised (< 50% Soll)
 *   - blue  → on-target (50–110% Soll, inclusive)
 *   - red   → over-utilised (> 110% Soll)
 *
 * Width capped at 150% so very long bars do not overflow the layout.
 *
 * Boundary comparisons run in integer-minute space to side-step IEEE-754
 * rounding (otherwise e.g. 44h vs 40h gives 110.00000000000001%, which would
 * flip the colour on an exact boundary).
 */
export function deriveHoursBarData(sollMinutes: number | null, istMinutes: number): HoursBarData {
  if (sollMinutes == null || sollMinutes <= 0) {
    return { pct: 0, capPct: 0, color: 'gray' }
  }
  const rawPct = (istMinutes / sollMinutes) * 100
  const pct = Number.isFinite(rawPct) ? rawPct : 0
  const capPct = Math.max(0, Math.min(pct, 150))
  // Integer comparisons: ist * 100 vs soll * threshold
  const ist100 = istMinutes * 100
  let color: HoursColor
  if (ist100 < sollMinutes * 50) color = 'amber'
  else if (ist100 > sollMinutes * 110) color = 'red'
  else color = 'blue'
  return { pct, capPct, color }
}

// ─────────────────────────────────────────────────────────────────────────────
// Action-Item: members who are under their weekly Soll
// ─────────────────────────────────────────────────────────────────────────────

export type UnderTargetMember = {
  memberId: string
  displayName: string
  sollMinutes: number
  istMinutes: number
  pct: number
}

/**
 * Filters members whose Ist is less than 50% of their Soll for the current
 * week. Members without a configured target (weeklyTargetHours == null) are
 * skipped — we cannot tell whether they are "under" anything.
 *
 * Owner-only members and inactive members are excluded.
 *
 * Sorted ascending by `pct` so the most-under member surfaces first.
 */
export function deriveUnderTargetMembers(
  members: TeamMember[],
  istMinutesByMemberId: Map<string, number>,
): UnderTargetMember[] {
  const result: UnderTargetMember[] = []
  for (const m of members) {
    if (m.role === 'owner') continue
    if (m.isActive === false) continue
    if (!m.userId) continue
    const sollHours = m.weeklyTargetHours
    if (sollHours == null || sollHours <= 0) continue
    const sollMinutes = sollHours * 60
    const istMinutes = istMinutesByMemberId.get(m.id) ?? 0
    const pct = (istMinutes / sollMinutes) * 100
    if (pct < 50) {
      result.push({
        memberId: m.id,
        displayName: m.name,
        sollMinutes,
        istMinutes,
        pct,
      })
    }
  }
  result.sort((a, b) => a.pct - b.pct)
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a Map<memberId, istMinutes> from a flat entry list — useful when the
 * UI wants to compute Soll/Ist bars for many members in one pass.
 */
export function buildIstMinutesIndex(entries: TimeEntry[], range: WeekRange): Map<string, number> {
  const map = new Map<string, number>()
  for (const e of entries) {
    if (e.kind !== 'day') continue
    if (e.status !== 'closed') continue
    if (e.durationMinutes == null) continue
    const startedMs = new Date(e.startedAt).getTime()
    const startMs = new Date(range.startIso).getTime()
    const endMs = new Date(range.endIso).getTime()
    if (Number.isNaN(startedMs) || Number.isNaN(startMs) || Number.isNaN(endMs)) continue
    if (startedMs < startMs || startedMs >= endMs) continue
    map.set(e.memberId, (map.get(e.memberId) ?? 0) + e.durationMinutes)
  }
  return map
}
