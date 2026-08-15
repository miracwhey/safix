import Stripe from 'stripe'
import { toSmallestUnit } from './_shared.js'
import { logWarning } from './_observability.js'

/**
 * Shared escrow-refund mechanic.
 *
 * Extracted verbatim from api/refund-escrow.ts so the public endpoint AND the
 * flag-gated T+80 dispute-default-cut cron worker (Block P Run 2) drive the
 * EXACT same Stripe refund behaviour: the corridor reverse_transfer /
 * refund_application_fee logic, the per-currency MAX guard, the amount → minor
 * conversion, and the stable idempotency key.
 *
 * Every authorization / validation gate (auth, rate-limit, body validation,
 * payment-context, operator/consensus authz, the tranche-release guard, and the
 * plan-currency assert) stays in the CALLER. This module receives an
 * already-retrieved PaymentIntent and only performs the Stripe side effect.
 */

// Per-currency refund ceiling, compared against the request amount in MAJOR
// units (e.g. EUR 50_000 = €50,000). Moved here so the endpoint and the cron
// worker enforce one identical limit.
export const MAX_REFUND_AMOUNTS: Record<string, number> = {
  eur: 50_000,
  usd: 55_000,
  gbp: 45_000,
  chf: 52_000,
  sek: 580_000,
  nok: 590_000,
  dkk: 375_000,
}

export type EscrowRefundOutcome =
  | { ok: true; mode: 'cancelled' | 'already_canceled' | 'refunded' }
  | { ok: false; httpStatus: number; body: Record<string, unknown> }

/**
 * Execute the cancel-or-refund mechanic against an already-retrieved
 * PaymentIntent.
 *
 *   - status 'requires_capture' → cancel the auth hold (idempotent on the
 *     payment_intent_unexpected_state race) → { ok:true, mode:'cancelled' }
 *   - status 'canceled'         → no-op idempotent success → { ok:true, mode:'already_canceled' }
 *   - any other non-'succeeded' → warn, then attempt the refund (Stripe returns
 *     a structured error if the state is truly incompatible)
 *   - status 'succeeded'        → create the refund → { ok:true, mode:'refunded' }
 *
 * The MAX guard returns { ok:false, httpStatus:400, body } — the SAME shape the
 * endpoint returned today — so the caller maps it straight onto its response.
 *
 * Real Stripe errors (cancel/refund) propagate so the caller's existing
 * try/catch Stripe-error mapping handles them unchanged.
 */
export async function executeEscrowRefundForIntent(
  stripe: Stripe,
  intent: Stripe.PaymentIntent,
  params: {
    amount?: number
    disputeId?: string | null
    destinationChargeEnabled: boolean
    // Opt-in overrides (Block P Batch 1, default-off — unset keeps the legacy
    // behaviour byte-for-byte):
    //   refundApplicationFee — when set, the caller decides whether the platform
    //     application fee is refunded (still gated on isDestinationCharge). Lets
    //     the T+80 dispute-default path make a PARTIAL refund that STILL refunds
    //     the fee, while operator/consensus splits keep "partial → keep fee" by
    //     leaving it unset. Unset → the legacy "true iff full refund" default.
    //   idempotencySuffix — when set, pins the idempotency key to a STABLE
    //     per-operation suffix (refund_<pi>_<suffix>) instead of the
    //     amount-derived key, so a re-run that recomputes a slightly different
    //     amount still de-duplicates. Unset → the legacy amount/full key.
    refundApplicationFee?: boolean
    idempotencySuffix?: string
  },
): Promise<EscrowRefundOutcome> {
  const { amount, disputeId, destinationChargeEnabled, refundApplicationFee, idempotencySuffix } =
    params

  // P4 corridor (dormant unless the flag is ON): we additionally require the PI
  // to actually be a destination charge (transfer_data.destination present)
  // rather than trusting the flag alone — a post-flip refund of a pre-flip
  // separate-charge PI then carries NO reverse_transfer (Stripe would error on a
  // plain charge), and mixed pre/post-flip inventory self-handles per-PI.
  const isDestinationCharge = destinationChargeEnabled && !!intent.transfer_data?.destination

  if (intent.status === 'requires_capture') {
    // Funds are on hold but not yet captured. Cancel to release the hold.
    try {
      await stripe.paymentIntents.cancel(intent.id)
      console.log(`refund-escrow: cancelled requires_capture PaymentIntent ${intent.id}`)
    } catch (cancelErr: unknown) {
      if (
        cancelErr instanceof Stripe.errors.StripeInvalidRequestError &&
        cancelErr.code === 'payment_intent_unexpected_state'
      ) {
        // Intent transitioned between our retrieve and cancel calls — treat as
        // already cancelled / terminal (idempotent).
        console.log(
          `refund-escrow: PaymentIntent ${intent.id} state changed before cancel — treating as done.`,
        )
      } else {
        throw cancelErr
      }
    }
    return { ok: true, mode: 'cancelled' }
  }

  if (intent.status === 'canceled') {
    // Already cancelled — idempotent success.
    console.log(`refund-escrow: PaymentIntent ${intent.id} already cancelled — no-op`)
    return { ok: true, mode: 'already_canceled' }
  }

  if (intent.status !== 'succeeded') {
    // Unexpected intermediate state (e.g. 'processing', 'requires_action').
    // Log for observability; proceed to stripe.refunds.create() which will
    // return a structured Stripe error if the state is truly incompatible.
    console.warn(
      `refund-escrow: unexpected PaymentIntent status '${intent.status}' for ${intent.id} — attempting refund.`,
    )
  }

  // PaymentIntent has been captured (status: 'succeeded') — create a refund.
  const refundParams: Stripe.RefundCreateParams = {
    payment_intent: intent.id,
    // P4 corridor (dormant unless isDestinationCharge): reverse the transfer to
    // the connected account first so the clawback comes from the provider's
    // destination-charge funds, not the platform balance. Omitted on a
    // separate-charge PI (flag-OFF, or a pre-flip PI refunded post-flip).
    ...(isDestinationCharge ? { reverse_transfer: true } : {}),
  }

  if (typeof disputeId === 'string' && disputeId.trim() !== '') {
    refundParams.metadata = { disputeId: disputeId.trim() }
  }

  if (typeof amount === 'number') {
    const currency = intent.currency.toLowerCase()
    const maxForCurrency = MAX_REFUND_AMOUNTS[currency]
    if (maxForCurrency !== undefined && amount > maxForCurrency) {
      logWarning('api.refund.amount_exceeds_max', { amount, currency, paymentIntentId: intent.id })
      return {
        ok: false,
        httpStatus: 400,
        body: {
          error: `Validation error: refund amount exceeds maximum allowed for ${currency.toUpperCase()} (${maxForCurrency}).`,
        },
      }
    }
    // Amount from SaFix is in major currency units (e.g. EUR 20.00 → 2000 cents).
    refundParams.amount = toSmallestUnit(amount, intent.currency)
  }

  // P4 corridor: refund the platform application fee. By DEFAULT this happens
  // ONLY on a FULL pre-work refund (amount undefined → the whole charge is
  // reversed); on a dispute-split PARTIAL refund the platform keeps its fee. A
  // caller MAY override that default via `refundApplicationFee` (e.g. the T+80
  // dispute-default path makes a PARTIAL 75% refund and STILL refunds the fee,
  // while operator/consensus splits keep the legacy "partial → keep fee" by
  // leaving it unset). Either way it stays gated on isDestinationCharge, so it
  // is dormant flag-OFF and never sent on a separate-charge PI (which carries no
  // application fee to refund).
  const shouldRefundApplicationFee =
    refundApplicationFee !== undefined ? refundApplicationFee : refundParams.amount === undefined
  if (isDestinationCharge && shouldRefundApplicationFee) {
    refundParams.refund_application_fee = true
  }

  // Stable idempotency key so retry / double-click of the same refund
  // operation returns the cached Stripe result instead of creating a
  // duplicate refund. By DEFAULT the key includes the converted amount
  // (smallest currency unit) for partial refunds so a full refund and a partial
  // refund against the same PI cannot collide. A caller MAY instead pass an
  // explicit `idempotencySuffix` to pin a STABLE per-operation key (e.g. the
  // T+80 worker keys on the dispute, not the amount). Unset → the legacy
  // amount/full key is preserved byte-for-byte.
  const stableSuffix =
    typeof idempotencySuffix === 'string' && idempotencySuffix.trim() !== ''
      ? idempotencySuffix.trim()
      : undefined
  const refundIdempotencyKey = stableSuffix !== undefined
    ? `refund_${intent.id}_${stableSuffix}`
    : refundParams.amount !== undefined
      ? `refund_${intent.id}_${refundParams.amount}`
      : `refund_${intent.id}_full`

  await stripe.refunds.create(refundParams, {
    idempotencyKey: refundIdempotencyKey,
  })
  return { ok: true, mode: 'refunded' }
}
