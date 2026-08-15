/**
 * Maps an unknown inquiry-start error to a SAFE German user-facing message.
 *
 * Why: the reel- and profile-inquiry surfaces (ExploreReelCard,
 * ExploreProfileHeaderCard) used to surface `err.message` verbatim. That leaks
 * technical text to the user — `RbacError` ("Caller is not a customer"), raw
 * Supabase/Postgrest errors, or any generic JS error — none of which is
 * actionable or appropriate.
 *
 * Approach: allowlist, not denylist. We pass through ONLY messages we know to
 * be user-friendly and intentional; everything else collapses to a clean
 * fallback. Today the single allowlisted message is the daily request cap,
 * thrown as a plain `Error` whose message is prefixed `"Tageslimit erreicht:"`
 * in two places — `requestLimitService.recordRequestSend` and the
 * `enforceRequestLimit` guard in `exploreInquiryWorkflow`. Matching the stable
 * prefix (rather than an interpolated full string) keeps this robust to the
 * MAX_DAILY_SENDS count and covers both throw sites, while keeping this helper
 * pure (no imports → trivially testable, no Supabase module pulled in).
 *
 * Add new entries to ALLOWLIST_PREFIXES only for messages that are written for
 * end users in German and safe to display.
 */

const FALLBACK_MESSAGE = 'Anfrage konnte nicht gesendet werden. Bitte versuche es erneut.'

// Known user-facing messages that are safe to surface verbatim. Keyed by a
// stable prefix so an interpolated suffix (e.g. the daily-cap count) still
// matches.
const ALLOWLIST_PREFIXES = ['Tageslimit erreicht:'] as const

/**
 * @param err  The caught error (unknown — could be Error, string, anything).
 * @returns    A German message safe to show the user. Allowlisted messages
 *             pass through unchanged; everything else returns the fallback.
 */
export function inquiryErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.trim()
    if (message && ALLOWLIST_PREFIXES.some((prefix) => message.startsWith(prefix))) {
      return message
    }
  }
  return FALLBACK_MESSAGE
}
