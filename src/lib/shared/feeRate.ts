/**
 * Client-side Fee Rate Resolver
 *
 * Mirrors the canonical server-side fee logic in api/_feeRate.ts.
 * Resolves the platform fee rate for a given job based on its commercial origin.
 *
 * RATE TABLE:
 *   merchant_brought            → 5 % (0.05)
 *   platform_acquired           → 9 % (0.09)
 *   unknown / null / undefined  → 9 % (safe default)
 *
 * The safe default is platform_acquired (9 %). A missing origin must never
 * silently grant a merchant discount.
 *
 * INVARIANT: These rates MUST stay in sync with api/_feeRate.ts.
 * Any change to fee rates must update both files.
 */

import type { JobCommercialOrigin } from '../commercialAttribution/types.js'
import { getJobById } from '../jobs/service.js'

export const FEE_RATES = {
  merchant_brought: 0.05,
  platform_acquired: 0.09,
  /** Applied when commercial_origin is absent — conservative safe default. */
  unknown: 0.09,
} as const

/**
 * Resolves the platform fee rate from a commercial origin value.
 *
 * @param origin - The commercial origin (from job.commercialOrigin or DB).
 *                 May be null/undefined for legacy jobs.
 * @returns Fee rate as a decimal multiplier (0.05 or 0.09).
 */
export function resolveFeeRateFromOrigin(
  origin: JobCommercialOrigin | string | null | undefined,
): number {
  if (origin === 'merchant_brought') return FEE_RATES.merchant_brought
  if (origin === 'platform_acquired') return FEE_RATES.platform_acquired
  return FEE_RATES.unknown
}

/**
 * Resolves the platform fee rate for a specific job by looking up its
 * commercial origin from the job store.
 *
 * Returns the safe default (9 %) when:
 *   - the job is not found (not hydrated yet)
 *   - the job has no commercial origin (legacy job)
 *   - the origin is unknown_pending_resolution
 *
 * @param jobId - The job's ID.
 * @returns Fee rate as a decimal multiplier (0.05 or 0.09).
 */
export function resolveJobFeeRate(jobId: string): number {
  const job = getJobById(jobId)
  return resolveFeeRateFromOrigin(job?.commercialOrigin)
}

/**
 * Strict fee-rate resolver for money-LOCKING paths (escrow plan creation).
 *
 * Unlike {@link resolveJobFeeRate} — which is display-safe and returns the 9 %
 * default for any unresolved state — this variant FAILS CLOSED while a job's
 * commercial attribution is still unresolved. It mirrors the server contract:
 * api/_feeRate.ts throws on 'unknown_pending_resolution', and
 * api/_attributionGuard.ts blocks all money movement until attribution_status
 * is 'finalized'. Locking a rate before attribution finalizes would freeze 9 %
 * onto a merchant_brought (5 %) job permanently — the fee is immutable once
 * written into the escrow plan.
 *
 * Throws PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED when the job's attribution is
 * pending/retrying or its origin is the transient 'unknown_pending_resolution'.
 * Legacy jobs (no commercialOrigin / no attributionStatus) are treated as
 * finalized — consistent with the migration 20260410000002 backfill.
 *
 * @param jobId - The job's ID.
 * @returns Fee rate as a decimal multiplier (0.05 or 0.09).
 */
export function resolveJobFeeRateStrict(jobId: string): number {
  const job = getJobById(jobId)
  const origin = job?.commercialOrigin
  const status = job?.attributionStatus
  if (
    origin === 'unknown_pending_resolution' ||
    status === 'pending' ||
    status === 'retrying'
  ) {
    throw new Error('PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED')
  }
  return resolveFeeRateFromOrigin(origin)
}
