import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { secureCompare } from './_secureCompare.js'
import { authenticateRequest } from './_auth.js'
import { fetchIsOperator } from './_paymentAuth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logError, logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { toSmallestUnit } from './_shared.js'
import { assertAttributionFinalized, attributionGateToHttpResponse } from './_attributionGuard.js'
import { requireProEntitlement } from './_subscriptionAuth.js'

/**
 * Server-side tranche release endpoint.
 *
 * This is the authoritative path for executing tranche releases. It:
 *   1. Validates the tranche is eligible for release.
 *   2. Resolves the provider's Stripe Connect account and checks payout readiness.
 *   3. Creates a Stripe Transfer (Separate Charges and Transfers model) from the
 *      captured funding charge to the provider's Connect account.
 *   4. Transitions the escrow tranche to 'released', storing the Transfer ID
 *      as external_release_ref (proof of real fund movement).
 *   5. Updates the plan status rollup (partially_released / fully_released).
 *
 * Stripe model: Separate Charges and Transfers.
 *   - The funding PaymentIntent was captured on the SaFix platform account.
 *   - Per-tranche Transfers route net funds (gross × (1 − platformFeeRate)) to
 *     the provider's Express Connect account. The platform fee rate is per
 *     customer↔provider relationship and is resolved via _feeRate.ts:
 *       merchant_brought  → 5 % platform fee → 95 % net to provider
 *       platform_acquired → 9 % platform fee → 91 % net to provider
 *     The rate is locked at funding time on escrow_payment_plans.platform_fee_rate
 *     and re-used here so application_fee_amount and the Transfer agree.
 *   - source_transaction = the Stripe charge from the captured PI guarantees
 *     transfers draw from that specific charge (no double-spend).
 *
 * Authorization — dual auth (either path accepted):
 *   1. RELEASE_CONFIRM_SECRET header — server-to-server calls
 *   2. Supabase JWT in Authorization header — authenticated client calls
 *
 * Idempotent: if the tranche is already released, returns 200 with the
 * current state. No duplicate side effects.
 *
 * Transfer idempotency: Stripe idempotency key `tranche_release_<trancheId>`
 * prevents duplicate transfers even on concurrent or retry calls.
 *
 * DB write only AFTER Transfer success: if the Stripe transfer fails, the
 * tranche remains in its current status and the caller can retry safely.
 *
 * P3 corridor flag — FUNDING_DESTINATION_CHARGE_ENABLED === 'true':
 *   OFF (default): everything above is byte-identical (transfer release).
 *   ON: release issues a payout on the provider's connected account instead of
 *   a transfer — the P2 destination charge already routed net funds there, so
 *   the payout amount is the SAME net figure (fee taken once, at funding). On
 *   success the tranche goes to 'release_pending'; the payout.paid webhook then
 *   marks it 'released'. balance_insufficient (destination-charge funds stay
 *   ~7 days pending) is a soft 202 'release_deferred', not a 502 — the P3b
 *   retry cron completes it later.
 */

import { resolveCommercialFeeRate } from './_feeRate.js'

/**
 * Safe default fee rate — applied when escrow_payment_plans.platform_fee_rate
 * is NULL (legacy plans created before fee-rate persistence was added).
 * Uses the conservative platform_acquired rate (9 %) from _feeRate.ts.
 */
const SAFE_DEFAULT_FEE_RATE = 0.09

/**
 * Deposit-release split percent of the fixed 2-tranche escrow corridor.
 * Mirrors src/lib/payments/escrow/escrowService.ts and api/request-funding.ts:50
 * (calculateTrancheAmounts). Locally duplicated — the api/ tsconfig project
 * boundary forbids importing from src/lib (matching the existing duplication in
 * request-funding.ts). Used ONLY by the PAYOUT_MODE rounding true-up below to
 * recompute the deposit gross deterministically so the final tranche can draw
 * the residual.
 */
const DEPOSIT_RELEASE_PERCENT = 25

// ── Stripe singleton ──────────────────────────────────────────────────────────
let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  // Dual auth: accept either server secret OR authenticated Supabase session.
  // When JWT-authenticated, the userId is stored for ownership verification
  // after the escrow plan is loaded (see authorization gate below).
  const serverSecret = process.env.RELEASE_CONFIRM_SECRET
  const providedSecret = req.headers['x-release-confirm-secret']
  const hasServerSecret =
    !!serverSecret &&
    typeof providedSecret === 'string' &&
    secureCompare(providedSecret, serverSecret)

  let authUserId: string | null = null

  if (!hasServerSecret) {
    const auth = await authenticateRequest(req)
    if (auth.ok === false) {
      res.status(auth.statusCode).json({ error: auth.error })
      return
    }
    if (await applyRateLimit(res, 'critical', auth.userId)) return
    authUserId = auth.userId
  }

  const { trancheId, planId, externalReleaseRef, actor, splitRatio } = req.body as {
    trancheId: unknown
    planId: unknown
    externalReleaseRef: unknown
    actor: unknown
    splitRatio: unknown
  }

  if (!trancheId || typeof trancheId !== 'string') {
    res.status(400).json({ error: 'trancheId is required.' })
    return
  }

  if (!planId || typeof planId !== 'string') {
    res.status(400).json({ error: 'planId is required.' })
    return
  }

  // 'consensus' is accepted at the API boundary so the app-level audit trail
  // (releaseActor, logged in api.release_tranche.success) records the two-party
  // consensus-split origin instead of silently degrading to 'system'. It is
  // DOWNGRADED to 'system' before the DB write — see dbReleaseActor below.
  const VALID_ACTORS = new Set(['customer', 'provider', 'operator', 'system', 'consensus'])
  const requestedReleaseActor =
    typeof actor === 'string' && VALID_ACTORS.has(actor) ? actor : 'system'
  // A server-secret call is an internal, trusted caller and may retain the
  // workflow-provided actor (for example `system` or `consensus`). A JWT caller
  // must never be able to forge the audit actor through the request body; its
  // actor is derived from the verified plan relationship below.
  let releaseActor = hasServerSecret ? requestedReleaseActor : 'system'

  // Optional: splitRatio for dispute split resolution. A genuine split is
  // STRICTLY inside (0,1): 0 % belongs on the refund path, 100 % on the plain
  // release path (omit splitRatio). If a caller EXPLICITLY provides a value
  // outside (0,1), reject with 400 instead of silently coercing it to a full
  // provider release — that silent coercion, paired with service.ts's full
  // (1 − ratio) customer refund, double-paid the tranche at ratio=0 (provider
  // released in full AND customer refunded in full). An ABSENT splitRatio still
  // means a normal full release (unchanged). Mirrors the (0,1) bound now enforced
  // at the source by operator_resolve_dispute_split + the consensus proposal RPC.
  const splitRatioProvided = splitRatio !== undefined && splitRatio !== null
  if (
    splitRatioProvided &&
    !(typeof splitRatio === 'number' && Number.isFinite(splitRatio) && splitRatio > 0 && splitRatio < 1)
  ) {
    logWarning('api.release_tranche.invalid_split_ratio', {
      trancheId,
      planId,
      splitRatio: typeof splitRatio === 'number' ? splitRatio : String(splitRatio),
    })
    res.status(400).json({
      error: 'Ungültige Split-Quote: muss echt zwischen 0 und 1 liegen (0 % = Rückerstattung, 100 % = Freigabe).',
      code: 'INVALID_SPLIT_RATIO',
    })
    return
  }
  const parsedSplitRatio = splitRatioProvided ? (splitRatio as number) : undefined

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.release_tranche.admin_unavailable', undefined, {
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  const supabase = adminResult.client

  // ── Stripe secret key — required for transfer ──────────────────────────────
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.release_tranche.stripe_key_missing', undefined, { trancheId, planId })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  // ── Corridor mode flag (P2 funding + P3 release flip together) ─────────────
  // Default OFF (env unset / anything but 'true') = legacy Separate Charges and
  // Transfers release — byte-identical to pre-P3 behaviour. ON = destination-
  // charge corridor: the tranche is released via a payout on the provider's
  // connected account (P2 routed net funds there at funding). Same env name +
  // `=== 'true'` test as the P2 funding path, so one flag flips the whole
  // corridor. Read once here because the early idempotent-return and
  // recovery-path detection below already branch on it.
  const PAYOUT_MODE = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'

  try {
    // ── Fetch current tranche state ─────────────────────────────────────────
    const { data: tranche, error: fetchError } = await supabase
      .from('escrow_tranches')
      .select('id, plan_id, kind, status, release_trigger, released_at, external_release_ref, external_payout_ref, amount, payout_attempt_count')
      .eq('id', trancheId.trim())
      .eq('plan_id', planId.trim())
      .maybeSingle()

    if (fetchError) {
      logError('api.release_tranche.fetch_failed', fetchError, { trancheId })
      res.status(500).json({ error: 'Failed to fetch tranche.' })
      return
    }

    if (!tranche) {
      res.status(404).json({ error: 'Tranche not found.' })
      return
    }

    // ── Idempotent: already released ────────────────────────────────────────
    // When status='released' AND external_release_ref is set, the Stripe
    // Transfer already executed — return 200 idempotent without side effects.
    //
    // When status='released' but external_release_ref is null, a prior DB
    // write failed after a successful Transfer (split-brain). Fall through to
    // the healing path: re-issue the Stripe transfer with the same idempotency
    // key — Stripe returns the existing transfer without duplication — then
    // persist the Transfer ID. This closes the dead-end deterministically.
    if (tranche.status === 'released') {
      // PAYOUT_MODE: a payout-corridor released tranche carries its proof in
      // external_payout_ref (po_*) and has external_release_ref NULL. Short-
      // circuit idempotent here so it never falls into the transfer healing
      // path below (which would re-issue a Stripe Transfer).
      if (PAYOUT_MODE && tranche.external_payout_ref) {
        logInfo('api.release_tranche.idempotent_skip', {
          trancheId: tranche.id,
          planId,
        })
        res.status(200).json({
          status: 'released',
          trancheId: tranche.id,
          planId,
          releasedAt: tranche.released_at,
          externalPayoutRef: tranche.external_payout_ref,
          idempotent: true,
        })
        return
      }

      if (tranche.external_release_ref) {
        logInfo('api.release_tranche.idempotent_skip', {
          trancheId: tranche.id,
          planId,
        })
        res.status(200).json({
          status: 'released',
          trancheId: tranche.id,
          planId,
          releasedAt: tranche.released_at,
          externalReleaseRef: tranche.external_release_ref,
          idempotent: true,
        })
        return
      }

      // Transfer proof missing — fall through to healing path.
      logWarning('api.release_tranche.healing_inconsistent_release', {
        trancheId: tranche.id,
        planId,
        note: 'released_without_transfer_ref_attempting_recovery',
      })
    }

    // True when a prior DB write failed after a successful Stripe Transfer:
    // status='released' but external_release_ref is null. The healing path
    // skips eligibility and dispute guards (transfer already happened on Stripe
    // side) and re-issues the transfer with the same idempotency key.
    //
    // PAYOUT_MODE guard: a payout-corridor released tranche ALSO has
    // external_release_ref null (its proof lives in external_payout_ref), so
    // without this guard it would falsely enter the transfer recovery re-issue.
    // Such a row is normally already caught by the idempotent return above; this
    // is a defensive belt-and-braces gate.
    // TODO(P3b): payout-model split-brain recovery (release_pending with a lost
    // external_payout_ref), the hourly payout-reconciliation cron rework, and
    // the T+80/90-day release deadline guard are out of scope here.
    const isRecoveryPath =
      tranche.status === 'released'
      && !tranche.external_release_ref
      && !(PAYOUT_MODE && tranche.external_payout_ref)

    // ── Fetch escrow plan (moved up for stale reconciliation + all downstream) ──
    const { data: plan, error: planFetchError } = await supabase
      .from('escrow_payment_plans')
      .select('job_id, provider_id, customer_user_id, external_funding_ref, currency, platform_fee_rate, commercial_origin, total_amount')
      .eq('id', planId.trim())
      .maybeSingle()

    if (planFetchError) {
      logError('api.release_tranche.plan_fetch_failed', planFetchError, { trancheId, planId })
      res.status(500).json({ error: 'Failed to fetch escrow plan.' })
      return
    }

    if (!plan) {
      res.status(404).json({ error: 'Escrow plan not found.' })
      return
    }

    // ── Pro entitlement gate (user-authenticated calls only) ──────────────
    // Server-secret calls (automated releases) bypass this check.
    // release_tranche is in the AWE allow-list: an expired provider who has an
    // active escrow can still receive their payment. Pass job_id for AWE check.
    if (authUserId && plan.provider_id) {
      const { data: provRow } = await supabase
        .from('providers')
        .select('profile_id')
        .eq('id', plan.provider_id)
        .maybeSingle()
      if (provRow?.profile_id) {
        const proResult = await requireProEntitlement(
          supabase,
          provRow.profile_id,
          'release_tranche',
          plan.job_id ? String(plan.job_id) : undefined,
        )
        if (proResult.ok === false) {
          res.status(proResult.status).json({ error: proResult.reason })
          return
        }
      }
    }

    // ── Server-side stale tranche reconciliation ───────────────────────────────
    // Client-side projection treats 'funded' tranches as eligible when their
    // release trigger is satisfied (job has advanced past the trigger point).
    // The server must honor the same truth. When a tranche is 'funded' but its
    // trigger condition is met, atomically transition it to 'eligible_for_release'
    // before evaluating the release guard. This closes the split-brain between
    // client projection and server hard-gate that occurs after partial workflow
    // failures (e.g. job moved to in_progress but recordWorkStarted didn't fire).
    if (tranche.status === 'funded' && tranche.release_trigger && plan.job_id) {
      const { data: jobRow } = await supabase
        .from('jobs')
        .select('status')
        .eq('id', plan.job_id)
        .maybeSingle()

      const WORK_STARTED_SATISFIED = new Set(['in_progress', 'waiting_payment', 'completed'])
      const WORK_COMPLETED_SATISFIED = new Set(['waiting_payment', 'completed'])

      const triggerSatisfied =
        (tranche.kind === 'deposit_release'
          && tranche.release_trigger === 'work_started'
          && WORK_STARTED_SATISFIED.has(jobRow?.status ?? ''))
        || (tranche.kind === 'final_release'
          && tranche.release_trigger === 'work_completed'
          && WORK_COMPLETED_SATISFIED.has(jobRow?.status ?? ''))

      if (triggerSatisfied) {
        const reconcileNow = new Date().toISOString()
        const { error: reconcileErr } = await supabase
          .from('escrow_tranches')
          .update({
            status: 'eligible_for_release',
            eligible_at: reconcileNow,
            triggered_by: 'system',
            updated_at: reconcileNow,
          })
          .eq('id', trancheId.trim())
          .eq('status', 'funded') // Optimistic lock: only if still funded

        if (!reconcileErr) {
          tranche.status = 'eligible_for_release'
          logInfo('api.release_tranche.stale_reconciled', {
            trancheId,
            planId,
            trancheKind: tranche.kind,
            releaseTrigger: tranche.release_trigger,
            jobStatus: jobRow?.status,
          })
        } else {
          logWarning('api.release_tranche.stale_reconcile_failed', {
            trancheId,
            planId,
            error: reconcileErr.message,
          })
        }
      }
    }

    // ── Guard: must be eligible_for_release or release_pending ──────────────
    // Recovery path skips this guard — tranche.status is already 'released'
    // and the goal is to persist the missing external_release_ref, not to
    // re-validate eligibility.
    if (!isRecoveryPath && tranche.status !== 'eligible_for_release' && tranche.status !== 'release_pending') {
      logWarning('api.release_tranche.invalid_status', {
        trancheId: tranche.id,
        currentStatus: tranche.status,
      })

      // Map to fachliche German user message — no raw technical errors
      const userMessage = tranche.status === 'funded'
        ? 'Diese Tranche ist noch nicht freigabefähig. Die Voraussetzung (Arbeitsbeginn oder Fertigstellung) ist noch nicht erfüllt.'
        : tranche.status === 'pending_funding'
          ? 'Diese Tranche kann nicht freigegeben werden, da die Kundeneinzahlung noch aussteht.'
          : tranche.status === 'disputed'
            ? 'Diese Tranche kann nicht freigegeben werden, da ein Streitfall aktiv ist.'
            : tranche.status === 'cancelled' || tranche.status === 'refunded'
              ? 'Diese Tranche wurde bereits storniert oder erstattet.'
              : `Freigabe nicht möglich (Status: ${tranche.status}).`

      res.status(409).json({
        error: userMessage,
        currentStatus: tranche.status,
      })
      return
    }

    // ── Resolve provider's auth user ID (profile_id) ─────────────────────────
    // escrow_payment_plans.provider_id is a FK to providers.id (DB table PK),
    // NOT auth.users.id. We must resolve providers.profile_id to compare
    // against the JWT caller's auth UID for authorization.
    const { data: providerRow, error: providerFetchError } = await supabase
      .from('providers')
      .select('profile_id')
      .eq('id', plan.provider_id)
      .maybeSingle()

    if (providerFetchError || !providerRow?.profile_id) {
      logError('api.release_tranche.provider_lookup_failed', providerFetchError ?? undefined, {
        trancheId,
        planId,
        providerId: plan.provider_id,
        reason: providerFetchError ? 'db_error' : 'no_profile_id',
      })
      res.status(500).json({ error: 'Failed to resolve provider profile.' })
      return
    }

    const providerProfileId = providerRow.profile_id

    // ── Authorization: JWT-authenticated callers must own the escrow plan ───────
    // Server-secret calls (hasServerSecret) are trusted and skip this check.
    // JWT callers must be the customer, the provider, or an operator.
    // The provider (craftsman) is allowed because the release CTA lives on their
    // operations screen, and the actual money-movement is already guarded by
    // tranche eligibility, dispute checks, and Stripe Connect readiness.
    if (authUserId) {
      const isCustomer = plan.customer_user_id === authUserId
      const isProvider = providerProfileId === authUserId
      if (isCustomer) {
        releaseActor = 'customer'
      } else if (isProvider) {
        releaseActor = 'provider'
      } else {
        const isOperator = await fetchIsOperator(authUserId, supabase)
        if (!isOperator) {
          logWarning('api.release_tranche.authorization_failed', {
            trancheId,
            planId,
            userId: authUserId,
            customerUserId: plan.customer_user_id,
            providerId: plan.provider_id,
            providerProfileId,
            reason: 'caller_is_not_customer_provider_or_operator',
          })
          res.status(403).json({ error: 'Forbidden: you are not authorized to release this tranche.' })
          return
        }
        releaseActor = 'operator'
      }
    }

    // ── Guard: active dispute blocks release ────────────────────────────────────
    // Any dispute in an active lifecycle state (open, under_review,
    // customer_waiting, provider_waiting) prevents release — server-authoritative,
    // cannot be bypassed by client state. Additionally, a resolved dispute with
    // decision='refund' blocks release: the refund money leg may still be pending
    // or done — releasing to the provider would be a second, conflicting money
    // movement (C5). A resolved dispute with decision='split' does NOT block —
    // the split's release leg runs through this very endpoint — but it PINS the
    // split ratio: the caller-supplied splitRatio must EXACTLY equal the
    // server-persisted disputes.split_ratio (C2, see below). Recovery path skips
    // this check: the Stripe Transfer already executed and we are only persisting
    // the missing ref — blocking a done transfer is futile.
    if (!isRecoveryPath && parsedSplitRatio !== undefined && !plan.job_id) {
      // A split is a dispute-settlement money leg. Without the job relation we
      // cannot load and prove that settlement, so never let a request-scoped
      // ratio alter a real Stripe transfer.
      logError('api.release_tranche.split_without_job', undefined, { trancheId, planId })
      res.status(409).json({
        error: 'DISPUTE_SPLIT_NOT_AUTHORIZED',
        message: 'Cannot release a split tranche without a linked dispute settlement.',
      })
      return
    }

    if (!isRecoveryPath && plan.job_id) {
      const { data: matchedDispute, error: disputeFetchError } = await supabase
        .from('disputes')
        .select('id, status, decision, split_ratio, settlement_status')
        .eq('job_id', plan.job_id)
        .or('status.in.(open,under_review,customer_waiting,provider_waiting),and(status.eq.resolved,decision.in.(refund,split))')
        .maybeSingle()

      if (disputeFetchError) {
        logError('api.release_tranche.dispute_fetch_failed', disputeFetchError, {
          trancheId,
          planId,
          jobId: plan.job_id,
        })
        res.status(500).json({ error: 'Failed to verify dispute state. Release blocked for safety.' })
        return
      }

      const isResolvedSplit =
        matchedDispute?.status === 'resolved' && matchedDispute.decision === 'split'

      if (matchedDispute && !isResolvedSplit) {
        logWarning('api.release_tranche.dispute_blocking', {
          trancheId,
          planId,
          jobId: plan.job_id,
          disputeId: matchedDispute.id,
          disputeStatus: matchedDispute.status,
          disputeDecision: matchedDispute.decision ?? null,
        })
        res.status(409).json({
          error: 'DISPUTE_BLOCKING',
          message: `Cannot release tranche: a blocking dispute exists for this job (dispute ${matchedDispute.id}, status '${matchedDispute.status}'${matchedDispute.decision ? `, decision '${matchedDispute.decision}'` : ''}).`,
          disputeId: matchedDispute.id,
          disputeStatus: matchedDispute.status,
          disputeDecision: matchedDispute.decision ?? null,
        })
        return
      }

      // A request-provided split ratio is never authority on its own. It is
      // accepted only as the exact, server-persisted ratio of an unresolved
      // split settlement. Otherwise an otherwise-authorized customer/provider
      // could lower a real payout and still make the entire tranche terminal.
      if (parsedSplitRatio !== undefined && !isResolvedSplit) {
        logWarning('api.release_tranche.dispute_split_not_authorized', {
          trancheId,
          planId,
          jobId: plan.job_id,
          requestedSplitRatio: parsedSplitRatio,
        })
        res.status(409).json({
          error: 'DISPUTE_SPLIT_NOT_AUTHORIZED',
          message: 'A split release requires a server-resolved split dispute.',
        })
        return
      }

      if (isResolvedSplit && matchedDispute.settlement_status !== 'pending') {
        logWarning('api.release_tranche.dispute_split_not_pending', {
          trancheId,
          planId,
          jobId: plan.job_id,
          disputeId: matchedDispute.id,
          settlementStatus: matchedDispute.settlement_status ?? null,
        })
        res.status(409).json({
          error: 'DISPUTE_SPLIT_NOT_PENDING',
          message: `Cannot release tranche: split dispute ${matchedDispute.id} is no longer pending settlement.`,
          disputeId: matchedDispute.id,
          disputeStatus: matchedDispute.status,
          disputeDecision: matchedDispute.decision ?? null,
        })
        return
      }

      // ── Guard: resolved split dispute pins the split ratio (C2) ─────────────
      // The ratio is server-authoritative. Without this check an authorized
      // caller could post e.g. splitRatio=0.99 against a resolved 0.1 split —
      // the tranche leg here plus the independent customer-refund leg
      // (refund-escrow's evaluateDisputeSplitBypass, which computes the customer
      // share from the SAME disputes.split_ratio) would sum to >100 % of the
      // escrow. An ABSENT splitRatio is equally rejected: it would release the
      // full tranche amount under full-release math. Field handling mirrors
      // evaluateDisputeSplitBypass (numeric column may arrive as string; (0,1)
      // EXCLUSIVE, consistent with disputes_split_ratio_exclusive_chk).
      //
      // Ratio equality is compared at the column's own precision (split_ratio is
      // numeric(5,4) → 4 decimal places). A raw float `!==` would spuriously
      // reject a legit release whenever the client-side ratio (craftsmanPct/100)
      // and the DB round-trip diverge in the ~1e-16 range; rounding both to the
      // stored precision makes the comparison exact without loosening the guard.
      const toRatioUnits = (r: number): number => Math.round(r * 10000)
      if (matchedDispute && isResolvedSplit) {
        const resolvedSplitRatio =
          matchedDispute.split_ratio === null || matchedDispute.split_ratio === undefined
            ? null
            : Number(matchedDispute.split_ratio)

        if (
          resolvedSplitRatio === null ||
          !Number.isFinite(resolvedSplitRatio) ||
          resolvedSplitRatio <= 0 ||
          resolvedSplitRatio >= 1
        ) {
          // Fail-closed: a resolved split without a usable ratio is a data
          // inconsistency — no release math can be validated against it.
          logError('api.release_tranche.dispute_split_ratio_missing', undefined, {
            trancheId,
            planId,
            jobId: plan.job_id,
            disputeId: matchedDispute.id,
            splitRatio: matchedDispute.split_ratio ?? null,
          })
          res.status(409).json({
            error: 'DISPUTE_SPLIT_RATIO_MISSING',
            message: `Cannot release tranche: dispute ${matchedDispute.id} is resolved as 'split' but has no valid split_ratio. Operator reconciliation required.`,
            disputeId: matchedDispute.id,
            disputeStatus: matchedDispute.status,
            disputeDecision: matchedDispute.decision ?? null,
          })
          return
        }

        if (
          parsedSplitRatio === undefined ||
          toRatioUnits(parsedSplitRatio) !== toRatioUnits(resolvedSplitRatio)
        ) {
          logWarning('api.release_tranche.dispute_split_ratio_mismatch', {
            trancheId,
            planId,
            jobId: plan.job_id,
            disputeId: matchedDispute.id,
            requestedSplitRatio: parsedSplitRatio ?? null,
            resolvedSplitRatio,
          })
          res.status(409).json({
            error: 'DISPUTE_SPLIT_RATIO_MISMATCH',
            message:
              parsedSplitRatio === undefined
                ? `Cannot release tranche: dispute ${matchedDispute.id} was resolved as 'split' — splitRatio is required and must equal the resolved ratio.`
                : `Cannot release tranche: splitRatio does not match the resolved ratio of dispute ${matchedDispute.id}.`,
            disputeId: matchedDispute.id,
            disputeStatus: matchedDispute.status,
            disputeDecision: matchedDispute.decision ?? null,
          })
          return
        }
      }
    }

    // ── Attribution gate ─────────────────────────────────────────────────────
    // No Stripe transfer may be issued while the job's commercial attribution
    // is unresolved.  Parity with create-escrow / initiate-supplementary-funding:
    // release MUST verify the same invariant the funding step verified.  Recovery
    // path (transfer already executed on Stripe side) is explicitly exempted —
    // blocking a completed transfer leaves the DB permanently out of sync.
    //
    // Fail-closed: a missing `plan.job_id` is fed into the guard as an empty
    // string and mapped to JOB_NOT_FOUND → 402.  The guard is never skipped
    // while the release is non-recovery.
    if (!isRecoveryPath) {
      const gate = await assertAttributionFinalized(
        supabase,
        (plan.job_id as string | null) ?? '',
        'api.release_tranche',
      )
      if (gate.ok === false) {
        const mapped = attributionGateToHttpResponse(gate)
        res.status(mapped.status).json(mapped.body)
        return
      }
    }
    // ── End attribution gate ─────────────────────────────────────────────────

    // ── Resolve provider's Stripe Connect account ───────────────────────────────
    const { data: payoutAccount, error: payoutFetchError } = await supabase
      .from('provider_payout_accounts')
      .select('stripe_connect_account_id, charges_enabled, payouts_enabled')
      .eq('provider_user_id', providerProfileId)
      .maybeSingle()

    if (payoutFetchError) {
      logError('api.release_tranche.payout_account_fetch_failed', payoutFetchError, {
        trancheId,
        planId,
        providerUserId: providerRow.profile_id,
      })
      res.status(500).json({ error: 'Failed to fetch provider payout account.' })
      return
    }

    // ── Server-side provider readiness gate (fail-closed) ───────────────────────
    // charges_enabled: provider can accept charges
    // payouts_enabled: provider can receive payouts to their bank
    // Both required before transferring real funds.
    if (
      !payoutAccount?.stripe_connect_account_id ||
      !payoutAccount.charges_enabled ||
      !payoutAccount.payouts_enabled
    ) {
      logWarning('api.release_tranche.provider_not_payout_ready', {
        trancheId,
        planId,
        providerUserId: providerRow.profile_id,
        hasAccount: !!payoutAccount?.stripe_connect_account_id,
        chargesEnabled: payoutAccount?.charges_enabled ?? false,
        payoutsEnabled: payoutAccount?.payouts_enabled ?? false,
      })
      res.status(409).json({
        error: 'Provider Stripe Connect account is not ready for payout. Onboarding must be completed.',
        code: 'PROVIDER_NOT_PAYOUT_READY',
      })
      return
    }

    const stripeConnectAccountId = payoutAccount.stripe_connect_account_id

    // ── Verify the escrow plan has a captured funding reference ─────────────────
    const fundingRef = plan.external_funding_ref
    if (!fundingRef) {
      logError('api.release_tranche.missing_funding_ref', undefined, { trancheId, planId })
      res.status(409).json({
        error: 'Escrow plan has no funding reference. Escrow may not be funded yet.',
        code: 'MISSING_FUNDING_REF',
      })
      return
    }

    // ── Resolve Stripe charge from the captured funding PI ──────────────────────
    // The funding PaymentIntent was captured on the platform account via automatic
    // capture when the customer confirmed payment. latest_charge is the charge ID
    // required as source_transaction for Separate Charges and Transfers.
    const stripe = getStripe(secretKey)

    let chargeId: string | null = null
    try {
      const intent = await stripe.paymentIntents.retrieve(fundingRef)
      chargeId = typeof intent.latest_charge === 'string'
        ? intent.latest_charge
        : (intent.latest_charge?.id ?? null)

      if (intent.status !== 'succeeded') {
        logWarning('api.release_tranche.intent_not_succeeded', {
          trancheId,
          planId,
          fundingRef,
          intentStatus: intent.status,
        })
        res.status(409).json({
          error: `Funding PaymentIntent is not in 'succeeded' state (current: '${intent.status}'). Escrow may not be captured.`,
          code: 'INTENT_NOT_CAPTURED',
        })
        return
      }
    } catch (stripeErr: unknown) {
      const detail = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      logError('api.release_tranche.intent_retrieve_failed', stripeErr instanceof Error ? stripeErr : undefined, {
        trancheId,
        planId,
        fundingRef,
      })
      res.status(502).json({ error: `Failed to retrieve funding PaymentIntent: ${detail}` })
      return
    }

    if (!chargeId) {
      logError('api.release_tranche.no_charge_id', undefined, { trancheId, planId, fundingRef })
      res.status(409).json({
        error: 'Funding PaymentIntent has no captured charge.',
        code: 'NO_CAPTURED_CHARGE',
      })
      return
    }

    // ── Resolve per-plan fee rate ─────────────────────────────────────────────
    // Priority: persisted platform_fee_rate on the plan → derive from commercial
    // origin → safe default (9 %). The persisted rate is authoritative because it
    // was locked at funding time and matches the application_fee_amount on the
    // Stripe PaymentIntent.
    let platformFeeRate: number
    if (typeof plan.platform_fee_rate === 'number' && plan.platform_fee_rate > 0) {
      platformFeeRate = plan.platform_fee_rate
    } else if (plan.commercial_origin) {
      const resolved = resolveCommercialFeeRate(plan.commercial_origin as string)
      platformFeeRate = resolved.rate
      if (resolved.wasDefaulted) {
        logWarning('api.release_tranche.fee_rate_defaulted', {
          trancheId,
          planId,
          commercialOrigin: plan.commercial_origin,
        })
      }
    } else {
      platformFeeRate = SAFE_DEFAULT_FEE_RATE
      logWarning('api.release_tranche.fee_rate_fallback', {
        trancheId,
        planId,
        reason: 'no_platform_fee_rate_and_no_commercial_origin',
      })
    }

    // ── Determine effective gross transferred to the provider ───────────────
    // Normal release: effectiveGross = tranche.amount.
    //
    // Dispute split resolution (parsedSplitRatio provided):
    //   splitRatio is the provider share of the total escrow, so
    //     providerTargetGross = plan.total_amount × splitRatio
    //   Already-released tranches (i.e. sibling tranches that have a Stripe
    //   Transfer on record via external_release_ref) count against that target:
    //     alreadyReleasedProviderGross = Σ sibling.amount where external_release_ref set
    //     remainingProviderGrossQuota  = max(0, providerTargetGross − alreadyReleasedProviderGross)
    //   The current tranche's contribution is capped by the remaining quota, so
    //   the provider can never receive more than providerTargetGross in total,
    //   even after a prior tranche was already released under full-release math.
    //   If the prior payouts already exceed the split target, we fail-closed
    //   with a clear reconciliation code rather than silently over-paying.
    //
    // Idempotency key is stable per tranche — retries never create duplicates.
    const trancheGross = Number(tranche.amount)

    let effectiveGross: number
    let splitReservationHeld = false
    if (parsedSplitRatio !== undefined) {
      // Quota allocation must happen before Stripe and must serialize sibling
      // tranches. The RPC locks the plan, counts released/in-flight movements
      // plus durable reservations, and stores this tranche's exact gross share.
      // A same-tranche retry receives the same reservation and then reuses the
      // same Stripe idempotency key.
      const { data: reservationData, error: reservationError } = await supabase.rpc(
        'reserve_split_release_quota',
        {
          p_tranche_id: trancheId.trim(),
          p_plan_id: planId.trim(),
          p_split_ratio: parsedSplitRatio,
        },
      )

      if (reservationError) {
        logError('api.release_tranche.split_reservation_failed', reservationError, {
          trancheId,
          planId,
          splitRatio: parsedSplitRatio,
        })
        res.status(500).json({ error: 'Failed to reserve split release quota.' })
        return
      }

      const reservation = reservationData as Record<string, unknown> | null
      const reservationOutcome = reservation?.outcome
      const reservedGross = Number(reservation?.reserved_gross ?? NaN)

      if (reservationOutcome === 'quota_exhausted') {
        const providerTargetGross = Number(reservation?.provider_target_gross ?? 0)
        const alreadyReleasedProviderGross = Number(reservation?.committed_gross ?? 0)
        logError('api.release_tranche.split_quota_exhausted', undefined, {
          trancheId,
          planId,
          providerTargetGross,
          alreadyReleasedProviderGross,
          splitRatio: parsedSplitRatio,
          severity: 'operator_action_required',
        })
        res.status(409).json({
          error:
            'Split-Freigabe blockiert: Provider hat den Split-Anteil bereits erhalten oder reserviert. Operator-Abgleich erforderlich.',
          code: 'SPLIT_PROVIDER_QUOTA_EXHAUSTED',
          providerTargetGross,
          alreadyReleasedProviderGross,
        })
        return
      }

      if (reservationOutcome === 'plan_total_missing') {
        res.status(409).json({
          error:
            'Split-Freigabe blockiert: Gesamtbetrag des Escrow-Plans ist unbekannt. Operator-Abgleich erforderlich.',
          code: 'SPLIT_PLAN_TOTAL_MISSING',
        })
        return
      }

      if (reservationOutcome !== 'reserved' || !Number.isFinite(reservedGross) || reservedGross <= 0) {
        logWarning('api.release_tranche.split_reservation_rejected', {
          trancheId,
          planId,
          splitRatio: parsedSplitRatio,
          outcome: reservationOutcome ?? 'unknown',
        })
        res.status(409).json({
          error: 'Split release reservation was rejected.',
          code: 'SPLIT_RESERVATION_REJECTED',
          outcome: reservationOutcome ?? 'unknown',
        })
        return
      }

      effectiveGross = Math.min(trancheGross, reservedGross)
      splitReservationHeld = true
      logInfo('api.release_tranche.split_quota_applied', {
        trancheId,
        planId,
        trancheGross,
        effectiveGross,
        providerTargetGross: Number(reservation?.provider_target_gross ?? 0),
        alreadyReleasedProviderGross: Number(reservation?.committed_gross ?? 0),
        idempotentReservation: reservation?.idempotent === true,
        splitRatio: parsedSplitRatio,
      })
    } else {
      effectiveGross = trancheGross
    }

    // gross × (1 − platformFeeRate) == this tranche's share of the NET balance
    // on the connected account. tranche.amount is GROSS (request-funding
    // calculateTrancheAmounts: the two tranche amounts sum to the full gross
    // offer price, no fee pre-deducted), and the P2 destination charge already
    // took the fee once as application_fee at funding. So `(1 − fee)` nets the
    // fee EXACTLY ONCE against gross — the SAME amount is correct for both the
    // transfer (flag-OFF) and the payout (flag-ON). Do NOT strip `(1 − fee)` in
    // PAYOUT_MODE: that would pay (1 − fee)² and short the provider; paying raw
    // gross would overdraw the net balance. Fee already taken at funding — do
    // NOT re-apply. (P3 correction #3 rests on a false premise for this codebase
    // because tranche.amount is gross, not net.)
    const transferCurrency = (plan.currency ?? 'EUR').toLowerCase()

    // ── PAYOUT_MODE rounding true-up: final tranche = balancing residual ──────
    // Independent per-tranche rounding (round(gross×(1−fee)) for BOTH tranches)
    // can sum to 1ct MORE than the real connected-account NET balance, which
    // would overdraw the payout. So under the destination-charge corridor, for
    // the FINAL tranche of the fixed 2-tranche split (and ONLY outside a dispute
    // split, parsedSplitRatio === undefined), the final payout draws exactly the
    // residual: net_total − deposit_net. This guarantees Σ(payouts) == net_total,
    // never an overshoot. Flag-OFF / dispute split / deposit_release all take the
    // else branch and are byte-identical to pre-P3b. The (1 − platformFeeRate)
    // factor is preserved in EVERY branch — the fee is still taken exactly once.
    let netTransferAmount: number
    if (PAYOUT_MODE && parsedSplitRatio === undefined && tranche.kind === 'final_release') {
      const totalGross = Number(plan.total_amount ?? NaN)
      if (!Number.isFinite(totalGross) || totalGross <= 0) {
        // No reliable plan total → fall back to the independent per-tranche net.
        netTransferAmount = toSmallestUnit(effectiveGross * (1 - platformFeeRate), transferCurrency)
      } else {
        // The non-final tranche is the 25% deposit_release. Recompute its gross
        // deterministically (mirrors calculateTrancheAmounts) so the residual is
        // independent of sibling-row read order / availability.
        const depositGross = Number(((totalGross * DEPOSIT_RELEASE_PERCENT) / 100).toFixed(2))
        // net_total = the connected-account NET destination-charge balance =
        //   grossCents − appFeeCents, using the SAME two-rounding arithmetic the
        //   funding application_fee uses: toSmallestUnit(gross) − toSmallestUnit(gross×rate).
        //   NOT a single round(gross×(1−fee)) — that overshoots the real balance by
        //   1ct in ~0.8–3.5% of amounts (empirically verified).
        const netTotalCents = toSmallestUnit(totalGross, transferCurrency)
          - toSmallestUnit(totalGross * platformFeeRate, transferCurrency)
        const depositNetCents = toSmallestUnit(depositGross * (1 - platformFeeRate), transferCurrency)
        netTransferAmount = netTotalCents - depositNetCents // final draws only the residual
      }
    } else {
      netTransferAmount = toSmallestUnit(effectiveGross * (1 - platformFeeRate), transferCurrency)
    }
    const transferIdempotencyKey = `tranche_release_${trancheId.trim()}`

    // Movement reference: a Stripe transfer id (tr_*) under flag-OFF, or a payout
    // id (po_*) under PAYOUT_MODE. The downstream RPC routes on this prefix.
    let transferId: string
    try {
      if (PAYOUT_MODE) {
        // Destination-charge corridor: the net funds already sit on the
        // provider's connected account, so release = a payout drawing from that
        // account's own available balance. No source_transaction / destination /
        // transfer_group — those are transfer-model concepts. Same amount as the
        // transfer path (already net, see above). metadata.tranche_id lets the
        // payout.paid webhook disambiguate this from a Stripe auto-payout.
        const payout = await stripe.payouts.create(
          {
            amount: netTransferAmount,
            currency: transferCurrency,
            metadata: { tranche_id: trancheId.trim() },
          },
          {
            stripeAccount: stripeConnectAccountId,
            // VARYING idempotency key (P3b item A): the reconcile-payout-corridor
            // cron relies on the `_<count>` suffix to bypass Stripe's cached
            // `balance_insufficient` 4xx on re-attempt. The key is STABLE within
            // an attempt number and only changes when a definitive non-paying
            // terminal event bumps payout_attempt_count (the balance_insufficient
            // soft-fail below, or the payout.failed webhook revert) — NEVER on the
            // success path. So an RPC-write-failed split-brain (payout created,
            // DB write failed → counter unchanged) replays the SAME key and Stripe
            // returns the existing payout instead of double-paying.
            idempotencyKey: `tranche_payout_${trancheId.trim()}_${Number(tranche.payout_attempt_count ?? 0)}`,
          },
        )
        transferId = payout.id
        logInfo('api.release_tranche.payout_created', {
          trancheId,
          planId,
          payoutId: transferId,
          netAmount: netTransferAmount,
          currency: transferCurrency,
          connectAccount: stripeConnectAccountId,
          ...(parsedSplitRatio !== undefined ? { splitRatio: parsedSplitRatio } : {}),
        })
      } else {
        const transfer = await stripe.transfers.create(
          {
            amount: netTransferAmount,
            currency: transferCurrency,
            destination: stripeConnectAccountId,
            source_transaction: chargeId,
            transfer_group: `escrow_plan_${planId.trim()}`,
            metadata: { tranche_id: trancheId.trim() },
          },
          { idempotencyKey: transferIdempotencyKey },
        )
        transferId = transfer.id
        logInfo('api.release_tranche.transfer_created', {
          trancheId,
          planId,
          transferId,
          netAmount: netTransferAmount,
          currency: transferCurrency,
          destination: stripeConnectAccountId,
          chargeId,
          ...(parsedSplitRatio !== undefined ? { splitRatio: parsedSplitRatio } : {}),
        })
      }
    } catch (stripeErr: unknown) {
      // PAYOUT_MODE soft-fail: destination-charge funds stay ~7 days pending
      // (P0-verified), so payouts.create commonly returns 'balance_insufficient'.
      // This is NOT a hard error — the tranche stays eligible_for_release (NO DB
      // mutation, NO external_payout_ref, NO ledger row: nothing released yet)
      // and the P3b retry cron (OUT OF SCOPE here) re-attempts it later. Respond
      // soft 202 instead of 502 so callers do not treat it as a failure.
      if (PAYOUT_MODE && (stripeErr as { code?: string })?.code === 'balance_insufficient') {
        if (parsedSplitRatio !== undefined && splitReservationHeld) {
          const { error: releaseReservationError } = await supabase.rpc(
            'release_split_release_reservation',
            {
              p_tranche_id: trancheId.trim(),
              p_plan_id: planId.trim(),
              p_split_ratio: parsedSplitRatio,
            },
          )
          if (releaseReservationError) {
            logError('api.release_tranche.split_reservation_release_failed', releaseReservationError, {
              trancheId,
              planId,
              splitRatio: parsedSplitRatio,
            })
          }
        }
        // RETRY-ENABLER (P3b item A): bump payout_attempt_count so the next
        // reconcile-payout-corridor cron re-attempt builds a FRESH idempotency
        // key (`tranche_payout_<id>_<count>`) and bypasses Stripe's cached
        // `balance_insufficient` 4xx. Provably double-pay-safe: balance_insufficient
        // means NO payout was created, so re-keying cannot replay a real payout.
        // The status guard ensures we only bump a still-eligible tranche; this is
        // the ONLY new write on this branch (no external_payout_ref, no ledger row,
        // nothing released — the tranche stays eligible_for_release). Flag-OFF
        // never reaches here (PAYOUT_MODE false).
        await supabase
          .from('escrow_tranches')
          .update({
            payout_attempt_count: Number(tranche.payout_attempt_count ?? 0) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', trancheId.trim())
          .eq('status', 'eligible_for_release')
        logInfo('api.release_tranche.payout_deferred', {
          trancheId,
          planId,
          netAmount: netTransferAmount,
          currency: transferCurrency,
          connectAccount: stripeConnectAccountId,
          reason: 'balance_insufficient',
        })
        res.status(202).json({
          status: 'release_deferred',
          reason: 'balance_insufficient',
          retryable: true,
          trancheId,
          planId,
        })
        return
      }
      const detail = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      logError('api.release_tranche.transfer_failed', stripeErr instanceof Error ? stripeErr : undefined, {
        trancheId,
        planId,
        chargeId,
        destination: stripeConnectAccountId,
      })
      res.status(502).json({ error: `Stripe transfer failed: ${detail}` })
      return
    }

    // ── Atomic DB write: tranche + plan + ledger in single transaction ──────────
    // After a successful Stripe Transfer, both the tranche and the plan status
    // must be updated atomically, and a ledger entry must be written in the same
    // transaction. Non-atomic sequential writes risk a split-brain where the
    // tranche shows 'released' but the ledger is never written.
    //
    // Uses release_tranche_with_ledger which atomically:
    //   1. Updates escrow_tranches (status, external_release_ref)
    //   2. Rolls up escrow_payment_plans.status
    //   3. Inserts a ledger_entries row of type 'tranche_release'
    //
    // On RPC failure: money already moved on Stripe — return HTTP 500 with the
    // Stripe transfer reference so the client/reconciliation knows funds moved but
    // DB state is inconsistent. The caller must surface this as an error (not
    // treat it as success).
    void externalReleaseRef
    const now = new Date().toISOString()
    const releasedAt = isRecoveryPath ? (tranche.released_at ?? now) : now

    // Resolve the payment_id for this job so the ledger entry can be linked.
    // Best-effort: if the payments row is not found the ledger write is skipped
    // inside the RPC (tranche + plan update still commit atomically).
    let paymentId: string | null = null
    if (plan.job_id) {
      const { data: paymentRow } = await supabase
        .from('payments')
        .select('id')
        .eq('job_id', String(plan.job_id))
        .maybeSingle()
      paymentId = (paymentRow as { id?: string } | null)?.id ?? null
    }

    const ledgerEntryId = `ledger_tranche_${trancheId.trim()}`

    // ── DB actor downgrade (migration-free) ─────────────────────────────────
    // escrow_tranches.released_by carries a CHECK constraint that — VERIFIED
    // against prod (escrow_tranches_released_by_check) — accepts ONLY
    // ('customer','provider','system') or NULL. It does NOT include 'consensus'
    // OR 'operator'. Persisting either dispute-origin actor would violate the
    // CHECK and fail release_tranche_with_ledger AFTER the Stripe money already
    // moved — a split-brain with no migration. Both are therefore mapped to the
    // already-accepted 'system' sentinel for the persisted released_by / ledger
    // actor, while the app-level audit (releaseActor, logged in
    // api.release_tranche.success below) still records the true
    // 'consensus' / 'operator' origin. Identity for customer/provider, so
    // flag-OFF / non-dispute releases stay byte-identical.
    const dbReleaseActor =
      releaseActor === 'consensus' || releaseActor === 'operator' ? 'system' : releaseActor

    const { data: rpcResult, error: rpcError } = await supabase.rpc(
      'release_tranche_with_ledger',
      {
        p_tranche_id:      trancheId.trim(),
        p_plan_id:         planId.trim(),
        // po_* under PAYOUT_MODE, tr_* otherwise — the RPC routes by id prefix
        // (payout branch persists external_payout_ref + status='release_pending';
        // transfer branch persists external_release_ref + status='released').
        p_transfer_id:     transferId,
        p_actor:           dbReleaseActor,
        // PAYOUT_MODE: released_at is set later by the payout.paid webhook when
        // status flips release_pending → released. Pass null now.
        p_released_at:     PAYOUT_MODE ? null : releasedAt,
        p_net_amount:      netTransferAmount / 100, // convert smallest-unit back to EUR
        p_currency:        transferCurrency.toUpperCase(),
        p_payment_id:      paymentId,
        p_job_id:          plan.job_id ? String(plan.job_id) : null,
        p_ledger_entry_id: ledgerEntryId,
      },
    )

    if (rpcError) {
      // P0004 SQLSTATE with 'ATTRIBUTION_NOT_FINALIZED:' message is raised by
      // the attribution release-defense trigger (migration 20260420000003).
      // It indicates a TOCTOU drift: the app-layer guard passed, the Stripe
      // Transfer executed, then attribution transitioned (e.g. operator moved
      // the job to DLQ concurrently).  The DB refused the release write —
      // money has moved on Stripe but the DB row is unchanged.  Surface as a
      // distinct Sentry event so operators can reconcile manually.
      const attributionDrift =
        (rpcError as { code?: string }).code === 'P0004'
        || (typeof rpcError.message === 'string' && rpcError.message.includes('ATTRIBUTION_NOT_FINALIZED'))

      if (attributionDrift) {
        logError('api.release_tranche.attribution_drift_split_brain', new Error(rpcError.message), {
          trancheId,
          transferId,
          planId,
          jobId: plan.job_id,
          dbErrorCode: (rpcError as { code?: string }).code,
          note: 'Stripe Transfer succeeded but DB defense trigger refused the release write. Manual reconciliation required.',
        })
      } else {
        logError('api.release_tranche.atomic_write_failed', new Error(rpcError.message), {
          trancheId,
          transferId,
          planId,
        })
      }
      res.status(500).json({
        error: 'DB_WRITE_FAILED',
        message: 'Stripe transfer succeeded but DB write failed. Manual reconciliation required.',
        trancheId,
        planId,
        externalReleaseRef: transferId,
        requiresReconciliation: true,
        ...(attributionDrift ? { attributionDrift: true } : {}),
      })
      return
    }

    const rpcData = rpcResult as Record<string, unknown> | null
    const rpcOutcome = rpcData?.outcome ?? 'unknown'
    const planStatus = (rpcData?.plan_status as string | undefined) ?? 'unknown'

    if (rpcOutcome === 'not_found') {
      logWarning('api.release_tranche.atomic_write_not_found', {
        trancheId,
        planId,
        note: 'Transfer succeeded on Stripe but tranche row not found in DB — possible orphan',
      })
      res.status(500).json({
        error: 'TRANCHE_NOT_FOUND',
        message: 'Stripe transfer succeeded but tranche row not found in DB. Manual reconciliation required.',
        trancheId,
        planId,
        externalReleaseRef: transferId,
        requiresReconciliation: true,
      })
      return
    }

    logInfo('api.release_tranche.success', {
      trancheId,
      planId,
      planStatus,
      externalReleaseRef: transferId,
      actor: releaseActor,
      transferId,
      netAmount: netTransferAmount,
      ...(parsedSplitRatio !== undefined ? { splitRatio: parsedSplitRatio } : {}),
      ...(isRecoveryPath ? { healedInconsistency: true } : {}),
    })

    if (PAYOUT_MODE) {
      // Payout initiated and DB persisted status='release_pending'. The
      // payout.paid webhook later flips it to 'released' (released_at set there).
      // Not 'released' yet — do not report it as such.
      res.status(200).json({
        status: 'release_pending',
        trancheId,
        planId,
        planStatus,
        externalPayoutRef: transferId,
      })
      return
    }

    res.status(200).json({
      status: 'released',
      trancheId,
      planId,
      planStatus,
      releasedAt: now,
      externalReleaseRef: transferId,
      ...(isRecoveryPath ? { healedInconsistency: true } : {}),
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('api.release_tranche.unexpected_error', err instanceof Error ? err : undefined, {
      trancheId,
    })
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
