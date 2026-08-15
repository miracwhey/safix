/**
 * PII redaction for cross-party reconciliation surfaces.
 *
 * INTENT
 * ------
 * The reconciliation center exposes operator-authored notes, history events,
 * and counterparty statements to the opposite party. RLS protects the
 * underlying rows but cannot scrub free-text fields written by humans. This
 * module performs a defensive client-side scrub of common PII patterns
 * (email, phone, postal address, IBAN-like strings) before the text is
 * rendered in the OTHER party's view.
 *
 * BOUNDARIES
 * ----------
 * - This is a defense-in-depth layer, NOT the primary protection. RLS,
 *   role-aware repositories, and the operator UX guidelines remain the
 *   authoritative gatekeepers.
 * - The scrub is permissive: it errs toward redacting borderline matches
 *   rather than leaking data. False positives are acceptable; false negatives
 *   are not.
 * - The scrub only runs on text shown to the OPPOSITE party. Own writes are
 *   never redacted in the author's own view.
 *
 * NOT IN SCOPE
 * ------------
 * - Image EXIF stripping — handled by the media upload pipeline.
 * - PDF metadata redaction — handled by the export edge function.
 * - Audio transcription scrub — out of scope until N13.AUDIO ships.
 */

const REPLACEMENT = '[geschwärzt]'

// Email — RFC 5322 simplified, intentionally permissive
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// International phone — covers +49 30 1234567, +49-30-1234567, 0049 30 1234567,
// 030 / 1234567, 0151-1234567, etc. Requires at least 7 digits to avoid
// matching ordinary numbers (amounts, ratios, dates).
const PHONE_RE = /(?:\+|00)\d{1,3}[\s/.-]?\d{1,5}[\s/.-]?\d{3,}\d{3,}|0\d{2,5}[\s/.-]?\d{6,}/g

// IBAN — DE99 1234 5678 9012 3456 78 (also without spaces). Conservative
// enough to avoid false positives on plain numbers.
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[\s-]?\d{4}){3,7}\b/g

// German postal code + city heuristic — `12345 Berlin`, `D-12345 München`,
// `10115, Berlin`. Five-digit postcode followed by a capitalised place name.
const POSTAL_RE = /\b(?:D-)?\d{5}[\s,]+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,}(?:[\s-]+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]+)*\b/g

// German street + number — two patterns combined:
//   A) single capitalised word ending on a known street suffix +
//      house number (e.g. `Musterstraße 12`, `Bahnhofweg 5a`)
//   B) two consecutive capitalised words + house number
//      (e.g. `Am Markt 3`, `Berliner Allee 45/4`)
// Avoids false positives on `Betrag 2140` (single Cap word, no suffix,
// no second Cap word).
const STREET_SUFFIX = '(?:straße|strasse|str\\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee|hof|markt|stieg)'
const STREET_A_RE = new RegExp(
  `\\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*${STREET_SUFFIX}\\s+\\d+(?:\\s?[a-z](?![a-z]))?(?:\\s?\\/\\s?\\d+)?\\b`,
  'gi',
)
const STREET_B_RE = /\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,}\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]+\s+\d+(?:\s?[a-z](?![a-z]))?(?:\s?\/\s?\d+)?\b/g

// Last resort: any literal occurrence of a known counterparty display name
// (e.g. "Mustermann GmbH", "Lena Bergmann"). Caller passes these in.
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type RedactionContext = {
  /** Opposite-party display name(s) that must never appear verbatim. */
  counterpartyNames?: ReadonlyArray<string>
  /** Opposite-party email(s) that must never appear verbatim. */
  counterpartyEmails?: ReadonlyArray<string>
}

/**
 * Redacts PII from a free-text string. Returns the input unchanged if empty.
 *
 * This is the single entry point — selectors and components must call it on
 * any operator note, counterparty statement, or history `note` field that is
 * shown to the opposite party. Own-text rendering must NOT call this.
 */
export function redactPII(input: string | null | undefined, ctx: RedactionContext = {}): string {
  if (!input) return ''
  let result = input

  // Counterparty literals first — most specific, least false positives.
  if (ctx.counterpartyNames) {
    for (const name of ctx.counterpartyNames) {
      const trimmed = name.trim()
      if (trimmed.length < 3) continue
      const re = new RegExp(escapeRegex(trimmed), 'gi')
      result = result.replace(re, REPLACEMENT)
    }
  }
  if (ctx.counterpartyEmails) {
    for (const email of ctx.counterpartyEmails) {
      const trimmed = email.trim()
      if (trimmed.length < 5) continue
      const re = new RegExp(escapeRegex(trimmed), 'gi')
      result = result.replace(re, REPLACEMENT)
    }
  }

  // Generic patterns
  result = result.replace(EMAIL_RE, REPLACEMENT)
  result = result.replace(IBAN_RE, REPLACEMENT)
  result = result.replace(PHONE_RE, REPLACEMENT)
  result = result.replace(POSTAL_RE, REPLACEMENT)
  result = result.replace(STREET_A_RE, REPLACEMENT)
  result = result.replace(STREET_B_RE, REPLACEMENT)

  return result
}

/**
 * Convenience: redact a list of strings in one pass. Used by selectors that
 * map history items to display rows.
 */
export function redactPIIList(
  inputs: ReadonlyArray<string | null | undefined>,
  ctx: RedactionContext = {},
): string[] {
  return inputs.map((input) => redactPII(input, ctx))
}
