/**
 * Shared supplementary payout release logic.
 *
 * Creates a Stripe Transfer for a funded supplementary payment request,
 * moving the net amount (gross − platform fee) to the craftsman's Stripe
 * Connect account.  Also writes ledger entries directly to Supabase.
 *
 * Used by:
 *   - stripe-webhook.ts (auto-release after funding confirmation)
 *   - release-supplementary-payout.ts (manual retry endpoint)
 *
 * Stripe model: Separate Charges and Transfers.
 *   The supplementary PaymentIntent was captured on the SaFix platform account.
 *   The Transfer routes net funds to the provider's Express Connect account.
 *   source_transaction ties the Transfer to the specific charge (no double-spend).
 *
 * Idempotent:
 *   - Stripe idempotency key `supp_release_{supplementaryPaymentId}` prevents
 *     duplicate Transfers on retry.
 *   - If the SPR is already released, returns early with the existing state.
 *   - Ledger entries dedupe on the (payment_id, entry_type, movement_ref)
 *     unique key via upsert ignoreDuplicates (movement_ref = sprId).
 *
 * Fail-closed:
 *   - Commercial attribution MUST be 'finalized' before any Stripe call.
 *     Parity with initiate-supplementary-funding (same invariant on the
 *     funding side) — release verifies again because attribution can transition
 *     into 'dlq' after funding succeeded.
 *   - DB writes only AFTER successful Stripe Transfer.
 *   - If Transfer fails, SPR stays `funded` — safe to retry.
 *   - If attribution is unresolved / DLQ / invalid: SPR stays `funded`, no
 *     Stripe call, no DB mutation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { resolveCommercialFeeRate } from './_feeRate.js'
import { logError, logInfo, logWarning } from './_observability.js'
import {
  assertAttributionFinalized,
  type AttributionGateBlocked,
} from './_attributionGuard.js'

// ── Result types ─────────────────────────────────────────────────────────────

export type SupplementaryReleaseResult =
  | { ok: true; outcome: 'RELEASED'; transferId: string; netAmountCents: number; platformFeeCents: number }
  | { ok: true; outcome: 'ALREADY_RELEASED'; transferId: string }
  | { ok: false; outcome: 'NOT_FUNDED'; currentStatus: string }
  | { ok: false; outcome: 'PROVIDER_NOT_PAYOUT_READY'; reason: string }
  | { ok: false; outcome: 'MISSING_FUNDING_REF' }
  | { ok: false; outcome: 'INTENT_NOT_CAPTURED'; intentStatus: string }
  | { ok: false; outcome: 'TRANSFER_FAILED'; error: string }
  | { ok: false; outcome: 'DB_UPDATE_FAILED'; transferId: string; error: string }
  | { ok: false; outcome: 'NOT_FOUND' }
  | { ok: false; outcome: 'ATTRIBUTION_BLOCKED'; gate: AttributionGateBlocked }

// ── Main function ────────────────────────────────────────────────────────────

export async function releaseSupplementaryPayout(
  supabase: SupabaseClient,
  stripe: Stripe,
  supplementaryPaymentId: string,
): Promise<SupplementaryReleaseResult> {
  const logCtx = { supplementaryPaymentId }

  // ── 1. Load SPR ──────────────────────────────────────────────────────────
  const { data: spr, error: sprError } = await supabase
    .from('supplementary_payment_requests')
    .select('*')
    .eq('id', supplementaryPaymentId.trim())
    .maybeSingle()

  if (sprError || !spr) {
    logError('supplementary_release.spr_not_found', sprError ?? undefined, logCtx)
    return { ok: false, outcome: 'NOT_FOUND' }
  }

  // ── 2. Idempotent: already released ──────────────────────────────────────
  if (spr.status === 'released') {
    logInfo('supplementary_release.already_released', {
      ...logCtx,
      transferId: spr.external_payout_ref,
    })
    return { ok: true, outcome: 'ALREADY_RELEASED', transferId: spr.external_payout_ref ?? '' }
  }

  // ── 3. Status guard: must be funded ──────────────────────────────────────
  if (spr.status !== 'funded') {
    logWarning('supplementary_release.not_funded', {
      ...logCtx,
      currentStatus: spr.status,
    })
    return { ok: false, outcome: 'NOT_FUNDED', currentStatus: spr.status }
  }

  // ── 4. Attribution gate ──────────────────────────────────────────────────
  // Parity with initiate-supplementary-funding: the same contract that gated
  // funding must gate the payout.  Attribution can transition into 'dlq' after
  // funding succeeded (e.g., operator classification dispute), so we re-verify
  // before moving money.  Fail-closed: SPR stays 'funded', no Stripe call.
  const gate = await assertAttributionFinalized(supabase, spr.job_id as string, 'supplementary_release')
  if (gate.ok === false) {
    return { ok: false, outcome: 'ATTRIBUTION_BLOCKED', gate }
  }

  // ── 5. Resolve provider's Stripe Connect account ─────────────────────────
  const { data: payoutAccount, error: payoutError } = await supabase
    .from('provider_payout_accounts')
    .select('stripe_connect_account_id, charges_enabled, payouts_enabled')
    .eq('provider_user_id', spr.craftsman_user_id)
    .maybeSingle()

  if (payoutError) {
    logError('supplementary_release.payout_account_fetch_failed', payoutError, logCtx)
    return { ok: false, outcome: 'PROVIDER_NOT_PAYOUT_READY', reason: 'Failed to fetch payout account.' }
  }

  if (
    !payoutAccount?.stripe_connect_account_id ||
    !payoutAccount.charges_enabled ||
    !payoutAccount.payouts_enabled
  ) {
    logWarning('supplementary_release.provider_not_ready', {
      ...logCtx,
      hasAccount: !!payoutAccount?.stripe_connect_account_id,
      chargesEnabled: payoutAccount?.charges_enabled ?? false,
      payoutsEnabled: payoutAccount?.payouts_enabled ?? false,
    })
    return {
      ok: false,
      outcome: 'PROVIDER_NOT_PAYOUT_READY',
      reason: 'Provider Stripe Connect account is not ready for payout.',
    }
  }

  const stripeConnectAccountId = payoutAccount.stripe_connect_account_id

  // ── 6. Resolve charge + metadata from the supplementary PaymentIntent ────
  const fundingRef = spr.external_ref as string | null
  if (!fundingRef) {
    logError('supplementary_release.missing_funding_ref', undefined, logCtx)
    return { ok: false, outcome: 'MISSING_FUNDING_REF' }
  }

  let chargeId: string | null = null
  let intentMetadata: Record<string, string> | null = null
  try {
    const intent = await stripe.paymentIntents.retrieve(fundingRef)
    chargeId = typeof intent.latest_charge === 'string'
      ? intent.latest_charge
      : (intent.latest_charge?.id ?? null)
    intentMetadata = (intent.metadata ?? null) as Record<string, string> | null

    if (intent.status !== 'succeeded') {
      logWarning('supplementary_release.intent_not_succeeded', {
        ...logCtx,
        fundingRef,
        intentStatus: intent.status,
      })
      return { ok: false, outcome: 'INTENT_NOT_CAPTURED', intentStatus: intent.status }
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('supplementary_release.intent_retrieve_failed', err instanceof Error ? err : undefined, {
      ...logCtx,
      fundingRef,
    })
    return { ok: false, outcome: 'TRANSFER_FAILED', error: `Failed to retrieve funding PI: ${detail}` }
  }

  if (!chargeId) {
    logError('supplementary_release.no_charge_id', undefined, { ...logCtx, fundingRef })
    return { ok: false, outcome: 'TRANSFER_FAILED', error: 'Funding PI has no captured charge.' }
  }

  // ── 7. Fee rate resolution ───────────────────────────────────────────────
  // Try PI metadata first (locked at funding time), fall back to the gate's
  // verified commercial origin.  The gate has already asserted the origin is
  // one of the two valid values — `resolveCommercialFeeRate` never defaults
  // from this point.
  let platformFeeRate: number

  const metadataFeeRate = intentMetadata?.platformFeeRate
    ? Number(intentMetadata.platformFeeRate)
    : null

  if (metadataFeeRate && metadataFeeRate > 0 && metadataFeeRate < 1) {
    platformFeeRate = metadataFeeRate
  } else {
    const resolved = resolveCommercialFeeRate(gate.commercialOrigin)
    platformFeeRate = resolved.rate
  }

  // ── 8. Create Stripe Transfer ────────────────────────────────────────────
  const amountCents = spr.amount_cents as number
  const platformFeeCents = Math.round(amountCents * platformFeeRate)
  const netAmountCents = amountCents - platformFeeCents
  const currency = ((spr.currency as string) ?? 'eur').toLowerCase()
  const idempotencyKey = `supp_release_${supplementaryPaymentId.trim()}`

  let transferId: string
  try {
    const transfer = await stripe.transfers.create(
      {
        amount: netAmountCents,
        currency,
        destination: stripeConnectAccountId,
        source_transaction: chargeId,
        transfer_group: `supplementary_${supplementaryPaymentId.trim()}`,
        metadata: {
          type: 'supplementary_payout',
          supplementaryPaymentId: supplementaryPaymentId.trim(),
          jobId: spr.job_id,
          grossAmountCents: String(amountCents),
          platformFeeCents: String(platformFeeCents),
          platformFeeRate: String(platformFeeRate),
          commercialOrigin: gate.commercialOrigin,
        },
      },
      { idempotencyKey },
    )
    transferId = transfer.id
    logInfo('supplementary_release.transfer_created', {
      ...logCtx,
      transferId,
      netAmountCents,
      platformFeeCents,
      destination: stripeConnectAccountId,
      chargeId,
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('supplementary_release.transfer_failed', err instanceof Error ? err : undefined, {
      ...logCtx,
      chargeId,
      destination: stripeConnectAccountId,
    })
    return { ok: false, outcome: 'TRANSFER_FAILED', error: `Stripe transfer failed: ${detail}` }
  }

  // ── 9. DB write: SPR → released (only after successful Transfer) ─────────
  const nowMs = Date.now()

  const { data: updatedRows, error: updateError } = await supabase
    .from('supplementary_payment_requests')
    .update({
      status: 'released',
      released_at: nowMs,
      external_payout_ref: transferId,
      updated_at: nowMs,
    })
    .eq('id', supplementaryPaymentId.trim())
    .eq('status', 'funded')
    .select('id')

  if (updateError) {
    // P0004 / ATTRIBUTION_NOT_FINALIZED means the release-defense trigger
    // (migration 20260420000003) refused the write.  Money already moved on
    // Stripe — this is a TOCTOU drift between the app-layer gate (passed)
    // and the DB gate (refused).  Emit a distinct event for operator action.
    const attributionDrift =
      (updateError as { code?: string }).code === 'P0004'
      || (typeof updateError.message === 'string' && updateError.message.includes('ATTRIBUTION_NOT_FINALIZED'))

    if (attributionDrift) {
      logError('supplementary_release.attribution_drift_split_brain', updateError, {
        ...logCtx,
        transferId,
        dbErrorCode: (updateError as { code?: string }).code,
        note: 'Stripe Transfer succeeded but DB defense trigger refused the release write. Manual reconciliation required.',
      })
    } else {
      logError('supplementary_release.spr_update_failed', updateError, {
        ...logCtx,
        transferId,
      })
    }
    return {
      ok: false,
      outcome: 'DB_UPDATE_FAILED',
      transferId,
      error: `SPR update failed after transfer. Transfer ID: ${transferId}`,
    }
  }

  // Guard: zero rows updated means the SPR was no longer in 'funded' state
  // (concurrent release, status already advanced, or row deleted).  Stripe has
  // transferred the funds regardless.  Surface this as an explicit error so the
  // caller does NOT misreport outcome: 'RELEASED' for a write that did not land.
  if (!updatedRows || updatedRows.length === 0) {
    logError('supplementary_release.spr_no_rows_updated', undefined, {
      ...logCtx,
      transferId,
      reason: 'SPR status was not funded at write time — concurrent release or state drift',
    })
    return {
      ok: false,
      outcome: 'DB_UPDATE_FAILED',
      transferId,
      error: `SPR ${supplementaryPaymentId.trim()} not in funded state at DB write time. Transfer ID: ${transferId}. Manual reconciliation required.`,
    }
  }

  // ── 10. Ledger entries (server-side, directly to Supabase) ───────────────
  // Convert cents to EUR for ledger (ledger stores EUR amounts, not cents).
  const grossEur = amountCents / 100
  const netEur = netAmountCents / 100
  const feeEur = platformFeeCents / 100
  const sprId = supplementaryPaymentId.trim()
  const paymentId = spr.original_payment_id as string
  const jobId = spr.job_id as string

  // Prod money-movement shape: NOT NULL entry_type from the CHECK enum, note in
  // metadata jsonb, no epoch-ms created_at, no client id. movement_ref = sprId
  // discriminates this supplementary movement from the base escrow deposit/payout
  // and from every other SPR on the same original payment, so all rows coexist
  // under UNIQUE(payment_id, entry_type, movement_ref) while retries dedupe on it.
  // id omitted → DEFAULT gen_random_uuid(); created_at omitted → DEFAULT now().
  const ledgerEntries = [
    {
      payment_id: paymentId,
      job_id: jobId,
      entry_type: 'escrow_deposit',
      amount: grossEur,
      currency: 'EUR',
      movement_ref: sprId,
      metadata: { note: `Nachzahlung über Plattform eingegangen [${sprId}]`, spr_id: sprId },
    },
    {
      payment_id: paymentId,
      job_id: jobId,
      entry_type: 'platform_fee',
      amount: feeEur,
      currency: 'EUR',
      movement_ref: sprId,
      metadata: { note: `SaFix Plattformprovision Nachtrag (${Math.round(platformFeeRate * 100)} %) [${sprId}]`, spr_id: sprId },
    },
    {
      payment_id: paymentId,
      job_id: jobId,
      entry_type: 'payout',
      amount: netEur,
      currency: 'EUR',
      movement_ref: sprId,
      metadata: { note: `Auszahlung Nachtrag an Betrieb [${sprId}]`, spr_id: sprId },
    },
  ]

  const { error: ledgerError } = await supabase
    .from('ledger_entries')
    .upsert(ledgerEntries, { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true })

  if (ledgerError) {
    // Non-fatal: Transfer succeeded, SPR is released.
    // Ledger can be reconciled manually.
    logError('supplementary_release.ledger_insert_failed', ledgerError, {
      ...logCtx,
      transferId,
    })
  }

  logInfo('supplementary_release.success', {
    ...logCtx,
    transferId,
    netAmountCents,
    platformFeeCents,
    platformFeeRate,
    commercialOrigin: gate.commercialOrigin,
  })

  return {
    ok: true,
    outcome: 'RELEASED',
    transferId,
    netAmountCents,
    platformFeeCents,
  }
}
