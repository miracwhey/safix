/**
 * Tranche Trigger Satisfaction — Single Canonical Truth
 *
 * This module defines the ONLY client-side logic for determining whether
 * a tranche's release trigger is satisfied by the current job status.
 *
 * All client-side projections, aggregations, CTA visibility decisions,
 * and blocking-reason derivations MUST use these functions instead of
 * inlining their own trigger checks. This prevents split-brain between
 * screens that derive eligibility differently.
 *
 * The trigger satisfaction sets mirror the server-authoritative gate in
 * api/release-tranche.ts (lines 211–220). Any change to the server sets
 * MUST be mirrored here, and vice versa.
 */

/**
 * Job statuses that satisfy the work_started trigger.
 * Once a job reaches in_progress (or beyond), the deposit tranche's
 * trigger condition is met — even if the tranche DB status is still 'funded'.
 */
export const WORK_STARTED_SATISFIED: ReadonlySet<string> = new Set([
  'in_progress',
  'waiting_payment',
  'completed',
])

/**
 * Job statuses that satisfy the work_completed trigger.
 * Once a job reaches waiting_payment (or beyond), the final tranche's
 * trigger condition is met.
 */
export const WORK_COMPLETED_SATISFIED: ReadonlySet<string> = new Set([
  'waiting_payment',
  'completed',
])

/**
 * Returns true when a funded tranche's release trigger is satisfied
 * by the current job status, but the tranche DB status has not yet
 * caught up (still 'funded' due to partial workflow failure).
 *
 * Only applies to 'funded' tranches. For tranches already in
 * 'eligible_for_release' or later states, this returns false
 * (they don't need stale-trigger reconciliation).
 */
export function isTriggerSatisfied(
  tranche: { kind: string; status: string; releaseTrigger?: string | null },
  jobStatus: string | undefined | null,
): boolean {
  if (!jobStatus) return false
  if (tranche.status !== 'funded') return false

  if (
    tranche.kind === 'deposit_release' &&
    tranche.releaseTrigger === 'work_started' &&
    WORK_STARTED_SATISFIED.has(jobStatus)
  ) {
    return true
  }

  if (
    tranche.kind === 'final_release' &&
    tranche.releaseTrigger === 'work_completed' &&
    WORK_COMPLETED_SATISFIED.has(jobStatus)
  ) {
    return true
  }

  return false
}

/**
 * Returns true when a tranche is effectively eligible for release,
 * combining the DB status check with stale-trigger reconciliation.
 *
 * Use this for any derivation that asks "is this tranche releasable?"
 * instead of checking tranche.status directly.
 */
export function isEffectivelyEligible(
  tranche: { kind: string; status: string; releaseTrigger?: string | null },
  jobStatus: string | undefined | null,
): boolean {
  return (
    tranche.status === 'eligible_for_release' ||
    isTriggerSatisfied(tranche, jobStatus)
  )
}
