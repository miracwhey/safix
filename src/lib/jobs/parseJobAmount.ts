/**
 * Attempts to parse a raw job amount into a plain numeric value.
 *
 * Accepts:
 *  - number  → returned directly (if positive and finite)
 *  - string  → parsed from German-formatted text such as '2.300 €', '640 €',
 *              or '500 – 800 €' (budget range, takes first value).
 *              German number formatting: '.' is thousands separator,
 *              ',' is decimal separator.
 *  - null / undefined → returns null
 *
 * Returns null when the input cannot be parsed to a meaningful positive number.
 */
export function parseJobAmount(raw: string | number | undefined | null): number | null {
  if (raw == null) return null

  // Numeric input: return directly if it's a valid positive finite number
  if (typeof raw === 'number') {
    return isFinite(raw) && raw > 0 ? raw : null
  }

  if (!raw.trim()) return null

  // If a range like '500 – 800 €', take the first value
  const firstPart = raw.split(/[–-]/)[0]

  const cleaned = firstPart
    .replace(/€/g, '')
    .replace(/\./g, '')   // remove German thousands separator
    .replace(',', '.')    // convert German decimal separator to JS dot
    .replace(/\s/g, '')
    .trim()

  const n = parseFloat(cleaned)
  return isNaN(n) || n <= 0 ? null : n
}
