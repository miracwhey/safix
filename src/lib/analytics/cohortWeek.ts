/**
 * Session-free cohort helper. Kept separate from track.ts (which imports
 * ../session) so consumers that only need isoWeek — e.g. auth.ts recording the
 * pre-session `signup` event — don't transitively pull session.ts's
 * onAuthStateChange module-load side-effect into offline tests.
 * See [[feedback_spatial_barrel_no_session_imports]].
 */

/**
 * ISO-8601 week key (e.g. "2026-W27") used as a signup/retention cohort.
 * Derived from a user's auth `created_at`. Returns undefined for a missing or
 * unparseable timestamp so callers can omit the field rather than emit garbage.
 */
export function isoWeek(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return undefined
  // Thursday-anchored ISO week.
  const d = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()))
  const dayNum = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
