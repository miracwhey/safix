/**
 * Escrow refund service — extraction regression guard.
 *
 * Proves api/_escrowRefundService.ts reproduces the EXACT Stripe refund mechanic
 * that previously lived inline in api/refund-escrow.ts, so the public endpoint
 * stays byte-identical AND the flag-gated T+80 dispute-default-cut cron can reuse
 * the same code:
 *
 *   (a) flag-OFF full refund          → NO reverse_transfer, NO refund_application_fee
 *                                        (separate-charge byte-identical), key `_full`
 *   (b) flag-ON destination + FULL    → reverse_transfer:true AND refund_application_fee:true
 *   (c) flag-ON destination + PARTIAL → reverse_transfer:true, NO refund_application_fee,
 *                                        amount converted, key `_<amount>`
 *   (d) requires_capture              → cancel path (no refund), mode 'cancelled'
 *   (e) MAX exceeded                  → { ok:false, httpStatus:400 }, no refund created
 *
 * Stripe is a passed-in fake (the service takes the client as a param); the real
 * `stripe` package supplies the Stripe.errors namespace for the cancel-race
 * instanceof check. _observability is mocked so the MAX-guard log is assertable.
 */

vi.mock('../../api/_observability', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Stripe from 'stripe'
import { executeEscrowRefundForIntent, MAX_REFUND_AMOUNTS } from '../../api/_escrowRefundService'
import { logWarning } from '../../api/_observability'

const PI_ID = 'pi_service_regression_test'
const CONNECT_ACCOUNT = 'acct_destination_1'
const DISPUTE_ID = 'dispute-1'

// ── Stripe fake ───────────────────────────────────────────────────────────────

function makeStripe() {
  const refundsCreate = vi.fn().mockResolvedValue({ id: 're_mock_1' })
  const paymentIntentsCancel = vi.fn().mockResolvedValue({ id: PI_ID, status: 'canceled' })
  const stripe = {
    paymentIntents: { cancel: paymentIntentsCancel },
    refunds: { create: refundsCreate },
  } as unknown as Stripe
  return { stripe, refundsCreate, paymentIntentsCancel }
}

function makeIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: PI_ID,
    status: 'succeeded',
    currency: 'eur',
    ...overrides,
  } as unknown as Stripe.PaymentIntent
}

function lastRefundParams(refundsCreate: ReturnType<typeof vi.fn>): {
  payment_intent: string
  amount?: number
  reverse_transfer?: boolean
  refund_application_fee?: boolean
  metadata?: Record<string, string>
} {
  const calls = refundsCreate.mock.calls
  return calls[calls.length - 1]?.[0]
}

function lastIdempotencyKey(refundsCreate: ReturnType<typeof vi.fn>): string | undefined {
  const calls = refundsCreate.mock.calls
  return calls[calls.length - 1]?.[1]?.idempotencyKey
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── (a) flag-OFF full refund → separate-charge byte-identical ─────────────────

describe('executeEscrowRefundForIntent — corridor flag OFF', () => {
  it('(a) full refund on a destination-charge PI with flag OFF carries NO corridor params', async () => {
    const { stripe, refundsCreate } = makeStripe()
    // transfer_data IS present, but destinationChargeEnabled:false must keep it inert.
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    const params = lastRefundParams(refundsCreate)
    expect(params.reverse_transfer).toBeUndefined()
    expect(params.refund_application_fee).toBeUndefined()
    expect(params.amount).toBeUndefined()
    expect(params.payment_intent).toBe(PI_ID)
    expect(lastIdempotencyKey(refundsCreate)).toBe(`refund_${PI_ID}_full`)
  })
})

// ── (b) flag-ON destination + FULL → both corridor params ─────────────────────

describe('executeEscrowRefundForIntent — corridor flag ON, destination charge', () => {
  it('(b) FULL refund sets reverse_transfer AND refund_application_fee', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: true,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    const params = lastRefundParams(refundsCreate)
    expect(params.reverse_transfer).toBe(true)
    expect(params.refund_application_fee).toBe(true)
    expect(params.amount).toBeUndefined()
    expect(lastIdempotencyKey(refundsCreate)).toBe(`refund_${PI_ID}_full`)
  })

  it('(c) PARTIAL refund sets reverse_transfer but NOT refund_application_fee and uses the _<amount> key', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: 300, // EUR 300 → 30000 minor units
      disputeId: DISPUTE_ID,
      destinationChargeEnabled: true,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    const params = lastRefundParams(refundsCreate)
    expect(params.reverse_transfer).toBe(true)
    // Platform keeps its fee on a partial (dispute-split) refund.
    expect(params.refund_application_fee).toBeUndefined()
    expect(params.amount).toBe(30_000)
    expect(params.metadata?.disputeId).toBe(DISPUTE_ID)
    expect(lastIdempotencyKey(refundsCreate)).toBe(`refund_${PI_ID}_30000`)
  })

  it('flag ON but PI has NO transfer_data (pre-flip inventory) → no corridor params', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent() // no transfer_data.destination

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: true,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    const params = lastRefundParams(refundsCreate)
    expect(params.reverse_transfer).toBeUndefined()
    expect(params.refund_application_fee).toBeUndefined()
  })
})

// ── Batch 1 additive opt-in params (default-off) ──────────────────────────────
// Omitting the new params keeps the legacy fee + idempotency-key behaviour
// byte-identical (proven by the OFF/ON cases above). These prove the new opt-in
// capabilities the T+80 dispute-default-cut path needs in Batch 2 WITHOUT
// changing any existing caller.

describe('executeEscrowRefundForIntent — additive opt-in params (default-off)', () => {
  it('(a) PARTIAL + refundApplicationFee:true → refund_application_fee true AND amount set', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: 300, // EUR 300 → 30000 minor units
      disputeId: DISPUTE_ID,
      destinationChargeEnabled: true,
      refundApplicationFee: true,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    const params = lastRefundParams(refundsCreate)
    expect(params.amount).toBe(30_000)
    // Caller override wins over the legacy "partial → keep fee" default.
    expect(params.refund_application_fee).toBe(true)
    expect(params.reverse_transfer).toBe(true)
  })

  it('(b) explicit idempotencySuffix pins the key to refund_<pi>_<suffix> (overrides the amount key)', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)
    const suffix = 'default_dispute-1'

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: 300, // would legacy-key to refund_<pi>_30000
      disputeId: DISPUTE_ID,
      destinationChargeEnabled: true,
      idempotencySuffix: suffix,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    expect(lastIdempotencyKey(refundsCreate)).toBe(`refund_${PI_ID}_${suffix}`)
  })

  it('(c) suffix omitted → LEGACY idempotency key preserved exactly (partial _<amount> and full _full)', async () => {
    // Partial, no suffix → amount-based legacy key.
    const partial = makeStripe()
    await executeEscrowRefundForIntent(partial.stripe, makeIntent(), {
      amount: 300,
      destinationChargeEnabled: false,
    })
    expect(lastIdempotencyKey(partial.refundsCreate)).toBe(`refund_${PI_ID}_30000`)

    // Full, no suffix → _full legacy key.
    const full = makeStripe()
    await executeEscrowRefundForIntent(full.stripe, makeIntent(), {
      destinationChargeEnabled: false,
    })
    expect(lastIdempotencyKey(full.refundsCreate)).toBe(`refund_${PI_ID}_full`)
  })

  it('(d) blank idempotencySuffix (empty / whitespace) falls back to the LEGACY amount/full key', async () => {
    // Batch-2 guard on the Batch-1 capability: a blank suffix must NOT produce a
    // degenerate `refund_<pi>_` key — it trims to empty and falls back to legacy.

    // Empty string → full key (no amount).
    const empty = makeStripe()
    await executeEscrowRefundForIntent(empty.stripe, makeIntent(), {
      destinationChargeEnabled: false,
      idempotencySuffix: '',
    })
    expect(lastIdempotencyKey(empty.refundsCreate)).toBe(`refund_${PI_ID}_full`)

    // Whitespace-only → amount key (partial).
    const blank = makeStripe()
    await executeEscrowRefundForIntent(blank.stripe, makeIntent(), {
      amount: 300,
      destinationChargeEnabled: false,
      idempotencySuffix: '   ',
    })
    expect(lastIdempotencyKey(blank.refundsCreate)).toBe(`refund_${PI_ID}_30000`)
  })

  it('refundApplicationFee:false suppresses the fee on a FULL destination refund (default would send it)', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: true,
      refundApplicationFee: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    expect(lastRefundParams(refundsCreate).refund_application_fee).toBeUndefined()
  })

  it('refundApplicationFee override stays dormant flag-OFF (separate-charge PI never carries a fee)', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent({ transfer_data: { destination: CONNECT_ACCOUNT } } as Partial<Stripe.PaymentIntent>)

    await executeEscrowRefundForIntent(stripe, intent, {
      amount: 300,
      destinationChargeEnabled: false, // corridor OFF
      refundApplicationFee: true, // override requested...
    })

    // ...but isDestinationCharge is false, so the fee param is never sent.
    expect(lastRefundParams(refundsCreate).refund_application_fee).toBeUndefined()
  })
})

// ── (d) requires_capture → cancel path ────────────────────────────────────────

describe('executeEscrowRefundForIntent — non-succeeded intent states', () => {
  it('(d) requires_capture → cancels the intent and creates NO refund', async () => {
    const { stripe, refundsCreate, paymentIntentsCancel } = makeStripe()
    const intent = makeIntent({ status: 'requires_capture' })

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'cancelled' })
    expect(paymentIntentsCancel).toHaveBeenCalledTimes(1)
    expect(paymentIntentsCancel).toHaveBeenCalledWith(PI_ID)
    expect(refundsCreate).not.toHaveBeenCalled()
  })

  it('canceled → idempotent no-op, no cancel and no refund', async () => {
    const { stripe, refundsCreate, paymentIntentsCancel } = makeStripe()
    const intent = makeIntent({ status: 'canceled' })

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'already_canceled' })
    expect(paymentIntentsCancel).not.toHaveBeenCalled()
    expect(refundsCreate).not.toHaveBeenCalled()
  })

  it('requires_capture + payment_intent_unexpected_state on cancel → treated as done (idempotent)', async () => {
    const { stripe, refundsCreate, paymentIntentsCancel } = makeStripe()
    const raceErr = new Stripe.errors.StripeInvalidRequestError({
      message: 'unexpected state',
      type: 'invalid_request_error',
    } as unknown as ConstructorParameters<typeof Stripe.errors.StripeInvalidRequestError>[0])
    ;(raceErr as { code?: string }).code = 'payment_intent_unexpected_state'
    paymentIntentsCancel.mockRejectedValueOnce(raceErr)
    const intent = makeIntent({ status: 'requires_capture' })

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      destinationChargeEnabled: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'cancelled' })
    expect(refundsCreate).not.toHaveBeenCalled()
  })
})

// ── (e) MAX exceeded → ok:false httpStatus 400 ────────────────────────────────

describe('executeEscrowRefundForIntent — MAX refund guard', () => {
  it('(e) amount above the per-currency max → { ok:false, httpStatus:400 } and NO refund', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent() // eur
    const overMax = MAX_REFUND_AMOUNTS.eur + 1

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: overMax,
      destinationChargeEnabled: false,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected guard failure')
    expect(outcome.httpStatus).toBe(400)
    expect(String(outcome.body.error)).toMatch(/exceeds maximum allowed for EUR/)
    expect(refundsCreate).not.toHaveBeenCalled()
    expect(logWarning).toHaveBeenCalledWith(
      'api.refund.amount_exceeds_max',
      expect.objectContaining({ amount: overMax, currency: 'eur', paymentIntentId: PI_ID }),
    )
  })

  it('amount exactly at the max is allowed (boundary)', async () => {
    const { stripe, refundsCreate } = makeStripe()
    const intent = makeIntent()

    const outcome = await executeEscrowRefundForIntent(stripe, intent, {
      amount: MAX_REFUND_AMOUNTS.eur,
      destinationChargeEnabled: false,
    })

    expect(outcome).toEqual({ ok: true, mode: 'refunded' })
    expect(refundsCreate).toHaveBeenCalledTimes(1)
    expect(lastRefundParams(refundsCreate).amount).toBe(MAX_REFUND_AMOUNTS.eur * 100)
  })
})
