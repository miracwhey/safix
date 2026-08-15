/**
 * Server-side payout-corridor reconciliation (Block P · P3b items A + B).
 *
 * Drives the destination-charge corridor's two open lifecycle gaps:
 *
 *   ITEM A — re-attempt + aging
 *     A tranche left at `eligible_for_release` by the release-tranche
 *     `balance_insufficient` soft-fail (destination-charge funds stay ~7 days
 *     pending) is re-poked over HTTP through the canonical /api/release-tranche
 *     endpoint. The endpoint rebuilds the payout idempotency key from the
 *     (cron-bumped) payout_attempt_count, so each re-attempt uses a FRESH key
 *     and bypasses Stripe's cached `balance_insufficient` 4xx. A tranche stuck
 *     >24h raises a Sentry aging alert.
 *
 *   ITEM B — DE 90-day manual-payout deadline
 *     German manual-payout funds must be paid out within 90 days of landing on
 *     the connected account. Anchored on escrow_payment_plans.funded_at, a
 *     tranche is warned at T+60 days and operator-force-flagged at T+75 days
 *     (alerts only — no auto money movement in P3b).
 *
 * CORRIDOR-AWARE: only payout-mode tranches are touched. The cron handler
 * already gates on FUNDING_DESTINATION_CHARGE_ENABLED === 'true' before calling
 * this; as belt-and-braces, any row carrying a tr_* external_release_ref
 * (transfer-corridor row predating a flip) is skipped here so the transfer
 * corridor is never re-issued as a payout.
 *
 * Re-attempt is restricted to `eligible_for_release` ONLY. A `release_pending`
 * tranche has a payout in flight (~7d pending); re-issuing it would create a
 * SECOND payout — a double-pay. Detecting whether an in-flight payout actually
 * died (split-brain payout recovery) is P5 / out of scope. release_pending
 * tranches still get the deadline guard (item B).
 *
 * Pattern: mirrors api/_acceptanceAutoRelease.ts (fetch + classify) and the
 * Sentry escalation style of api/_escrowReconciliation.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PayoutCorridorSummary = {
  /** Fully-released plans whose stuck canonical payment was healed to 'released'. */
  settledFullyReleased: number
  /** Corridor tranches iterated (after the tr_* skip). */
  checked: number
  /** Re-attempts that issued a payout (release-tranche → release_pending). */
  reattempted: number
  /** Re-attempts that stayed deferred (balance_insufficient, 202). */
  deferred: number
  /** Re-attempts held by a dispute / unfinalized attribution. */
  blocked: number
  /** Tranche-level errors (one bad tranche does not abort the batch). */
  failed: number
  /** Tranches stuck >10d at eligible_for_release past settlement (Sentry alert). */
  agingAlerts: number
  /** Tranches at/over T+60 days from funded_at (warn). */
  deadlineWarnings: number
  /** Tranches at/over T+75 days from funded_at (operator-forced). */
  deadlineForced: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 50
const REATTEMPT_AFTER_MS = 60 * 60 * 1000 // 1h
// Destination-charge funds settle in ~7 days (P0-verified): a tranche CORRECTLY
// stays at eligible_for_release during settlement because the payout request
// returns balance_insufficient until the balance funds. A 24h threshold would
// false-fire every hourly tick for ~6 days and bury genuinely-stuck tranches in
// noise. 10d = settlement window + buffer → fires only on truly-stuck tranches.
const AGING_ALERT_AFTER_MS = 10 * 24 * 60 * 60 * 1000 // 10d (settlement + buffer)
const DEADLINE_WARN_DAYS = 60
const DEADLINE_FORCE_DAYS = 75
const MS_PER_DAY = 86_400_000

// Attribution-block / dispute codes mirror api/_acceptanceAutoRelease.ts: a
// re-attempt that hits one of these is HELD (waiting for finalization or
// operator), not a failure — the tranche stays eligible_for_release for the
// next cron tick.
const attributionBlockCodes = new Set([
  'PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED',
  'PAYMENT_BLOCKED_ATTRIBUTION_DLQ',
  'PAYMENT_BLOCKED_ATTRIBUTION_INVALID',
  'PAYMENT_BLOCKED_JOB_NOT_FOUND',
  'ATTRIBUTION_LOOKUP_FAILED',
])

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function reconcilePayoutCorridor(
  supabase: SupabaseClient,
  releaseConfirmSecret: string,
  baseUrl: string,
): Promise<PayoutCorridorSummary> {
  const summary: PayoutCorridorSummary = {
    settledFullyReleased: 0,
    checked: 0,
    reattempted: 0,
    deferred: 0,
    blocked: 0,
    failed: 0,
    agingAlerts: 0,
    deadlineWarnings: 0,
    deadlineForced: 0,
  }

  // ── 0. Heal fully-released plans whose canonical payment never settled ─────
  // The webhook A1 block settles payment→released on the FINAL payout.paid. But a
  // missed/undelivered final payout.paid (Stripe does not retry forever) can leave
  // a plan 'fully_released' with the payment still in a pre-settle state
  // (deposit_paid/in_escrow/work_in_progress/release_pending) and the invoice hung
  // on 'sent'. This idempotent SECDEF RPC converges them: payment→released + job/
  // project sync (mirrors reconcileJobFromPayment); the R3 payments trigger then
  // flips the invoice→paid. Runs BEFORE the tranche early-return below — a
  // fully-released plan has no eligible/release_pending tranches, so it would
  // otherwise be skipped entirely.
  const { data: healed, error: healErr } = await supabase.rpc(
    'reconcile_fully_released_corridor_payments',
  )
  if (healErr) {
    logError('payout_corridor.settle_heal_failed', healErr)
  } else {
    summary.settledFullyReleased = (healed as number | null) ?? 0
    if (summary.settledFullyReleased > 0) {
      logInfo('payout_corridor.settle_healed', { count: summary.settledFullyReleased })
    }
  }

  // ── 1. Query corridor tranches still awaiting completion ──────────────────
  const { data: tranches, error: fetchError } = await supabase
    .from('escrow_tranches')
    .select('id, plan_id, status, eligible_at, updated_at, external_release_ref, external_payout_ref')
    .in('status', ['eligible_for_release', 'release_pending'])
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('payout_corridor.fetch_failed', fetchError)
    throw new Error(`Failed to query payout-corridor tranches: ${fetchError.message}`)
  }

  if (!tranches || tranches.length === 0) {
    logInfo('payout_corridor.none_pending', { checked: 0 })
    return summary
  }

  // Resolve owning plans once per plan_id (funded_at = the 90-day manual-payout
  // clock anchor for item B; job_id is for logging context).
  const planCache = new Map<string, { jobId: string | null; fundedAt: string | null } | null>()
  const resolvePlan = async (
    planId: string,
  ): Promise<{ jobId: string | null; fundedAt: string | null } | null> => {
    const cached = planCache.get(planId)
    if (cached !== undefined) return cached
    const { data: plan, error } = await supabase
      .from('escrow_payment_plans')
      .select('id, job_id, funded_at')
      .eq('id', planId)
      .maybeSingle()
    if (error) {
      logWarning('payout_corridor.plan_lookup_failed', { planId, reason: error.message })
      planCache.set(planId, null)
      return null
    }
    const resolved = plan
      ? {
          jobId: (plan.job_id as string | null) ?? null,
          fundedAt: (plan.funded_at as string | null) ?? null,
        }
      : null
    planCache.set(planId, resolved)
    return resolved
  }

  const now = Date.now()

  for (const tranche of tranches) {
    const trancheId = tranche.id as string
    const planId = tranche.plan_id as string

    // ── CORRIDOR-AWARE belt-and-braces: skip transfer-corridor rows ─────────
    // A non-null external_release_ref (tr_*) marks a transfer-corridor row that
    // predates the flip — never re-issue it as a payout. The caller already
    // gated on PAYOUT_MODE, so this is defensive.
    if (tranche.external_release_ref) continue

    summary.checked++

    try {
      const status = tranche.status as string
      const anchorIso = (tranche.eligible_at as string | null) ?? (tranche.updated_at as string | null)
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN
      const ageMs = Number.isFinite(anchorMs) ? now - anchorMs : 0

      // ── ITEM A — RE-ATTEMPT (only eligible_for_release, >= 1h old) ────────
      // release_pending is NOT re-issued: its payout is in flight (~7d pending
      // for destination-charge funds); re-issuing would double-pay. Healing a
      // stuck-pending payout = split-brain recovery = P5, out of scope.
      if (status === 'eligible_for_release' && ageMs >= REATTEMPT_AFTER_MS) {
        const response = await fetch(`${baseUrl}/api/release-tranche`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-release-confirm-secret': releaseConfirmSecret,
          },
          body: JSON.stringify({
            trancheId,
            planId,
            actor: 'system',
          }),
        })

        const body = (await response.json().catch(() => ({ error: 'Unparseable response' }))) as Record<
          string,
          unknown
        >

        if (response.status === 202) {
          // Still balance_insufficient (release_deferred). The endpoint already
          // bumped payout_attempt_count, so next hour's key is fresh. The
          // tranche stays eligible_for_release for the next cron tick.
          logInfo('payout_corridor.reattempt_deferred', {
            trancheId,
            planId,
            reason: (body as { reason?: string }).reason ?? 'release_deferred',
          })
          summary.deferred++
        } else if (response.ok) {
          // 200 → payout issued (release_pending) or an idempotent already-
          // released hit. Either way the re-attempt advanced the tranche.
          logInfo('payout_corridor.reattempt_succeeded', {
            trancheId,
            planId,
            status: (body as { status?: string }).status ?? 'ok',
          })
          summary.reattempted++
        } else if (
          body.error === 'DISPUTE_BLOCKING'
          || (typeof body.error === 'string' && attributionBlockCodes.has(body.error))
        ) {
          // Dispute or unfinalized attribution — held, not failed. The tranche
          // stays eligible and is retried once the block clears.
          logInfo('payout_corridor.reattempt_blocked', {
            trancheId,
            planId,
            code: body.error,
            httpStatus: response.status,
          })
          summary.blocked++
        } else {
          logWarning('payout_corridor.reattempt_failed', {
            trancheId,
            planId,
            httpStatus: response.status,
            error: body.error,
          })
          summary.failed++
        }
      }

      // ── ITEM A — AGING ALERT (eligible_for_release only, >= 10d) ──────────
      // Threshold is settlement window + buffer, NOT 24h: a tranche correctly
      // stays eligible_for_release for ~7d while destination-charge funds settle
      // (the payout request returns balance_insufficient until then). Do NOT raise
      // aging on release_pending either — the ~1-2d bank-clearing window is normal.
      if (status === 'eligible_for_release' && ageMs >= AGING_ALERT_AFTER_MS) {
        logError('payout_corridor.tranche_aging', undefined, {
          trancheId,
          planId,
          ageHours: Math.floor(ageMs / (60 * 60 * 1000)),
          status,
          severity: 'payout_stuck_past_settlement',
        })
        summary.agingAlerts++
      }

      // ── ITEM B — DE 90-day manual-payout deadline (BOTH states) ───────────
      // Anchored on funded_at (when the net landed on the connected account =
      // start of the 90-day clock). Force/warn are ALERTS ONLY — no auto-force
      // money movement in P3b.
      const plan = await resolvePlan(planId)
      const fundedAt = plan?.fundedAt ?? null
      const fundedMs = fundedAt ? Date.parse(fundedAt) : NaN
      if (!fundedAt || !Number.isFinite(fundedMs)) {
        logWarning('payout_corridor.deadline_anchor_missing', { planId, trancheId })
      } else {
        const ageDays = (now - fundedMs) / MS_PER_DAY
        if (ageDays >= DEADLINE_FORCE_DAYS) {
          logError('payout_corridor.manual_payout_deadline_force', undefined, {
            trancheId,
            planId,
            ageDays,
            severity: 'operator_action_required_before_90d_auto_return',
          })
          summary.deadlineForced++
        } else if (ageDays >= DEADLINE_WARN_DAYS) {
          logWarning('payout_corridor.manual_payout_deadline_warn', {
            trancheId,
            planId,
            ageDays,
          })
          summary.deadlineWarnings++
        }
      }
    } catch (err) {
      // One tranche error must not abort the batch (mirror _acceptanceAutoRelease).
      logError('payout_corridor.tranche_error', err instanceof Error ? err : undefined, {
        trancheId,
        planId,
      })
      summary.failed++
    }
  }

  return summary
}
