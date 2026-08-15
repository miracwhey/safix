/**
 * Shared Stripe utilities used across serverless API functions.
 *
 * Extracted here to avoid duplication between create-escrow and refund-escrow,
 * both of which need to convert amounts to Stripe's smallest currency unit.
 */

// Stripe zero-decimal currencies — amounts are passed as-is (no × 100).
// Full list: https://stripe.com/docs/currencies#zero-decimal
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx',
  'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

// Stripe three-decimal currencies — amounts are passed in the smallest unit
// (× 1000) and Stripe rounds to the nearest ten.
// See: https://stripe.com/docs/currencies#three-decimal
export const THREE_DECIMAL_CURRENCIES = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd'])

/**
 * Converts a human-readable currency amount to Stripe's smallest unit.
 *
 * Standard currencies:       EUR 10.50  → 1050 cents
 * Zero-decimal currencies:   JPY 1000   → 1000 yen  (no multiplication)
 * Three-decimal currencies:  KWD 1.234  → 1234 fils (Stripe rounds to nearest 10)
 */
export function toSmallestUnit(amount: number, currency: string): number {
  const curr = currency.toLowerCase()
  if (ZERO_DECIMAL_CURRENCIES.has(curr)) return Math.round(amount)
  if (THREE_DECIMAL_CURRENCIES.has(curr)) return Math.round(amount * 1000)
  return Math.round(amount * 100)
}
