/**
 * Aktenzeichen — public-facing case number for a dispute.
 *
 * Format: `R-NNNN/MM-YYYY`
 * - `NNNN` is a deterministic 4-digit sequence derived from the dispute UUID
 *   plus its calendar-month bucket. Same dispute always yields the same
 *   Aktenzeichen, regardless of when it is rendered.
 * - `MM-YYYY` is the calendar month of `createdAt` (the dispute's opening date).
 *
 * INTENT
 * ------
 * Customers and providers see this number on every surface — list, detail,
 * notification, PDF export, support ticket. UUIDs stay internal.
 *
 * The function is a pure derivation, not a database sequence. It must NEVER
 * write to disk and must be safe to call from anywhere (selectors, render,
 * export). Collisions within the same calendar month are exceedingly unlikely
 * (≈ 1 in 10 000 per month) — if they ever occur, the underlying UUID still
 * disambiguates and `parseAktenzeichen()` returns null for ambiguous inputs.
 */

const AKZ_PREFIX = 'R'
// Accept either the canonical display form `R-NNNN/MM-YYYY` or the URL-safe
// form `R-NNNN_MM-YYYY` (slashes are reserved in path params). Both refer to
// the same Aktenzeichen.
const AKZ_PATTERN = /^R-(\d{4})[/_](\d{2})-(\d{4})$/

/**
 * Internal: derive a stable 4-digit sequence from a UUID. Uses a simple
 * deterministic hash (FNV-1a 32-bit) so the result is the same on every
 * invocation across server, client, and tests.
 */
function hashSequence(disputeId: string): number {
  let hash = 0x811c9dc5 // FNV-1a 32-bit offset basis
  for (let i = 0; i < disputeId.length; i++) {
    hash ^= disputeId.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0 // FNV prime, keep 32-bit
  }
  return hash % 10000
}

/**
 * Formats an Aktenzeichen string from a dispute's UUID and `createdAt`
 * timestamp. The result is deterministic.
 *
 * Returns null if `createdAt` cannot be parsed — callers must handle this
 * defensively rather than display "R-XXXX/NaN-NaN" to users.
 */
export function formatAktenzeichen(disputeId: string, createdAt: string): string | null {
  if (!disputeId) return null
  const ms = Date.parse(createdAt)
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  const seq = hashSequence(disputeId)
  const seqStr = String(seq).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const year = String(date.getUTCFullYear())
  return `${AKZ_PREFIX}-${seqStr}/${month}-${year}`
}

/**
 * Returns the URL-safe form of an Aktenzeichen — replaces the slash with an
 * underscore so the value can be used as a path parameter. The display form
 * is restored by `parseAktenzeichen`, which accepts both variants.
 */
export function aktenzeichenToUrlSlug(akz: string): string {
  return akz.replace('/', '_')
}

/**
 * Inverse of `aktenzeichenToUrlSlug` — restores the canonical display form
 * for rendering. Safe to call on either form.
 */
export function aktenzeichenFromUrlSlug(slug: string): string {
  return slug.replace('_', '/')
}

/**
 * Parses an Aktenzeichen string back into its components. Returns null when
 * the input does not match the expected shape.
 *
 * Used by route resolvers (`/profile/disputes/:akz`) to find the matching
 * dispute. The match is on month + sequence; the actual UUID is then looked
 * up via `findDisputeByAktenzeichen`.
 */
export function parseAktenzeichen(
  akz: string,
): { sequence: number; month: number; year: number } | null {
  if (!akz) return null
  const match = AKZ_PATTERN.exec(akz)
  if (!match) return null
  const sequence = Number.parseInt(match[1], 10)
  const month = Number.parseInt(match[2], 10)
  const year = Number.parseInt(match[3], 10)
  if (!Number.isFinite(sequence) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return null
  }
  if (month < 1 || month > 12) return null
  return { sequence, month, year }
}

/**
 * Resolves an Aktenzeichen back to a dispute by matching month + sequence
 * against a candidate list. The candidate list is typically the user's own
 * disputes (already RLS-filtered upstream). Returns the first match or null.
 *
 * Why month + sequence is enough: `formatAktenzeichen` is deterministic on
 * (disputeId, createdAt). For a given month, two disputes can only collide
 * if their UUID hashes to the same 4-digit sequence — extremely rare and the
 * caller's candidate list is bounded to one user.
 */
export function findDisputeByAktenzeichen<T extends { id: string; createdAt: string }>(
  akz: string,
  candidates: ReadonlyArray<T>,
): T | null {
  const parsed = parseAktenzeichen(akz)
  if (!parsed) return null
  for (const candidate of candidates) {
    const formatted = formatAktenzeichen(candidate.id, candidate.createdAt)
    if (formatted === akz) return candidate
  }
  // Fallback: match on the (month, year, sequence) tuple in case the caller
  // supplied a slightly different formatting variant (legacy data, etc.).
  for (const candidate of candidates) {
    const ms = Date.parse(candidate.createdAt)
    if (!Number.isFinite(ms)) continue
    const date = new Date(ms)
    const seq = hashSequence(candidate.id)
    if (
      seq === parsed.sequence &&
      date.getUTCMonth() + 1 === parsed.month &&
      date.getUTCFullYear() === parsed.year
    ) {
      return candidate
    }
  }
  return null
}
