/**
 * Server-side escrow tranche reconciliation.
 *
 * Detects and recovers from the critical failure mode where a Stripe Transfer
 * has been executed but the DB write marking the tranche as 'released' failed.
 *
 * Strategy:
 * 1. Query all escrow tranches in 'eligible_for_release' state (the only state
 *    from which a release can be attempted).
 * 2. For each, look up whether a Stripe Transfer exists in the corresponding
 *    transfer_group (`escrow_plan_<planId>`).
 * 3. If a matching Transfer is found, update the tranche to 'released' and
 *    recompute the plan rollup status.
 *
 * Matching logic:
 * - The idempotency key used by release-tranche.ts is `tranche_release_<trancheId>`.
 * - Stripe Transfers carry `transfer_group = escrow_plan_<planId>`.
 * - We match by scanning Transfers in the transfer_group and comparing amounts
 *   against tranche amounts (net of platform fee).
 * - As a safety guard, we also verify the Transfer destination matches the
 *   provider's Connect account on the plan.
 *
 * Concurrency safety:
 * - The tranche update uses an optimistic concurrency guard:
 *   `.eq('status', 'eligible_for_release')` prevents overwriting a more-advanced
 *   state set by a concurrent actor.
 *
 * Idempotent: safe to run repeatedly. Already-released tranches are skipped.
 */

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscrowReconciliationSummary = {
  /** Number of eligible_for_release tranches checked */
  checked: number
  /** Tranches that had no orphaned Transfer (correctly eligible) */
  aligned: number
  /** Tranches recovered: Stripe Transfer found, DB updated to released */
  recovered: number
  /** Tranches where recovery failed (DB update error) */
  failed: number
  /** Plan rollup corrections applied */
  planRollupsFixed: number
}

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 50

export async function reconcileEscrowTranches(
  supabase: SupabaseClient,
  stripe: Stripe,
): Promise<EscrowReconciliationSummary> {
  const summary: EscrowReconciliationSummary = {
    checked: 0,
    aligned: 0,
    recovered: 0,
    failed: 0,
    planRollupsFixed: 0,
  }

  // ── 1. Fetch tranches stuck in eligible_for_release ─────────────────────
  const { data: staleTranches, error: fetchError } = await supabase
    .from('escrow_tranches')
    .select('id, plan_id, amount, kind, status')
    .eq('status', 'eligible_for_release')
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('reconciliation.escrow.fetch_failed', fetchError)
    throw new Error(`Failed to query eligible escrow tranches: ${fetchError.message}`)
  }

  if (!staleTranches || staleTranches.length === 0) {
    logInfo('reconciliation.escrow.none_eligible', { checked: 0 })
    return summary
  }

  // ── 2. Group tranches by plan for efficient Stripe lookups ──────────────
  const tranchesByPlan = new Map<string, typeof staleTranches>()
  for (const tranche of staleTranches) {
    const existing = tranchesByPlan.get(tranche.plan_id) ?? []
    existing.push(tranche)
    tranchesByPlan.set(tranche.plan_id, existing)
  }

  // ── 3. For each plan, check Stripe for existing Transfers ───────────────
  const planIdsToRecheck = new Set<string>()

  for (const [planId, tranches] of tranchesByPlan.entries()) {
    summary.checked += tranches.length

    // Fetch the plan to get provider Connect account for verification
    const { data: plan } = await supabase
      .from('escrow_payment_plans')
      .select('id, provider_id, currency, platform_fee_rate')
      .eq('id', planId)
      .maybeSingle()

    if (!plan) {
      logWarning('reconciliation.escrow.plan_not_found', { planId })
      summary.aligned += tranches.length
      continue
    }

    // Resolve the provider's Connect account.
    // escrow_payment_plans.provider_id is a FK to providers.id (table PK), NOT the
    // provider's auth user id. provider_payout_accounts is keyed by provider_user_id
    // (= providers.profile_id = profiles.id = auth uid). Resolve in two steps,
    // mirroring the live release path (release-tranche.ts). The prior single
    // `.eq('user_id', plan.provider_id)` matched nothing (wrong column AND wrong id
    // space) → connectAccountId was always undefined and the destination guard in
    // the amount-fallback matcher below was silently bypassed.
    const { data: providerRow } = await supabase
      .from('providers')
      .select('profile_id')
      .eq('id', plan.provider_id)
      .maybeSingle()

    if (!providerRow?.profile_id) {
      // No provider→profile mapping: the amount-fallback matcher loses its
      // destination guard for this plan (same as the pre-fix behavior). Surface it
      // so an unmapped provider can be fixed before a mis-attributed heal.
      logWarning('reconciliation.escrow.provider_profile_unresolved', {
        planId,
        providerId: plan.provider_id,
      })
    }

    const { data: payoutAccount } = providerRow?.profile_id
      ? await supabase
          .from('provider_payout_accounts')
          .select('stripe_connect_account_id')
          .eq('provider_user_id', providerRow.profile_id)
          .maybeSingle()
      : { data: null }

    const connectAccountId = payoutAccount?.stripe_connect_account_id

    // Query Stripe for all Transfers in this plan's transfer_group
    let transfers: Stripe.Transfer[]
    try {
      const result = await stripe.transfers.list({
        transfer_group: `escrow_plan_${planId}`,
        limit: 20,
      })
      transfers = result.data
    } catch (err) {
      logWarning('reconciliation.escrow.stripe_list_failed', {
        planId,
        error: err instanceof Error ? err.message : String(err),
      })
      summary.aligned += tranches.length
      continue
    }

    if (transfers.length === 0) {
      // No transfers at all for this plan — tranches are genuinely waiting
      summary.aligned += tranches.length
      continue
    }

    // ── 4. Match tranches to Transfers ──────────────────────────────────
    for (const tranche of tranches) {
      // Find a Transfer whose amount matches the tranche net amount
      // The platform fee means the Transfer amount is less than the tranche gross
      const trancheGross = Number(tranche.amount)
      const feeRate = Number(plan.platform_fee_rate) || 0.09
      const expectedNetCents = Math.round(trancheGross * (1 - feeRate) * 100)

      const matchingTransfer = transfers.find((t) => {
        // Prefer metadata match: exact tranche identification, works for both
        // full and split-adjusted transfers regardless of amount.
        if (t.metadata?.tranche_id === tranche.id) return true
        // Fallback: amount + destination match for legacy transfers without metadata
        const amountMatch = t.amount === expectedNetCents
        const destMatch = !connectAccountId || t.destination === connectAccountId
        return amountMatch && destMatch
      })

      if (!matchingTransfer) {
        summary.aligned++
        continue
      }

      // ── 5. Recover: update tranche to released ──────────────────────
      const now = new Date().toISOString()
      const { error: updateError } = await supabase
        .from('escrow_tranches')
        .update({
          status: 'released',
          released_at: now,
          released_by: 'system',
          external_release_ref: matchingTransfer.id,
          updated_at: now,
        })
        .eq('id', tranche.id)
        .eq('status', 'eligible_for_release') // Optimistic concurrency guard

      if (updateError) {
        logError('reconciliation.escrow.update_failed', updateError, {
          trancheId: tranche.id,
          transferId: matchingTransfer.id,
        })
        summary.failed++
      } else {
        // Split-brain CONFIRMED + HEALED: a Stripe Transfer existed but the DB
        // tranche was still 'eligible_for_release' (the post-transfer DB write in
        // release-tranche.ts had failed). This is a money/DB divergence — escalate
        // to Sentry (logError) so operators see every occurrence, even self-healed.
        logError('reconciliation.escrow.split_brain_recovered', undefined, {
          trancheId: tranche.id,
          planId,
          transferId: matchingTransfer.id,
          trancheKind: tranche.kind,
          amount: trancheGross,
          severity: 'money_db_divergence_healed',
        })
        summary.recovered++
        planIdsToRecheck.add(planId)
      }
    }
  }

  // ── 6. Fix plan rollup status for any plans where tranches were recovered ──
  for (const planId of planIdsToRecheck) {
    const { data: allTranches } = await supabase
      .from('escrow_tranches')
      .select('id, status')
      .eq('plan_id', planId)

    if (!allTranches) continue

    const allReleased = allTranches.every((t) => t.status === 'released')
    const anyReleased = allTranches.some((t) => t.status === 'released')

    let planStatus: string
    if (allReleased) {
      planStatus = 'fully_released'
    } else if (anyReleased) {
      planStatus = 'partially_released'
    } else {
      planStatus = 'funded_in_escrow'
    }

    const { error: rollupError } = await supabase
      .from('escrow_payment_plans')
      .update({ status: planStatus, updated_at: new Date().toISOString() })
      .eq('id', planId)

    if (rollupError) {
      logError('reconciliation.escrow.rollup_failed', rollupError, { planId, planStatus })
    } else {
      logInfo('reconciliation.escrow.rollup_fixed', { planId, planStatus })
      summary.planRollupsFixed++
    }
  }

  return summary
}
