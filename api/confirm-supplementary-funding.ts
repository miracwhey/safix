import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { secureCompare } from './_secureCompare.js'
import { authenticateRequest } from './_auth.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logError, logInfo, logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { executeEscrowRefundForIntent } from './_escrowRefundService.js'

/**
 * Server-side Supplementary Funding Confirmation Endpoint
 *
 * POST /api/confirm-supplementary-funding
 *
 * Transitions a supplementary payment request to 'funded' after successful
 * Stripe payment.
 *
 * Authorization — dual auth (either path accepted):
 *   1. FUNDING_CONFIRM_SECRET header — server-to-server (webhook/cron)
 *   2. Supabase JWT — authenticated browser calls (customer)
 *
 * Payment verification (H9): BOTH auth paths verify the PaymentIntent
 * against Stripe before the DB write — status must be 'succeeded' and the
 * PI metadata (stamped by api/initiate-supplementary-funding.ts) must bind
 * it to THIS supplementary payment request. Fail-closed.
 *
 * Idempotent: safe to call multiple times.
 */

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

  // Dual auth
  const serverSecret = process.env.FUNDING_CONFIRM_SECRET
  const providedSecret = req.headers['x-funding-confirm-secret']
  const hasServerSecret =
    !!serverSecret &&
    typeof providedSecret === 'string' &&
    secureCompare(providedSecret, serverSecret)

  let authenticatedUserId: string | null = null

  if (!hasServerSecret) {
    const auth = await authenticateRequest(req)
    if (auth.ok === false) {
      res.status(auth.statusCode).json({ error: auth.error })
      return
    }
    authenticatedUserId = auth.userId
    if (await applyRateLimit(res, 'critical', auth.userId)) return
  }

  const { paymentIntentId, supplementaryPaymentId } = req.body as {
    paymentIntentId: unknown
    supplementaryPaymentId: unknown
  }

  if (!paymentIntentId || typeof paymentIntentId !== 'string') {
    res.status(400).json({ error: 'paymentIntentId is required.' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.confirm_supplementary_funding.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({ error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}` })
    return
  }

  const supabase = adminResult.client

  // ── Stripe secret key — required for PaymentIntent verification ────────────
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.confirm_supplementary_funding.stripe_key_missing', undefined, {
      paymentIntentId: paymentIntentId.trim(),
    })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  try {
    // ── Resolve supplementary payment request ────────────────────────────
    let resolvedId = typeof supplementaryPaymentId === 'string' ? supplementaryPaymentId.trim() : ''

    if (!resolvedId) {
      // Look up by external_ref (PaymentIntent ID)
      const { data: row } = await supabase
        .from('supplementary_payment_requests')
        .select('id')
        .eq('external_ref', paymentIntentId.trim())
        .maybeSingle()

      if (row) {
        resolvedId = row.id
      }
    }

    if (!resolvedId) {
      logWarning('api.confirm_supplementary_funding.not_found', {
        paymentIntentId: paymentIntentId.trim(),
      })
      res.status(404).json({ error: 'No supplementary payment request found for this payment.' })
      return
    }

    // ── Ownership check (JWT path only) ──────────────────────────────────
    if (authenticatedUserId) {
      const { data: ownerRow } = await supabase
        .from('supplementary_payment_requests')
        .select('customer_user_id')
        .eq('id', resolvedId)
        .maybeSingle()

      if (!ownerRow || ownerRow.customer_user_id !== authenticatedUserId) {
        logWarning('api.confirm_supplementary_funding.ownership_denied', {
          userId: authenticatedUserId,
          supplementaryPaymentId: resolvedId,
        })
        res.status(403).json({ error: 'Forbidden: you are not the customer for this payment request.' })
        return
      }
    }

    // ── Stripe PaymentIntent verification (H9) — fail closed ─────────────
    // The request may only transition to 'funded' when the PaymentIntent
    // has actually been captured ('succeeded') AND its metadata binds it to
    // THIS supplementary payment request. Applies to BOTH auth paths (JWT
    // and server secret): Stripe is the truth, not the caller string.
    let intent: Stripe.PaymentIntent
    try {
      intent = await getStripe(secretKey).paymentIntents.retrieve(paymentIntentId.trim())
    } catch (stripeErr: unknown) {
      const detail = stripeErr instanceof Error ? stripeErr.message : String(stripeErr)
      logError('api.confirm_supplementary_funding.intent_retrieve_failed', stripeErr instanceof Error ? stripeErr : undefined, {
        paymentIntentId: paymentIntentId.trim(),
        supplementaryPaymentId: resolvedId,
      })
      res.status(502).json({ error: `Failed to retrieve funding PaymentIntent: ${detail}` })
      return
    }

    if (intent.status !== 'succeeded') {
      logWarning('api.confirm_supplementary_funding.intent_not_succeeded', {
        paymentIntentId: paymentIntentId.trim(),
        supplementaryPaymentId: resolvedId,
        intentStatus: intent.status,
      })
      res.status(409).json({
        error: `Funding PaymentIntent is not in 'succeeded' state (current: '${intent.status}'). Payment may not be captured.`,
        code: 'INTENT_NOT_CAPTURED',
      })
      return
    }

    // Metadata binding — api/initiate-supplementary-funding.ts stamps every
    // supplementary funding PI with type='supplementary_funding' +
    // supplementaryPaymentId.
    const md = (intent.metadata ?? {}) as Record<string, string | undefined>
    const mdSupplementaryPaymentId = (md.supplementaryPaymentId ?? '').trim()
    const metadataMismatch =
      md.type !== 'supplementary_funding' ||
      mdSupplementaryPaymentId !== resolvedId

    if (metadataMismatch) {
      logWarning('api.confirm_supplementary_funding.pi_metadata_mismatch', {
        paymentIntentId: paymentIntentId.trim(),
        supplementaryPaymentId: resolvedId,
        metadataType: md.type ?? null,
        metadataSupplementaryPaymentId: mdSupplementaryPaymentId,
      })
      res.status(409).json({
        error: 'PaymentIntent does not belong to this supplementary payment request.',
        code: 'PI_METADATA_MISMATCH',
      })
      return
    }

    // ── Transition to funded ─────────────────────────────────────────────
    const nowMs = Date.now()

    const { data: updatedRows, error: updateError } = await supabase
      .from('supplementary_payment_requests')
      .update({
        status: 'funded',
        external_ref: paymentIntentId.trim(),
        funded_at: nowMs,
        updated_at: nowMs,
      })
      .eq('id', resolvedId)
      .in('status', ['pending', 'acknowledged', 'funding_initiated'])
      .select('id')

    if (updateError) {
      logError('api.confirm_supplementary_funding.update_failed', updateError, {
        supplementaryPaymentId: resolvedId,
      })
      res.status(500).json({ error: `Funding confirmation failed: ${updateError.message}` })
      return
    }

    if (!updatedRows || updatedRows.length === 0) {
      // H1 — the guarded UPDATE matched no row: the request already left the
      // fundable states. Never report success blindly; decide idempotent-OK vs
      // terminal-refund from the CURRENT row state.
      const { data: currentRow, error: currentError } = await supabase
        .from('supplementary_payment_requests')
        .select('status, external_ref, original_payment_id, job_id')
        .eq('id', resolvedId)
        .maybeSingle()

      if (currentError) {
        logError('api.confirm_supplementary_funding.state_fetch_failed', currentError, {
          paymentIntentId: paymentIntentId.trim(),
          supplementaryPaymentId: resolvedId,
        })
        res.status(500).json({ error: 'Funding confirmation failed: could not verify request state.' })
        return
      }

      if (!currentRow) {
        // The request row vanished (hard-deleted, e.g. account cascade) between
        // the UPDATE and this read, yet the PI is captured ('succeeded' asserted
        // above). No row means the money can never be released against a request
        // — refund it so captured funds are not stranded (money-guard: no captured
        // money without a refund path). The row is gone, so no ledger linkage is
        // possible; the refund idempotency key (refund_<pi>_*) still blocks a
        // double refund on retry. A refund failure returns 500 so the caller
        // retries rather than silently 404-ing over stranded money.
        try {
          await executeEscrowRefundForIntent(getStripe(secretKey), intent, {
            destinationChargeEnabled: process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true',
          })
          logWarning('api.confirm_supplementary_funding.not_found_refunded', {
            paymentIntentId: paymentIntentId.trim(),
            supplementaryPaymentId: resolvedId,
          })
        } catch (refundErr: unknown) {
          logError(
            'api.confirm_supplementary_funding.not_found_refund_failed',
            refundErr instanceof Error ? refundErr : undefined,
            { paymentIntentId: paymentIntentId.trim(), supplementaryPaymentId: resolvedId },
          )
          res.status(500).json({
            error: 'Supplementary payment request no longer exists and the captured payment could not be refunded. Please retry.',
          })
          return
        }
        res.status(404).json({
          error: 'No supplementary payment request found for this payment. The captured payment is being refunded.',
        })
        return
      }

      // Idempotent retry (client and webhook both confirm): the SAME
      // PaymentIntent already funded this request — success, nothing to move.
      // 'released' is downstream of 'funded' (transfer already executed).
      const alreadyFundedByThisIntent =
        (currentRow.status === 'funded' || currentRow.status === 'released') &&
        currentRow.external_ref === paymentIntentId.trim()

      if (alreadyFundedByThisIntent) {
        logInfo('api.confirm_supplementary_funding.already_funded', {
          paymentIntentId: paymentIntentId.trim(),
          supplementaryPaymentId: resolvedId,
          currentStatus: currentRow.status,
        })
        res.status(200).json({
          status: 'funded',
          supplementaryPaymentId: resolvedId,
        })
        return
      }

      // Terminal without this PI's money (waived / paid off-platform / funded by
      // a different PI). The PI is captured ('succeeded' asserted above) but the
      // request will never release against it — refund so the money is not
      // stranded. Covers the race with waiveSupplementaryPayment, which flips
      // the row terminal but never cancels the PaymentIntent.
      const destinationChargeEnabled = process.env.FUNDING_DESTINATION_CHARGE_ENABLED === 'true'
      try {
        const refund = await executeEscrowRefundForIntent(getStripe(secretKey), intent, {
          destinationChargeEnabled,
        })
        logWarning('api.confirm_supplementary_funding.terminal_state_refunded', {
          paymentIntentId: paymentIntentId.trim(),
          supplementaryPaymentId: resolvedId,
          currentStatus: currentRow.status,
          refundMode: refund.ok ? refund.mode : 'refused',
        })

        // Book the refund into the formal ledger so the money movement is
        // auditable — the intent was captured ('succeeded' asserted above), so a
        // successful refund actually moved money and must not exist only in the
        // observability log. movement_ref = PI id makes the row idempotent per
        // PI-refund (dedupes on the (payment_id, entry_type, movement_ref) unique
        // key, matching the client/webhook retry that shares the same PI).
        // Non-fatal: the refund already succeeded; a ledger miss is reconcilable.
        if (refund.ok && refund.mode === 'refunded' && currentRow.original_payment_id) {
          const refundedMinor = intent.amount_received ?? intent.amount ?? 0
          const { error: ledgerError } = await supabase.from('ledger_entries').upsert(
            {
              payment_id: currentRow.original_payment_id,
              job_id: currentRow.job_id ?? null,
              entry_type: 'refund',
              amount: Number((refundedMinor / 100).toFixed(2)),
              currency: (intent.currency ?? 'eur').toUpperCase(),
              movement_ref: paymentIntentId.trim(),
              metadata: {
                note: `Nachtrag-Zahlung zurückerstattet (nicht mehr förderbar) [${resolvedId}]`,
                spr_id: resolvedId,
                terminal_status: currentRow.status,
              },
            },
            { onConflict: 'payment_id,entry_type,movement_ref', ignoreDuplicates: true },
          )
          if (ledgerError) {
            logError('api.confirm_supplementary_funding.refund_ledger_write_failed', undefined, {
              paymentIntentId: paymentIntentId.trim(),
              supplementaryPaymentId: resolvedId,
              error: ledgerError.message,
            })
          }
        }
      } catch (refundErr: unknown) {
        // Unlike confirm-funding's job_terminal branch there is NO webhook path
        // that refunds supplementary PIs — a failed refund here would strand the
        // captured money. Return 500 so the caller retries; the refund
        // idempotency key is stable per PI, so a retry cannot double-refund.
        logError(
          'api.confirm_supplementary_funding.terminal_state_refund_failed',
          refundErr instanceof Error ? refundErr : undefined,
          {
            paymentIntentId: paymentIntentId.trim(),
            supplementaryPaymentId: resolvedId,
            currentStatus: currentRow.status,
          },
        )
        res.status(500).json({
          error: 'Supplementary payment request is no longer fundable and the refund could not be completed. Please retry.',
        })
        return
      }

      res.status(409).json({
        error: `Supplementary payment request is no longer fundable (current status: '${currentRow.status}'). The captured payment is being refunded.`,
        code: 'REQUEST_NOT_FUNDABLE',
      })
      return
    }

    logInfo('api.confirm_supplementary_funding.success', {
      paymentIntentId: paymentIntentId.trim(),
      supplementaryPaymentId: resolvedId,
    })

    res.status(200).json({
      status: 'funded',
      supplementaryPaymentId: resolvedId,
    })
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('api.confirm_supplementary_funding.unexpected_error', err instanceof Error ? err : undefined, {
      paymentIntentId,
    })
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
