/**
 * Shared consensus-split party authorization.
 *
 * Extracted from refund-escrow.ts so BOTH refund-escrow and capture-escrow can
 * authorize a NON-operator dispute PARTY (the customer OR the craftsman) who has
 * reached a genuine two-party consensus split.
 *
 * ── What this grants ─────────────────────────────────────────────────────────
 *
 * The operator dispute-split bypass (refund-escrow's evaluateDisputeSplitBypass)
 * is an operator-only post-release money action. This is a SEPARATE path: a party
 * who proved mutual agreement may drive the customer-share settlement leg
 * themselves — refund-escrow (the customer-share refund) and capture-escrow (the
 * provider-share release, a no-op in the destination-charge corridor).
 *
 * It grants ONLY when every fact below — all read from server-owned rows, never
 * client input — holds:
 *
 *   1. the dispute exists, belongs to this job (+ payment when linked), and is
 *      status='resolved' / decision='split' / settlement_status='pending' with a
 *      split_ratio strictly inside (0,1),
 *   2. an 'accepted' dispute_split_proposals row exists for the dispute whose
 *      confirmed_by is populated AND proposed_by <> confirmed_by — positive proof
 *      of a genuine two-party agreement (confirm_split_proposal only lets the
 *      NON-proposing party accept), distinguishing it from an operator-imposed
 *      split that has no such proposal row,
 *   3. the caller is a party of the dispute — the customer
 *      (disputes.customer_profile_id), the provider resolved from
 *      disputes.provider_id (providers.profile_id), OR a craftsman bound via
 *      jobs.craftsman_user_id::text — exactly the membership confirm_split_proposal
 *      uses, so a craftsman who could CONFIRM is never DENIED here,
 *   4. when requireAmountMatch is true (refund leg only): the requested amount,
 *      converted to the smallest currency unit, EXACTLY equals the customer share
 *      total × (1 − split_ratio) — no tolerance. capture-escrow does not move a
 *      customer-share amount, so it calls with requireAmountMatch=false and the
 *      amount/plan checks are skipped.
 *
 * ── DORMANCY (true boundary) ─────────────────────────────────────────────────
 *
 * The server path is dormant for THREE independent reasons; any one suffices:
 *
 *   (a) CONSENSUS_SPLIT_ENABLED server env flag — checked here BEFORE any DB read.
 *       Unset/''/'false' ⇒ this returns allowed:false / 'consensus_disabled' and
 *       never touches the database, so the grant is impossible regardless of prod
 *       RPC grants. This is the server-side kill switch (the client
 *       VITE_CONSENSUS_SPLIT_ENABLED flag does NOT gate the server — that was the
 *       earlier, incorrect dormancy claim).
 *   (b) the REVOKEd consensus RPCs (propose_split_atomic / confirm_split_proposal /
 *       reject_split_proposal) — revoked from authenticated as defense-in-depth, so
 *       no 'accepted' proposal row can be produced even if (a) were flipped early.
 *   (c) the two-party DB-consensus proof — step (2) requires an 'accepted' proposal
 *       row with confirmed_by populated AND proposed_by <> confirmed_by, which only
 *       confirm_split_proposal can write. With no such row, the branch never grants.
 *
 * Launch flips all three together: re-GRANT the RPCs, set CONSENSUS_SPLIT_ENABLED
 * (server) ON, and set VITE_CONSENSUS_SPLIT_ENABLED (client) ON.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { toSmallestUnit } from './_shared.js'
import { logWarning } from './_observability.js'

export type ConsensusSplitDenyReason =
  | 'consensus_disabled'
  | 'no_dispute_id'
  | 'amount_missing'
  | 'plan_total_missing'
  | 'plan_currency_missing'
  | 'dispute_not_found'
  | 'dispute_wrong_job'
  | 'dispute_wrong_payment'
  | 'dispute_not_resolved_split'
  | 'dispute_already_settled'
  | 'dispute_split_ratio_invalid'
  | 'no_accepted_consensus_proposal'
  | 'caller_not_dispute_party'
  | 'amount_mismatches_customer_share'
  | 'consensus_lookup_failed'

export type ConsensusSplitResult =
  | {
      allowed: true
      disputeId: string
      splitRatio: number
      callerRole: 'customer' | 'provider'
      // Populated only in requireAmountMatch mode (the refund leg).
      customerShareMinor?: number
      requestedMinor?: number
    }
  | {
      allowed: false
      reason: ConsensusSplitDenyReason
    }

export interface ConsensusSplitPartyInput {
  jobId: string
  paymentId: string
  disputeId: string | null
  callerUid: string
  /**
   * When true (refund leg): an explicit amount is required and must equal the
   * customer share in exact minor units. When false (capture leg, which moves no
   * customer-share amount): party + proposal + resolved-split are validated WITHOUT
   * any amount match, and requestedAmount/planTotalAmount/planCurrency are ignored.
   */
  requireAmountMatch: boolean
  requestedAmount?: number
  planTotalAmount?: number | null
  planCurrency?: string | null
  /** Observability label for the calling route (e.g. 'refund-escrow'). */
  route?: string
}

/**
 * Authorizes a consensus-confirmed dispute party for a split settlement leg.
 *
 * Server-flag gated (CONSENSUS_SPLIT_ENABLED): returns 'consensus_disabled'
 * BEFORE any DB read when the flag is OFF, so the server path is truly dormant
 * regardless of prod RPC grants.
 */
export async function evaluateConsensusSplitParty(
  admin: SupabaseClient,
  input: ConsensusSplitPartyInput,
): Promise<ConsensusSplitResult> {
  const {
    jobId,
    paymentId,
    disputeId,
    callerUid,
    requireAmountMatch,
    requestedAmount,
    planTotalAmount,
    planCurrency,
    route = 'consensus-split-auth',
  } = input

  // (a) Server kill switch — read at call time (not a module const) so dormancy is
  // exact: unset/''/'false' all mean OFF. Return BEFORE any DB read so the path is
  // dormant even if the prod RPCs were (incorrectly) left granted.
  if (process.env.CONSENSUS_SPLIT_ENABLED !== 'true') {
    return { allowed: false, reason: 'consensus_disabled' }
  }

  if (!disputeId || disputeId.trim() === '') {
    return { allowed: false, reason: 'no_dispute_id' }
  }

  if (requireAmountMatch) {
    // A consensus split refund carries the exact customer share; an explicit
    // amount is mandatory so the server can match it (no full-refund fallback).
    if (
      typeof requestedAmount !== 'number' ||
      !Number.isFinite(requestedAmount) ||
      requestedAmount <= 0
    ) {
      return { allowed: false, reason: 'amount_missing' }
    }
    if (planTotalAmount === null || planTotalAmount === undefined || planTotalAmount <= 0) {
      return { allowed: false, reason: 'plan_total_missing' }
    }
    if (planCurrency === null || planCurrency === undefined || planCurrency === '') {
      return { allowed: false, reason: 'plan_currency_missing' }
    }
  }

  const trimmedDisputeId = disputeId.trim()

  // Dispute facts — server-owned; the caller cannot fabricate the id, the
  // resolution state, or their own party membership.
  const { data: disputeRow, error: disputeError } = await admin
    .from('disputes')
    .select(
      'id, job_id, payment_id, status, decision, split_ratio, settlement_status, customer_profile_id, provider_id',
    )
    .eq('id', trimmedDisputeId)
    .maybeSingle()

  if (disputeError) {
    logWarning('api.consensus.lookup_failed', {
      route,
      jobId,
      paymentId,
      disputeId: trimmedDisputeId,
      stage: 'load_dispute',
      detail: disputeError.message,
    })
    return { allowed: false, reason: 'consensus_lookup_failed' }
  }

  if (!disputeRow) {
    return { allowed: false, reason: 'dispute_not_found' }
  }

  const dispute = disputeRow as {
    id: string
    job_id: string | null
    payment_id: string | null
    status: string | null
    decision: string | null
    split_ratio: number | string | null
    settlement_status: string | null
    customer_profile_id: string | null
    provider_id: string | null
  }

  if (dispute.job_id !== jobId) {
    return { allowed: false, reason: 'dispute_wrong_job' }
  }

  // payment_id is nullable on legacy dispute rows; only enforce linkage when it is
  // populated. The job-id check above already binds the dispute.
  if (dispute.payment_id !== null && dispute.payment_id !== '' && dispute.payment_id !== paymentId) {
    return { allowed: false, reason: 'dispute_wrong_payment' }
  }

  if (dispute.status !== 'resolved' || dispute.decision !== 'split') {
    return { allowed: false, reason: 'dispute_not_resolved_split' }
  }

  // 'pending' from the moment the split resolves until the customer share is
  // refunded and settleDispute() runs. Anything else = replay of a settled split.
  if (dispute.settlement_status !== 'pending') {
    return { allowed: false, reason: 'dispute_already_settled' }
  }

  const splitRatio =
    dispute.split_ratio === null || dispute.split_ratio === undefined
      ? null
      : Number(dispute.split_ratio)

  // Strictly inside (0,1): a real split gives each side a non-zero share. 0 or 1
  // would be a full release/refund, which is not a split settlement.
  if (splitRatio === null || !Number.isFinite(splitRatio) || splitRatio <= 0 || splitRatio >= 1) {
    return { allowed: false, reason: 'dispute_split_ratio_invalid' }
  }

  // Positive two-party-consensus proof. confirm_split_proposal is the ONLY writer
  // of 'accepted' rows, and only the NON-proposing party can confirm, so a row with
  // confirmed_by populated AND proposed_by <> confirmed_by is genuine mutual
  // agreement — never an operator-imposed split (which produces no proposal row).
  const { data: proposalRow, error: proposalError } = await admin
    .from('dispute_split_proposals')
    .select('id, proposed_by, confirmed_by, status')
    .eq('dispute_id', trimmedDisputeId)
    .eq('status', 'accepted')
    .not('confirmed_by', 'is', null)
    .limit(1)
    .maybeSingle()

  if (proposalError) {
    logWarning('api.consensus.lookup_failed', {
      route,
      jobId,
      paymentId,
      disputeId: trimmedDisputeId,
      stage: 'load_proposal',
      detail: proposalError.message,
    })
    return { allowed: false, reason: 'consensus_lookup_failed' }
  }

  const proposal = proposalRow as
    | { id: string; proposed_by: string | null; confirmed_by: string | null; status: string | null }
    | null

  if (
    !proposal ||
    proposal.confirmed_by === null ||
    proposal.confirmed_by === '' ||
    proposal.proposed_by === null ||
    proposal.proposed_by === proposal.confirmed_by
  ) {
    return { allowed: false, reason: 'no_accepted_consensus_proposal' }
  }

  // ── Party resolution — server-owned, never client input ────────────────────
  //
  // Mirrors confirm_split_proposal's mixed-model membership EXACTLY so a craftsman
  // who could CONFIRM the split is never DENIED at the settlement leg:
  //
  //   customer : disputes.customer_profile_id = caller
  //   provider : jobs.craftsman_user_id::text = caller                    (route A)
  //              OR disputes.provider_id → providers.profile_id = caller  (route C)
  //              OR jobs.provider_id → providers.profile_id = caller,
  //                 gated on disputes.provider_id non-null                (route B)
  //
  // Route A is the craftsman bound ONLY via jobs.craftsman_user_id, with
  // disputes.provider_id NULL or divergent — the case the prior helper missed.
  let callerRole: 'customer' | 'provider' | null = null

  if (dispute.customer_profile_id !== null && dispute.customer_profile_id === callerUid) {
    callerRole = 'customer'
  } else {
    const { data: jobRow, error: jobError } = await admin
      .from('jobs')
      .select('craftsman_user_id, provider_id')
      .eq('id', jobId)
      .maybeSingle()

    if (jobError) {
      logWarning('api.consensus.lookup_failed', {
        route,
        jobId,
        paymentId,
        disputeId: trimmedDisputeId,
        stage: 'load_job',
        detail: jobError.message,
      })
      return { allowed: false, reason: 'consensus_lookup_failed' }
    }

    const job = jobRow as { craftsman_user_id: string | null; provider_id: string | null } | null

    // Route A: craftsman bound via jobs.craftsman_user_id (text) = caller.
    if (job && job.craftsman_user_id !== null && job.craftsman_user_id === callerUid) {
      callerRole = 'provider'
    } else {
      // Routes C + B: resolve candidate providers.id → providers.profile_id.
      // C uses disputes.provider_id directly; B uses jobs.provider_id but only when
      // disputes.provider_id is populated (mirrors confirm_split_proposal's gate).
      const candidateProviderIds = new Set<string>()
      if (dispute.provider_id !== null && dispute.provider_id !== '') {
        candidateProviderIds.add(dispute.provider_id) // route C
        if (job && job.provider_id !== null && job.provider_id !== '') {
          candidateProviderIds.add(job.provider_id) // route B (gated on disputes.provider_id)
        }
      }

      if (candidateProviderIds.size > 0) {
        const { data: providerRows, error: providerError } = await admin
          .from('providers')
          .select('id, profile_id')
          .in('id', Array.from(candidateProviderIds))

        if (providerError) {
          logWarning('api.consensus.lookup_failed', {
            route,
            jobId,
            paymentId,
            disputeId: trimmedDisputeId,
            stage: 'load_provider',
            detail: providerError.message,
          })
          return { allowed: false, reason: 'consensus_lookup_failed' }
        }

        const providers = (providerRows ?? []) as { id: string; profile_id: string | null }[]
        if (providers.some((p) => p.profile_id !== null && p.profile_id === callerUid)) {
          callerRole = 'provider'
        }
      }
    }
  }

  if (callerRole === null) {
    return { allowed: false, reason: 'caller_not_dispute_party' }
  }

  if (!requireAmountMatch) {
    // Capture leg: no customer-share amount moves, so party + proposal +
    // resolved-split is sufficient. No amount match.
    return { allowed: true, disputeId: dispute.id, splitRatio, callerRole }
  }

  // Exact-amount match in the smallest currency unit (same comparator as
  // evaluateDisputeSplitBypass): refund must equal the customer share
  // total × (1 − split_ratio), no tolerance. Guarded above: requestedAmount,
  // planTotalAmount, planCurrency are all present in requireAmountMatch mode.
  const customerShareMinor = toSmallestUnit(
    (planTotalAmount as number) * (1 - splitRatio),
    planCurrency as string,
  )
  const requestedMinor = toSmallestUnit(requestedAmount as number, planCurrency as string)

  if (requestedMinor !== customerShareMinor) {
    return { allowed: false, reason: 'amount_mismatches_customer_share' }
  }

  return {
    allowed: true,
    disputeId: dispute.id,
    splitRatio,
    callerRole,
    customerShareMinor,
    requestedMinor,
  }
}
