/**
 * Compact integer formatter for engagement counters (likes, saves, comments).
 *
 * Mirrors the Insta/TikTok convention: counts under 1000 render verbatim,
 * thousands compress to a 1-decimal "1.2K" form, millions to "1.2M". The
 * decimal is dropped when it would be ".0" so we get "1K" not "1.0K" and
 * "12K" not "12.0K". Negative inputs (which should never happen for an
 * engagement counter) and non-finite values fall back to '0' rather than
 * leaking a NaN into the UI.
 *
 * Locale-aware decimal separator
 *   The German UI uses "1,2K" — we honor `navigator.language` when present
 *   so the surface stays consistent with currency / date formatting.
 *   In SSR / test environments we default to 'en' and the dot variant.
 *
 * Why a tiny custom helper instead of `Intl.NumberFormat`
 *   `Intl.NumberFormat` with `notation: 'compact'` would do the rounding
 *   for us, but it returns "1.2K" / "1.2M" / "1.2B" with no easy way to
 *   strip the trailing ".0" or pin the K threshold to 1000 (it produces
 *   "999" for 999, "1K" for 1000, but pluralizes inconsistently across
 *   locales). The behavior we want is simple and stable; a 20-line helper
 *   is easier to test than a locale-coupled built-in.
 *
 * Examples (German locale):
 *   formatCount(0)       -> '0'
 *   formatCount(7)       -> '7'
 *   formatCount(999)     -> '999'
 *   formatCount(1000)    -> '1K'
 *   formatCount(1234)    -> '1,2K'
 *   formatCount(12345)   -> '12,3K'
 *   formatCount(123456)  -> '123K'
 *   formatCount(1234567) -> '1,2M'
 */
export function formatCount(value: number | null | undefined): string {
  if (value == null) return '0'
  if (!Number.isFinite(value)) return '0'
  // Engagement counters can't legitimately be negative; clamp defensively.
  const n = Math.max(0, Math.floor(value))

  if (n < 1000) return String(n)

  const decimalSep = pickDecimalSeparator()

  if (n < 1_000_000) {
    return formatWithSuffix(n / 1000, 'K', decimalSep)
  }
  if (n < 1_000_000_000) {
    return formatWithSuffix(n / 1_000_000, 'M', decimalSep)
  }
  return formatWithSuffix(n / 1_000_000_000, 'B', decimalSep)
}

function formatWithSuffix(value: number, suffix: 'K' | 'M' | 'B', sep: string): string {
  // 1 decimal of precision when below 100, none above (so "12,3K" but "123K").
  const fixed = value < 100 ? value.toFixed(1) : Math.round(value).toString()
  // Drop ".0" → "1K" (consistent with Insta).
  const clean = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
  // Swap '.' for the locale separator after the decimal step.
  return clean.replace('.', sep) + suffix
}

function pickDecimalSeparator(): string {
  if (typeof navigator === 'undefined' || !navigator.language) return '.'
  // Cheap heuristic: any de-* / fr-* / nl-* / es-* / it-* etc. → comma.
  // The Intl approach (formatToParts) would be more robust but balloons
  // the bundle for a single character. Refine if more locales are added.
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('de') || lang.startsWith('fr') || lang.startsWith('it') ||
      lang.startsWith('es') || lang.startsWith('nl') || lang.startsWith('pt')) {
    return ','
  }
  return '.'
}
