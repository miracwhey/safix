// =============================================================================
// ToS / AGB re-acceptance (Block P · #1) — migration-free re-consent gate
// =============================================================================
// The app stores ToS acceptance as a single timestamp (profiles.tos_accepted_at)
// with NO version column. A material AGB change (e.g. the Batch 6 75/25 / §632a
// dispute-default rewrite) legally requires existing users to RE-CONSENT. Rather
// than a one-shot mass-null migration, this date constant drives it: an acceptance
// stamped BEFORE TOS_REACCEPT_AFTER is treated as stale, so the existing ToS gate
// (App.tsx / AuthGate.tsx, which already react to a null tosAcceptedAt) forces a
// fresh acceptance. The check is applied at the SINGLE derivation chokepoint in
// session.ts — no gate component changes.
//
// DORMANT: TOS_REACCEPT_AFTER = null ⇒ isTosAcceptanceStale short-circuits to
// false for every input ⇒ tosAcceptedAt is returned UNCHANGED ⇒ behaviour is
// byte-identical to before. There is no env-flag insulating this path (it runs on
// every authenticated render), so dormancy MUST be the null form, never live date
// math. To activate the re-consent (at the corridor flip, with the required
// Textform notice period), set this to the flip date.
//
// FAIL-OPEN: a malformed / unparseable stored timestamp yields NaN → treated as
// NOT stale → the user keeps access. Staleness can only ever ADD a re-accept
// prompt for a cleanly-parseable old date; it can never lock anyone out on bad data.
export const TOS_REACCEPT_AFTER: Date | null = null

/**
 * True when a stored ToS-acceptance timestamp predates the active re-acceptance
 * cutoff and the user must re-consent. Returns false (not stale) when:
 *   - no cutoff is set (dormant) — the common/default case,
 *   - no acceptance is stored (the gate already handles "never accepted"),
 *   - the stored timestamp is unparseable (fail-open — never lock out on bad data).
 *
 * @param tosAcceptedAt stored ISO timestamp (profiles.tos_accepted_at)
 * @param cutoff        defaults to TOS_REACCEPT_AFTER; injectable for tests
 */
export function isTosAcceptanceStale(
  tosAcceptedAt: string | null | undefined,
  cutoff: Date | null = TOS_REACCEPT_AFTER,
): boolean {
  if (!tosAcceptedAt || !cutoff) return false
  const acceptedMs = Date.parse(tosAcceptedAt)
  if (Number.isNaN(acceptedMs)) return false
  return acceptedMs < cutoff.getTime()
}
