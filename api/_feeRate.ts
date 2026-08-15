/**
 * Commercial origin → platform fee rate mapping.
 *
 * This is the single source of truth for SaFix commission logic.
 * All payment endpoints must derive the fee rate from here — never hardcode it.
 *
 * merchant_brought  — craftsman brought this customer into SaFix → 5%
 * platform_acquired — SaFix acquired this customer organically   → 9%
 * unknown / null    — attribution missing (legacy job or gap)    → 9% (safe default)
 *
 * The safe default for missing attribution is platform_acquired (9%), not the
 * lower rate. A missing origin must never silently grant a merchant discount.
 * The caller must log a warning when the default is applied.
 */

export type CommercialOrigin = 'merchant_brought' | 'platform_acquired'

export const FEE_RATES = {
  merchant_brought: 0.05,
  platform_acquired: 0.09,
  /** Applied when commercial_origin is NULL — the conservative safe default. */
  unknown: 0.09,
} as const

/**
 * Returns the platform fee rate for a given commercial origin.
 *
 * @param origin - The commercial origin from jobs.commercial_origin.
 *                 May be null for legacy jobs created before attribution model.
 * @returns { rate, wasDefaulted } — rate is the fee multiplier (0.05 or 0.09),
 *   wasDefaulted is true when the origin was absent and the safe default was used.
 *
 * Throws unconditionally if origin is 'unknown_pending_resolution'. The payment
 * endpoint MUST block and attempt reconciliation before calling this function.
 * This throw is a secondary safety net — the primary gate is the explicit check
 * in the payment endpoint handler.
 */
export function resolveCommercialFeeRate(origin: string | null | undefined): {
  rate: number
  wasDefaulted: boolean
} {
  // Hard invariant: this state must never reach fee calculation.
  // The payment endpoint is responsible for blocking before calling here.
  if (origin === 'unknown_pending_resolution') {
    throw new Error('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
  }
  if (origin === 'merchant_brought') {
    return { rate: FEE_RATES.merchant_brought, wasDefaulted: false }
  }
  if (origin === 'platform_acquired') {
    return { rate: FEE_RATES.platform_acquired, wasDefaulted: false }
  }
  // Null, undefined, or unrecognised value → safe default = platform_acquired rate.
  return { rate: FEE_RATES.unknown, wasDefaulted: true }
}
