/**
 * Block P · Run 2 — T+80 dispute-default-cut worker.
 *
 * Daily sweep that applies the AGB default for a dispute that has reached T+80
 * days (anchored on escrow_payment_plans.funded_at) with NO consensus and NO
 * operator action: a 75/25 PARTIAL refund (provisional + right-of-recourse). The
 * still-HELD remainder (the non-released tranches) is refunded to the customer;
 * the already-released tranche stays with the craftsman. The money side reuses
 * the SHARED refund mechanic (executeEscrowRefundForIntent), passing the held
 * snapshot as the amount, refundApplicationFee:true (the platform fee follows the
 * refunded money even on a partial), and a stable per-dispute idempotency suffix
 * — all dormant unless the flag is ON.
 *
 * Three-phase per dispute (idempotent at every phase — safe to re-run):
 *   1. apply_dispute_default_refund (RPC) — flips the dispute to
 *      resolved / refund / refund_partial / settlement_status=pending, stamps
 *      default_applied_at AND the held-remainder snapshot (default_refund_minor).
 *      IDEMPOTENT: if operator/consensus already decided (decision IS NOT NULL)
 *      or the default already fired, it returns the row unchanged → the worker
 *      detects "not ours" and skips, never refunding. On a 1b retry it returns
 *      the SAME already-stamped snapshot → the refund amount is deterministic.
 *   2. executeEscrowRefundForIntent (Stripe) — the PARTIAL refund of the held
 *      snapshot, with refundApplicationFee:true and the STABLE idempotency key
 *      `refund_<pi>_default_<disputeId>` (per-dispute, NOT amount-derived), so a
 *      retry on the next tick re-uses the cached Stripe refund (G1).
 *   3. settle_dispute_default (RPC) — flips settlement_status pending→settled,
 *      marks ONLY the still-HELD tranches 'refunded' (shared held predicate), and
 *      writes a refund_partial ledger row over the held snapshot
 *      (default_refund_minor). It does NOT mark the escrow plan 'refunded' and
 *      does NOT touch payments/jobs/project — the released 25% stays with the
 *      craftsman (Option B / G6=B, the settle_consensus_split pattern). See
 *      PAYMENT-FSM below. IDEMPOTENT: already-settled rows return unchanged.
 *      (Since P4 Batch 4 this RPC is a thin delegate to the shared
 *      settle_dispute_resolution body — cron + webhook funnel through ONE settle.)
 *
 * After a default fully settles, BOTH parties are notified that an AGB T+80
 * provisional default refund was applied (see PARTY NOTIFICATION below). The
 * notification is strictly best-effort and never throws out of the per-dispute
 * handler — the money already moved; a failed email must not flip the dispute
 * back or abort the batch.
 *
 * SELF-HEALING SELECTION (findings 2 & 3): apply_dispute_default_refund commits
 * its OWN transaction (decision='refund', status='resolved', default_applied_at
 * set) BEFORE the Stripe refund + settle run here in JS. A transient failure
 * after that commit (missing PI, Stripe error, settle error) would otherwise
 * permanently exclude the dispute from the primary query — stranding the owed
 * refund / leaving settlement drift, with NO external reconciler (the cron is
 * the only caller of settle_dispute_default; api/_serverReconciliation.ts
 * excludes disputed payments). So the worker runs TWO selections each tick:
 *   (1a) still-undecided open-family disputes (the normal entry), and
 *   (1b) in-progress AUTO-defaults (status='resolved', decision='refund',
 *        settlement_status='pending', default_applied_at IS NOT NULL) whose
 *        refund/settle did not finish — re-driven to completion idempotently
 *        (re-apply returns the same pending row → re-refund via Stripe
 *        idempotency key → re-settle). The `default_applied_at IS NOT NULL`
 *        predicate scopes 1b strictly to the T+80 default and NEVER touches an
 *        operator refund (also resolved/refund/pending) owned by a different
 *        settlement path.
 *
 * STUCK ESCALATION (item 4): a 1b in-progress AUTO-default whose
 * default_applied_at is older than STUCK_AFTER_MS has failed to complete across
 * many daily ticks — its PaymentIntent is permanently missing or its refund
 * persistently fails. The worker KEEPS retrying it (idempotent) but raises a
 * high-visibility `dispute_default.stuck` logError with disputeId + ageDays so a
 * genuinely-broken default is never a silent infinite retry. No new column: the
 * age is computed from default_applied_at, already selected for the 1b set.
 *
 * PAYMENT-FSM (Option B / G6=B): the 75/25 partial default is NOT a full-refund
 * terminal — the craftsman performed and keeps the released 25% — so
 * settle_dispute_default deliberately does NOT touch payments/jobs/project and
 * does NOT mark the escrow plan 'refunded'. It ONLY flips
 * disputes.settlement_status pending→settled, marks the still-HELD tranches
 * 'refunded', and writes the refund_partial ledger row. The money truth lives in
 * the tranche grain + ledger + dispute fields (consumed by moneyFlowProjection),
 * mirroring settle_consensus_split exactly. open_dispute_atomic's
 * payments.status='disputed' is therefore left as-is: there is no "force the
 * payment to refunded" step, so the provider-recovery refund webhook's refusal of
 * disputed→refunded is irrelevant (no FSM convergence is attempted). The worker
 * stays pure orchestration.
 *
 * PARTY NOTIFICATION (item 2): on a successful default-fire the worker emails
 * BOTH the customer and the craftsman through the SHARED notification channel
 * (deliverNotificationEmailServer → Resend → email_delivery_log), the exact
 * pipeline the Stripe webhook payout fan-out and the /api/send-notification-email
 * endpoint already use. The new `dispute_default_refund_applied` template is
 * neutral German copy with explicit "vorläufig/provisorisch" + Rechtsweg-
 * Vorbehalt. Recipients are the two AUTH user ids on the JOB
 * (jobs.customer_user_id / jobs.craftsman_user_id) — NOT the dispute's
 * customer_profile_id/provider_id, which are profile/provider FKs the email
 * helper's auth.admin.getUserById would never resolve.
 *
 * SCOPE-LEAK GUARD (critical): this worker drives ONLY off the disputes table.
 * It NEVER touches non-disputed stalled acceptances — those are the §640 / P6
 * 14-day auto-release path (api/_acceptanceAutoRelease.ts), a different corridor.
 * Selecting only disputes with an OPEN-family status + decision IS NULL (1a), or
 * an AUTO-default in flight (1b), keeps the two paths strictly disjoint.
 *
 * HELD-ONLY REFUND (no post-release clawback): the 75/25 cut refunds ONLY the
 * still-HELD remainder. apply_dispute_default_refund computes the held snapshot
 * (default_refund_minor) from the SHARED held predicate — tranches whose
 * status NOT IN ('released','release_pending') AND external_release_ref IS NULL
 * AND external_payout_ref IS NULL AND transfer_reversal_ref IS NULL — so an
 * already-released/paid-out tranche is EXCLUDED and stays with the provider. The
 * reverse_transfer therefore only pulls back the in-escrow portion; the old
 * full-refund's negative-Connect-balance clawback (debit_negative_balances SEPA
 * pull) is NOT triggered by the default path.
 *
 * FLAG GATE: the cron caller (api/cron/default-cut-disputes.ts) returns a
 * corridor_disabled no-op BEFORE constructing Supabase/Stripe whenever
 * FUNDING_DESTINATION_CHARGE_ENABLED !== 'true', so this worker never runs while
 * the flag is unset. The flag is also read here and handed to the shared refund
 * service, which ADDITIONALLY requires the PI to be a real destination charge
 * before it emits any reverse_transfer / refund_application_fee param.
 *
 * Pattern: mirrors api/_payoutCorridorReconciliation.ts (batch fetch, plan
 * cache, per-item try/catch so one bad dispute never aborts the batch, deadline
 * anchored on funded_at, structured logInfo/logWarning/logError observability).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { executeEscrowRefundForIntent } from './_escrowRefundService.js'
import { deliverNotificationEmailServer } from './_emailDelivery.js'
import { logInfo, logWarning, logError } from './_observability.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ANCHOR (Run-3 research): 80 days, anchored on escrow_payment_plans.funded_at.
// KEEP 80 — the funded-anchor is safe. The only charge-anchored hard wall on the
// refund (executeEscrowRefundForIntent) is Stripe's 180-day card/SEPA refund
// window, measured from the ORIGINAL CHARGE. Destination-charge funds settle in
// ~7 days, so T+80-on-funded resolves to ~T+87-from-charge → ~93 days of
// headroom under the 180-day wall (still ~70d even at an unrealistic charge+30
// settlement). The much-feared "~90d auto-return from charge" does NOT apply to
// a captured EUR destination charge on an active DE account — the 90d clocks
// (payout-reversal window, reserves, customer-balance reconciliation sweep) are
// platform-initiated or funding-type-specific, none auto-returns the customer's
// money. Reducing the deadline buys ZERO safety and only shortens the dispute
// resolution runway, so the worker is unchanged (changeWorker=false).
const DEADLINE_DEFAULT_DAYS = 80
const BATCH_LIMIT = 50
const MS_PER_DAY = 86_400_000

// The held-remainder snapshot (disputes.default_refund_minor) is stored in MINOR
// units (EUR cents) by apply_dispute_default_refund. The corridor is EUR-only
// (matching the EUR-anchored MAX_REFUND_AMOUNTS guard). The shared refund service
// takes `amount` in MAJOR units and re-applies toSmallestUnit() before calling
// Stripe, so we divide the snapshot back to major units here. /100 then ×100
// round-trips an integer-cent snapshot exactly.
const MINOR_UNITS_PER_EUR = 100

// A 1b in-progress AUTO-default still pending this long after default_applied_at
// has demonstrably failed to complete across many daily ticks (~3 days of cron
// runs) → genuinely stuck (PI permanently missing / persistent refund failure).
// Keep retrying (idempotent) but ALERT so it is never a silent infinite retry.
const STUCK_AFTER_MS = 3 * MS_PER_DAY // 3 days

// The OPEN-family dispute statuses that the default can still act on. A dispute
// already resolved/closed/cancelled is terminal and out of scope. This list
// must stay in lockstep with the apply_dispute_default_refund RPC gate.
const ELIGIBLE_DISPUTE_STATUSES: string[] = [
  'open',
  'under_review',
  'customer_waiting',
  'provider_waiting',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeDefaultCutSummary = {
  /** Disputes iterated this run. */
  checked: number
  /** Disputes the default fully applied + refunded + settled. */
  defaulted: number
  /** Disputes not yet at T+80 (funded_at age < 80d). */
  skippedNotEligible: number
  /** apply RPC returned a row that is NOT our pending default (operator/consensus won). */
  skippedNotOurs: number
  /** apply RPC returned an already-settled default (a prior tick finished it). */
  alreadySettled: number
  /** Plan missing or funded_at NULL → no T+80 clock anchor. */
  anchorMissing: number
  /** Per-dispute errors (missing PI, Stripe ok:false, RPC error). One does not abort the batch. */
  failed: number
}

// 1a rows carry only id + job_id (default_applied_at IS NULL by query filter).
// 1b rows additionally carry default_applied_at — the anchor for the stuck check.
type DisputeRow = { id: string; job_id: string; default_applied_at?: string | null }

// Shape of the jsonb row returned by apply_dispute_default_refund (row_to_json).
type DefaultRefundRow = {
  decision: string | null
  resolution_type: string | null
  default_applied_at: string | null
  settlement_status: string | null
  // Held-remainder snapshot in MINOR units (EUR cents) — the 75% side of the
  // 75/25 cut. Stamped once by the apply RPC; re-read identically on retry (G1).
  default_refund_minor: number | null
}

// ---------------------------------------------------------------------------
// Party notification (best-effort) — item 2
// ---------------------------------------------------------------------------

/**
 * Emails BOTH parties that an AGB T+80 provisional default refund was applied,
 * through the SHARED notification channel (deliverNotificationEmailServer). This
 * is STRICTLY best-effort: every failure path is swallowed + logged as a warning
 * and this function NEVER throws, so a notification failure can never flip the
 * dispute back, mark it failed, or abort the batch (the money already moved).
 *
 * Recipients are resolved from the JOB's AUTH user ids
 * (jobs.customer_user_id / jobs.craftsman_user_id) — the same canonical ids the
 * email helper's auth.admin.getUserById expects. The dispute's
 * customer_profile_id / provider_id are profile/provider FKs and are NOT auth
 * ids, so they are deliberately not used here.
 */
async function notifyDefaultApplied(
  supabase: SupabaseClient,
  disputeId: string,
  jobId: string,
  refundAmountMinor: number,
): Promise<void> {
  try {
    const { data: jobRows, error } = await supabase
      .from('jobs')
      .select('customer_user_id, craftsman_user_id, title')
      .eq('id', jobId)
      .limit(1)

    if (error) {
      logWarning('dispute_default.notify_lookup_failed', {
        disputeId,
        jobId,
        reason: error.message,
      })
      return
    }

    const jobRow = (jobRows ?? [])[0] as
      | { customer_user_id: string | null; craftsman_user_id: string | null; title: string | null }
      | undefined

    if (!jobRow) {
      logWarning('dispute_default.notify_job_missing', { disputeId, jobId })
      return
    }

    const jobTitle = jobRow.title ?? undefined
    const recipients: Array<{ userId: string | null; role: 'customer' | 'craftsman' }> = [
      { userId: jobRow.customer_user_id, role: 'customer' },
      { userId: jobRow.craftsman_user_id, role: 'craftsman' },
    ]

    for (const recipient of recipients) {
      if (!recipient.userId) {
        logInfo('dispute_default.notify_skipped', {
          disputeId,
          jobId,
          role: recipient.role,
          reason: 'no_user_id',
        })
        continue
      }
      try {
        // Returns a degradation result rather than throwing for the common
        // non-fatal cases (no Resend key, unknown email, Resend error); we log
        // it but never branch on it. The try/catch guards an unexpected throw.
        await deliverNotificationEmailServer(supabase, {
          type: 'dispute_default_refund_applied',
          jobId,
          recipientUserId: recipient.userId,
          recipientRole: recipient.role,
          // Thread the refunded held-remainder amount (MINOR units) so the
          // template states the partial cut dynamically — never silent on the
          // split, never hardcoding 75/25.
          context: jobTitle
            ? { jobTitle, refundAmountMinor }
            : { refundAmountMinor },
        })
      } catch (err: unknown) {
        logWarning('dispute_default.notify_dispatch_failed', {
          disputeId,
          jobId,
          role: recipient.role,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err: unknown) {
    // Final guard: a notification failure must NEVER escape into the per-dispute
    // handler (which would wrongly count it as failed and re-process a default
    // whose money already moved correctly).
    logWarning('dispute_default.notify_failed', {
      disputeId,
      jobId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// In-app timeline signal (best-effort) — surface the default in the timeline
// ---------------------------------------------------------------------------

/**
 * Surfaces the T+80 provisional partial-default as an in-app timeline event,
 * mirroring the SERVER signal-write pattern of api/stripe-webhook.ts (a
 * timeline_signals row with a deterministic id + upsert onConflict id). The cron
 * already holds a getSupabaseAdmin (service-role) client, so this write bypasses
 * RLS; BOTH parties read the row via their existing per-job select policies +
 * realtime. The dedicated `dispute_default_refund_applied` type carries the
 * provisional / right-of-recourse copy instead of the misleading
 * full-refund/case-closed copy of the operator `dispute_resolved_refund` type.
 *
 * STRICTLY best-effort, exactly like notifyDefaultApplied: every failure path is
 * swallowed + logged as a warning and this function NEVER throws, so a transient
 * timeline-write failure cannot flip the dispute back, count it as failed, or
 * abort the batch (the money already moved).
 *
 * IDEMPOTENT, appears exactly once (not per cron tick): the deterministic
 * primary-key id `timeline_dispute_default__<disputeId>` (one per dispute) plus
 * upsert onConflict id with ignoreDuplicates:true makes every re-drive a no-op
 * after the first write — the daily 1b retry never rewrites occurred_at or
 * reshuffles timeline ordering. The realtime client handler also self-dedups by
 * signal id.
 *
 * The type is intentionally ABSENT from NOTIFICATION_EVENT_CONFIG, so the TS
 * notification bridge keeps isNotifiableEventType false → no notification_signals
 * row, no push — the email (notifyDefaultApplied) stays the single awareness
 * channel and is never duplicated.
 */
async function emitDefaultTimelineSignal(
  supabase: SupabaseClient,
  disputeId: string,
  jobId: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('timeline_signals').upsert(
      {
        id: `timeline_dispute_default__${disputeId}`,
        job_id: jobId,
        type: 'dispute_default_refund_applied',
        occurred_at: Date.now(),
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    if (error) {
      logWarning('dispute_default.timeline_signal_failed', {
        disputeId,
        jobId,
        reason: error.message,
      })
    }
  } catch (err: unknown) {
    // Final guard: a timeline-write failure must NEVER escape into the
    // per-dispute handler (same contract as notifyDefaultApplied).
    logWarning('dispute_default.timeline_signal_failed', {
      disputeId,
      jobId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

export async function runDisputeDefaultCut(
  supabase: SupabaseClient,
  stripe: Stripe,
): Promise<DisputeDefaultCutSummary> {
  const summary: DisputeDefaultCutSummary = {
    checked: 0,
    defaulted: 0,
    skippedNotEligible: 0,
    skippedNotOurs: 0,
    alreadySettled: 0,
    anchorMissing: 0,
    failed: 0,
  }

  // Read once per run (not a module-level const) so the value reflects the live
  // env at invocation. Handed to the shared refund service, which additionally
  // gates on the PI actually being a destination charge.
  const destinationChargeEnabled = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'

  // ── 1a. Query stalled, still-undecided disputes (the normal entry path) ───
  // decision IS NULL        → operator/consensus has NOT decided
  // status IN (open-family) → not terminal
  // default_applied_at NULL → the default has not already fired (idempotency)
  // order by opened_at asc  → oldest first (index-friendly, fairness)
  const { data: disputes, error: fetchError } = await supabase
    .from('disputes')
    .select('id, job_id')
    .is('decision', null)
    .in('status', ELIGIBLE_DISPUTE_STATUSES)
    .is('default_applied_at', null)
    .order('opened_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (fetchError) {
    logError('dispute_default.fetch_failed', fetchError)
    throw new Error(`Failed to query stalled disputes: ${fetchError.message}`)
  }

  // ── 1b. Query in-progress AUTO-defaults to RETRY (findings 2 & 3) ─────────
  // apply_dispute_default_refund commits its own transaction flipping
  // decision='refund', status='resolved', default_applied_at=now() BEFORE the
  // refund + settle run below. A dispute whose refund/settle FAILED after that
  // commit is permanently excluded by query 1a, so it would strand the owed
  // refund / leave settlement drift forever (no other reconciler settles
  // disputed payments). Re-select those rows here and drive them to completion
  // idempotently. `default_applied_at IS NOT NULL` is essential: it scopes this
  // to the T+80 AUTO-default and never picks up an operator refund (also
  // resolved/refund/pending) that is owned by a different settlement path.
  // default_applied_at is also selected here so the stuck-escalation check
  // (item 4) can age the in-progress default without a new column.
  const { data: inProgress, error: retryFetchError } = await supabase
    .from('disputes')
    .select('id, job_id, default_applied_at')
    .eq('status', 'resolved')
    .eq('decision', 'refund')
    .eq('settlement_status', 'pending')
    .not('default_applied_at', 'is', null)
    .order('opened_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (retryFetchError) {
    logError('dispute_default.retry_fetch_failed', retryFetchError)
    throw new Error(`Failed to query in-progress default disputes: ${retryFetchError.message}`)
  }

  // Merge 1a + 1b, dedupe by id. The two sets are mutually exclusive on
  // status/decision, but dedupe defensively against any race between the queries.
  const seen = new Set<string>()
  const queue: DisputeRow[] = []
  for (const row of [...(disputes ?? []), ...(inProgress ?? [])] as DisputeRow[]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    queue.push(row)
  }

  if (queue.length === 0) {
    logInfo('dispute_default.none_pending', { checked: 0 })
    return summary
  }

  // Resolve owning plan once per job_id. funded_at = the T+80 clock anchor.
  const planCache = new Map<string, { fundedAt: string | null } | null>()
  const resolvePlan = async (
    jobId: string,
  ): Promise<{ fundedAt: string | null } | null> => {
    const cached = planCache.get(jobId)
    if (cached !== undefined) return cached
    const { data: plan, error } = await supabase
      .from('escrow_payment_plans')
      .select('id, job_id, funded_at')
      .eq('job_id', jobId)
      .maybeSingle()
    if (error) {
      // A real DB error is a transient failure, not an absent anchor — surface
      // it as a per-dispute failure (re-attempted next tick) rather than
      // silently classifying it as a skip.
      throw new Error(`plan lookup failed for job ${jobId}: ${error.message}`)
    }
    const resolved = plan ? { fundedAt: (plan.funded_at as string | null) ?? null } : null
    planCache.set(jobId, resolved)
    return resolved
  }

  const now = Date.now()

  for (const raw of queue) {
    const disputeId = raw.id
    const jobId = raw.job_id

    summary.checked++

    try {
      // ── STUCK ESCALATION (item 4) ────────────────────────────────────────
      // Runs BEFORE eligibility/anchor checks so a genuinely-stuck in-progress
      // default always alerts, regardless of anchor state. Only 1b rows carry
      // default_applied_at (1a rows have it NULL by query filter), so this fires
      // exclusively for in-progress AUTO-defaults that have not completed. The
      // dispute is STILL re-driven below (idempotent) — the alert is additive.
      const appliedAtIso = raw.default_applied_at ?? null
      if (appliedAtIso) {
        const appliedMs = Date.parse(appliedAtIso)
        if (Number.isFinite(appliedMs) && now - appliedMs >= STUCK_AFTER_MS) {
          logError('dispute_default.stuck', undefined, {
            disputeId,
            jobId,
            ageDays: (now - appliedMs) / MS_PER_DAY,
            severity: 'dispute_default_in_progress_stuck',
          })
        }
      }

      // ── a. Resolve the T+80 anchor + check eligibility ───────────────────
      const plan = await resolvePlan(jobId)
      const fundedAt = plan?.fundedAt ?? null
      const fundedMs = fundedAt ? Date.parse(fundedAt) : NaN
      if (!fundedAt || !Number.isFinite(fundedMs)) {
        logWarning('dispute_default.deadline_anchor_missing', { disputeId, jobId })
        summary.anchorMissing++
        continue
      }
      const ageDays = (now - fundedMs) / MS_PER_DAY
      if (ageDays < DEADLINE_DEFAULT_DAYS) {
        // Not yet at T+80 — leave untouched for a future tick.
        summary.skippedNotEligible++
        continue
      }

      // ── b. Apply the AGB default (idempotent RPC) ────────────────────────
      // For a 1a dispute this performs the flip; for a 1b in-progress default it
      // returns the same pending row unchanged (gate already failed) → proceed.
      const { data: applyData, error: applyError } = await supabase.rpc(
        'apply_dispute_default_refund',
        { p_dispute_id: disputeId },
      )
      if (applyError) {
        throw new Error(`apply_dispute_default_refund failed: ${applyError.message}`)
      }

      const row = (applyData ?? null) as DefaultRefundRow | null
      const proceed =
        row !== null &&
        row.decision === 'refund' &&
        row.resolution_type === 'refund_partial' &&
        row.default_applied_at != null &&
        row.settlement_status === 'pending'

      if (!proceed) {
        if (row !== null && row.settlement_status === 'settled') {
          // A prior tick already applied + settled this default. Nothing to do.
          logInfo('dispute_default.already_settled', { disputeId, jobId })
          summary.alreadySettled++
        } else {
          // The RPC's idempotency gate returned the row unchanged because
          // operator/consensus decided first (decision != refund, or a
          // non-default resolution). Never refund — operator/consensus wins.
          logWarning('dispute_default.skipped_not_ours', {
            disputeId,
            jobId,
            decision: row?.decision ?? null,
            settlementStatus: row?.settlement_status ?? null,
          })
          summary.skippedNotOurs++
        }
        continue
      }

      // ── HELD-ZERO short-circuit (fully-released escrow) ──────────────────
      // apply_dispute_default_refund stamped the held-remainder snapshot
      // (default_refund_minor, EUR cents). When the escrow was ALREADY fully
      // released before T+80 (every tranche released/paid-out → the shared held
      // predicate sums to 0) there is NOTHING left in escrow to return. A
      // zero-amount Stripe refund is REJECTED by Stripe ("amount must be greater
      // than 0"): passing amount:0 would throw → failed++ → strand the dispute in
      // an endless 1b retry that eventually trips dispute_default.stuck. So skip
      // the money move entirely (no PaymentIntent is needed — nothing moves) and
      // settle directly; the dispute still converges idempotently.
      const heldMinor = Number(row?.default_refund_minor ?? 0)
      if (heldMinor === 0) {
        const { error: settleZeroError } = await supabase.rpc('settle_dispute_default', {
          p_dispute_id: disputeId,
        })
        if (settleZeroError) {
          throw new Error(`settle_dispute_default failed: ${settleZeroError.message}`)
        }
        logInfo('dispute_default.defaulted', {
          disputeId,
          jobId,
          mode: 'no_held_remainder',
          ageDays,
        })
        summary.defaulted++
        // Best-effort in-app timeline signal + party notification (both never
        // throw — see emitDefaultTimelineSignal / notifyDefaultApplied).
        await emitDefaultTimelineSignal(supabase, disputeId, jobId)
        await notifyDefaultApplied(supabase, disputeId, jobId, heldMinor)
        continue
      }

      // ── c. Resolve the Stripe PaymentIntent (payments.provider_ref) ──────
      const { data: paymentRow, error: paymentError } = await supabase
        .from('payments')
        .select('provider_ref')
        .eq('job_id', jobId)
        .limit(1)
        .maybeSingle()
      if (paymentError) {
        throw new Error(`payment lookup failed for job ${jobId}: ${paymentError.message}`)
      }
      const payment = paymentRow as { provider_ref: string | null } | null
      const providerRef =
        typeof payment?.provider_ref === 'string' ? payment.provider_ref.trim() : ''
      if (providerRef === '') {
        // The dispute is resolved/refund/pending but no PaymentIntent is
        // resolvable yet, so the refund is owed but cannot be issued. settle is
        // NOT called, so no money is wrongly considered moved. The in-progress
        // retry query (1b) re-selects this dispute on the next tick, so the
        // refund is retried until a PI resolves (and the stuck check above
        // alerts once it has been pending past STUCK_AFTER_MS).
        logWarning('dispute_default.payment_intent_missing', { disputeId, jobId })
        summary.failed++
        continue
      }

      // ── d. Execute the 75/25 PARTIAL refund of the held remainder (shared
      //       mechanic) ─────────────────────────────────────────────────────
      // amount = the held-remainder snapshot stamped by apply_dispute_default_refund
      // (default_refund_minor, EUR cents) converted back to MAJOR units. It is
      // deterministic across retries because the apply RPC re-returns the SAME
      // already-stamped snapshot (G1) — the worker never recomputes the held set.
      // The service adds reverse_transfer + refund_application_fee only when
      // destinationChargeEnabled AND the PI is a real destination charge (dormant
      // flag-OFF). refundApplicationFee:true makes the platform fee follow the
      // refunded money even though this is a PARTIAL refund. A STABLE per-dispute
      // idempotencySuffix pins the key to `refund_<pi>_default_<disputeId>` (NOT
      // amount-derived), so a next-tick retry re-uses the cached Stripe refund (G1).
      // heldMinor was resolved above (always > 0 here — the held-zero case
      // short-circuited straight to settle without ever touching Stripe).
      const intent = await stripe.paymentIntents.retrieve(providerRef)
      const outcome = await executeEscrowRefundForIntent(stripe, intent, {
        amount: heldMinor / MINOR_UNITS_PER_EUR,
        disputeId,
        destinationChargeEnabled,
        refundApplicationFee: true,
        idempotencySuffix: `default_${disputeId}`,
      })
      if (outcome.ok === false) {
        // Structured refund failure (e.g. MAX guard). settle is NOT called, so
        // the dispute stays resolved/refund/settlement_status=pending and is
        // re-selected by the in-progress retry query (1b) on the next tick,
        // where the Stripe idempotency key makes the re-attempt safe.
        logWarning('dispute_default.refund_failed', {
          disputeId,
          jobId,
          paymentIntentId: providerRef,
          httpStatus: outcome.httpStatus,
        })
        summary.failed++
        continue
      }

      // ── e. Settle (idempotent RPC) ───────────────────────────────────────
      // Flips settlement_status pending→settled, marks ONLY the still-HELD
      // tranches 'refunded', and writes the refund_partial ledger row over the
      // held snapshot. It does NOT mark the plan 'refunded' and does NOT touch
      // payments/jobs/project (Option B / G6=B) — the released 25% stays with the
      // craftsman. Idempotent: already-settled rows return unchanged.
      const { error: settleError } = await supabase.rpc('settle_dispute_default', {
        p_dispute_id: disputeId,
      })
      if (settleError) {
        // The Stripe refund already succeeded but settle failed; its transaction
        // rolled back, so settlement_status is still 'pending'. The in-progress
        // retry query (1b) re-selects this dispute next tick → re-apply (returns
        // the same pending row) → re-refund (Stripe idempotency key, a no-op) →
        // re-settle, idempotently driving it to completion.
        throw new Error(`settle_dispute_default failed: ${settleError.message}`)
      }

      logInfo('dispute_default.defaulted', {
        disputeId,
        jobId,
        paymentIntentId: providerRef,
        mode: outcome.mode,
        ageDays,
      })
      summary.defaulted++

      // ── f. Surface in-app + notify BOTH parties (best-effort, never throw) ─
      // The default is fully settled and the money has moved. The in-app
      // timeline signal and the email are purely awareness channels — both
      // emitDefaultTimelineSignal and notifyDefaultApplied swallow every failure,
      // so neither can flip the dispute back, count as failed, or abort the batch.
      await emitDefaultTimelineSignal(supabase, disputeId, jobId)
      await notifyDefaultApplied(supabase, disputeId, jobId, heldMinor)
    } catch (err) {
      // One dispute error must not abort the batch (mirror _payoutCorridorReconciliation).
      logError('dispute_default.dispute_error', err instanceof Error ? err : undefined, {
        disputeId,
        jobId,
      })
      summary.failed++
    }
  }

  return summary
}
