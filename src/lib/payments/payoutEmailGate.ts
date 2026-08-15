/**
 * Payout-outcome email gate.
 *
 * Pure derivation that decides which jobs are eligible for a job-level
 * `payout_completed` email. The email template announces the job as
 * fully paid out, so it must only fire when:
 *
 *   (a) the escrow plan is `fully_released`; AND
 *   (b) every released tranche of that plan carries a `payout_completed`
 *       timeline signal id (`timeline_payout_completed__{ref}`), where the
 *       proving ref is the tranche's `external_release_ref` (tr_*, transfer
 *       corridor) OR — under the destination-charge payout corridor —
 *       `external_payout_ref` (po_*). Both ref types map to the same signal
 *       id shape, so a corridor tranche counts as paid-out exactly like a
 *       transfer one once its `timeline_payout_completed__{po}` signal lands.
 *
 * A partial `payout.paid` that covers only the 25 % deposit tranche on a
 * job whose 75 % tranche has not yet been paid must NOT trigger the
 * job-level email. The UI/finance surface still surfaces the tranche
 * outcome via `derivePayoutOutcomesByTransfer` + MoneyFlowProjection
 * (`payout_in_transit` while mixed).
 *
 * Inputs are shape-compatible with the Supabase rows the Stripe webhook
 * fetches; the helper itself is repo-agnostic so it can be unit-tested.
 */

export type PayoutGatePlan = {
  id: string
  jobId: string
  status: string
}

export type PayoutGateTranche = {
  planId: string
  externalReleaseRef: string | null
  /**
   * Destination-charge corridor proving ref (po_*). Optional so transfer-
   * corridor rows (which carry only external_release_ref) and every existing
   * call site / test that omits it continue to compile and behave identically.
   */
  externalPayoutRef?: string | null
  status: string
}

/**
 * Signal ids are stored as `timeline_payout_completed__{transferId}`.
 */
const COMPLETED_SIGNAL_PREFIX = 'timeline_payout_completed__'

export function buildPayoutCompletedSignalIds(transferIds: Iterable<string>): string[] {
  const out: string[] = []
  for (const id of transferIds) out.push(`${COMPLETED_SIGNAL_PREFIX}${id}`)
  return out
}

export function extractTransferRefFromCompletedSignalId(id: string): string | null {
  if (!id.startsWith(COMPLETED_SIGNAL_PREFIX)) return null
  const ref = id.slice(COMPLETED_SIGNAL_PREFIX.length)
  return ref.length > 0 ? ref : null
}

/**
 * Returns the subset of jobIds whose plan is fully released AND whose
 * released tranches all have a payout_completed signal present.
 */
export function deriveJobsFullyPaidOut(params: {
  plans: PayoutGatePlan[]
  tranches: PayoutGateTranche[]
  /** Signal ids observed in `timeline_signals`. */
  completedSignalIds: string[]
}): Set<string> {
  const { plans, tranches, completedSignalIds } = params
  const eligible = new Set<string>()

  const fullyReleasedPlanIds = new Set<string>()
  const jobIdByPlanId = new Map<string, string>()
  for (const plan of plans) {
    if (plan.status !== 'fully_released') continue
    fullyReleasedPlanIds.add(plan.id)
    jobIdByPlanId.set(plan.id, plan.jobId)
  }
  if (fullyReleasedPlanIds.size === 0) return eligible

  const releasedRefsByPlan = new Map<string, Set<string>>()
  for (const t of tranches) {
    if (!fullyReleasedPlanIds.has(t.planId)) continue
    // A released tranche proves its payout via EITHER ref: external_release_ref
    // (tr_*, transfer corridor) OR external_payout_ref (po_*, destination-charge
    // payout corridor). Both resolve to a `timeline_payout_completed__{ref}`
    // signal. Flag-OFF, externalPayoutRef is always absent/NULL so provingRef
    // === externalReleaseRef and this is byte-identical to the transfer path.
    const provingRef = t.externalReleaseRef ?? t.externalPayoutRef ?? null
    if (t.status !== 'released' || !provingRef) continue
    let set = releasedRefsByPlan.get(t.planId)
    if (!set) {
      set = new Set<string>()
      releasedRefsByPlan.set(t.planId, set)
    }
    set.add(provingRef)
  }

  const completedRefs = new Set<string>()
  for (const sid of completedSignalIds) {
    const ref = extractTransferRefFromCompletedSignalId(sid)
    if (ref) completedRefs.add(ref)
  }

  for (const [planId, refs] of releasedRefsByPlan.entries()) {
    if (refs.size === 0) continue
    let allCompleted = true
    for (const ref of refs) {
      if (!completedRefs.has(ref)) {
        allCompleted = false
        break
      }
    }
    if (allCompleted) {
      const jobId = jobIdByPlanId.get(planId)
      if (jobId) eligible.add(jobId)
    }
  }

  return eligible
}
