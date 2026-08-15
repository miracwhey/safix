/**
 * Canonical Money Formatters — Single Source of Truth
 *
 * ALL money formatting in the application MUST go through these functions.
 * No screen, selector, or component should implement its own ad-hoc
 * currency formatting.
 *
 * Rules:
 *   - German locale (de-DE) with EUR currency
 *   - Always 2 decimal places for monetary amounts
 *   - Intl.NumberFormat for correct grouping / decimal separators
 *   - € symbol always present via Intl currency style
 *
 * Unit conventions:
 *   - formatEuro()  — input is in euros (e.g. 2300 means 2 300 €)
 *   - formatCents() — input is in cents (e.g. 230000 means 2 300 €)
 */

const euroFormatter = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * Formats a euro amount for display.
 *
 * @param amount — value in euros (e.g. 2300 → "2.300,00 €")
 */
export function formatEuro(amount: number): string {
  return euroFormatter.format(amount)
}

/**
 * Formats a cent amount for display by converting to euros first.
 *
 * @param cents — value in minor units / cents (e.g. 230000 → "2.300,00 €")
 */
export function formatCents(cents: number): string {
  return euroFormatter.format(cents / 100)
}

/**
 * Formats a raw offer/quote price string through the canonical formatter.
 *
 * Attempts to parse the raw string (which may be a bare number like "1000",
 * a German-formatted amount like "1.500 €", or another human-entered value)
 * and returns a canonically formatted euro string.
 *
 * Falls back to the raw string when parsing fails (e.g. "auf Anfrage").
 *
 * @param rawPrice — the raw price from the offer: number (e.g. 1000) or string (e.g. "1000", "1.500 €")
 * @returns canonically formatted string (e.g. "1.000,00 €") or the raw input
 */
/**
 * Formats a timestamp as a human-friendly relative time string in German.
 *
 * @param timestampMs — Unix timestamp in milliseconds
 * @returns German relative string (e.g. "gerade eben", "vor 3 Std.", "vor 2 Tagen")
 */
export function formatRelativeTime(timestampMs: number): string {
  const now = Date.now()
  const diffMs = now - timestampMs
  if (diffMs < 0) return 'gerade eben'

  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min.`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `vor ${hours} Std.`

  const days = Math.floor(hours / 24)
  if (days === 1) return 'gestern'
  if (days < 7) return `vor ${days} Tagen`

  const weeks = Math.floor(days / 7)
  if (weeks === 1) return 'vor 1 Woche'
  if (weeks < 5) return `vor ${weeks} Wochen`

  const months = Math.floor(days / 30)
  if (months === 1) return 'vor 1 Monat'
  return `vor ${months} Monaten`
}

/**
 * Normalizes a date input to ISO-8601 date string (YYYY-MM-DD).
 *
 * Handles:
 *   - ISO format input: "2026-04-25" → "2026-04-25" (passthrough)
 *   - German format input: "25.04.2026" → "2026-04-25"
 *   - Empty/null/undefined → undefined
 *
 * Returns undefined if the input cannot be parsed as a valid date.
 * Used at the workflow boundary to ensure validUntil is always stored in ISO format.
 */
export function normalizeDateToISO(input: string | undefined | null): string | undefined {
  if (!input || !input.trim()) return undefined
  const trimmed = input.trim()

  // Already ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed)
    if (!isNaN(d.getTime())) return trimmed
  }

  // German format (DD.MM.YYYY)
  const deMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (deMatch) {
    const [, day, month, year] = deMatch
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    const d = new Date(iso)
    if (!isNaN(d.getTime())) return iso
  }

  return undefined
}

/**
 * Converts a validUntil ISO date (YYYY-MM-DD) to the HTML date input format.
 * Passthrough for ISO strings. Returns '' for empty/invalid input.
 */
export function toDateInputValue(input: string | undefined | null): string {
  if (!input) return ''
  const iso = normalizeDateToISO(input)
  return iso ?? ''
}

export function formatOfferPrice(rawPrice: string | number): string {
  if (typeof rawPrice === 'number') return euroFormatter.format(rawPrice)
  if (!rawPrice || !rawPrice.trim()) return rawPrice

  // Parse German-formatted euro amounts: "2.300 €" → 2300, "1.200,50 €" → 1200.50
  // Also handles bare numbers: "1000" → 1000
  const firstPart = rawPrice.split(/[–-]/)[0]
  const cleaned = firstPart
    .replace(/€/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/\s/g, '')
    .trim()

  const n = parseFloat(cleaned)
  if (isNaN(n) || n <= 0) return rawPrice

  return euroFormatter.format(n)
}
