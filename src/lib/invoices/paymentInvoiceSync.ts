import type { PaymentState } from '../shared/coreTypes'
import type { InvoiceStatus } from './types'

/**
 * Maps a payment state to the target invoice status for the monotonic
 * sync performed by syncInvoiceWithPayment().
 *
 * syncInvoiceWithPayment() advances the invoice status step-by-step through
 * the ordered sequence ['draft', 'issued', 'sent', 'paid']. This sequence
 * deliberately excludes 'cancelled', so any mapping that returns 'cancelled'
 * results in a no-op (targetIdx === -1 → early return).
 *
 * ── Draft protection (critical) ──────────────────────────────────────────
 * 'deposit_required' now maps to 'draft' instead of 'issued'. Combined with
 * the hard draft guard in syncInvoiceWithPayment(), this ensures that invoice
 * issuance is NEVER driven automatically by payment sync. A craftsman must
 * explicitly call issueInvoiceWorkflow() to move a draft to 'issued'.
 *
 * The hard guard in syncInvoiceWithPayment() provides a second, independent
 * layer of protection: even if this mapping were changed, a draft invoice
 * would still be blocked from automatic advancement by the guard.
 *
 * ── Refund behaviour (important) ─────────────────────────────────────────
 * 'refunded' maps to 'cancelled' semantically, but because 'cancelled' is
 * excluded from the sync step-order, calling syncInvoiceWithPayment() after
 * a refund is a deliberate no-op: a paid invoice stays 'paid'.
 *
 * This is correct accounting behaviour. A payment refund does not retroactively
 * void the invoice — that requires an explicit credit note (Block 4). The
 * no-op is additionally protected at the engine level: transitionInvoiceStatus()
 * throws on 'paid → cancelled' because 'paid' is a terminal state.
 *
 * Two layers of protection:
 *   1. syncInvoiceWithPayment step-order excludes 'cancelled' → no transition attempted
 *   2. transitionInvoiceStatus throws on paid → cancelled → engine-level hard block
 * ─────────────────────────────────────────────────────────────────────────
 */
export function mapPaymentStateToInvoiceStatus(
  paymentState: PaymentState
): InvoiceStatus {
  // 'deposit_required' deliberately maps to 'draft'.
  // Payment sync must never auto-issue a draft — only issueInvoiceWorkflow() may do that.
  if (paymentState === 'deposit_required') {
    return 'draft'
  }

  if (
    paymentState === 'deposit_paid' ||
    paymentState === 'in_escrow' ||
    paymentState === 'work_in_progress' ||
    paymentState === 'release_pending' ||
    paymentState === 'disputed'
  ) {
    return 'sent'
  }

  if (paymentState === 'released') {
    return 'paid'
  }

  // 'refunded': maps to 'cancelled' semantically, but this is intentionally
  // a no-op in syncInvoiceWithPayment — see JSDoc above.
  if (paymentState === 'refunded') {
    return 'cancelled'
  }

  return 'draft'
}
