import type { Job } from './types'
import type { Payment } from '../payments'
import type { Dispute } from '../disputes/types'
import { formatEuro } from '../shared/formatters'
import { resolveCanonicalProjectFacts } from '../shared/canonicalProjectFacts'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'

/**
 * Describes the final closed state of a job once payment has been released
 * (or refunded on the dispute path).
 *
 * This view model is only non-null when the job has reached its terminal
 * completion state — i.e. `job.paymentReleasedAt` is set and the job status
 * is `completed`.
 */
export interface JobCompletionSummaryViewModel {
  jobId: string
  jobTitle: string
  customer: string
  location: string

  /** Unix timestamp (ms) when the craftsman marked work complete */
  workCompletedAt: number
  /** Unix timestamp (ms) when the customer released the payment */
  paymentReleasedAt: number

  /** Total agreed amount in cents */
  totalAmount: number
  /** Deposit portion in cents */
  depositAmount: number
  /** Final (remaining) portion in cents */
  finalAmount: number

  /** Human-readable formatted total, e.g. "2.300 €" */
  formattedTotal: string

  /**
   * True when the payment was released through the normal path.
   * False when the job completed via a refund (dispute resolution).
   */
  isFullyPaid: boolean

  /**
   * True when a terminal-decision dispute drove this completion but the
   * required money action has NOT finished settling
   * (`dispute.settlementStatus !== 'settled'`). While true, the customer must
   * see an in-progress money state ("…wird verarbeitet"), never a terminal
   * "Betrag erstattet / Zahlung freigegeben". False for the normal release path
   * (no dispute) and for already-settled / cancelled disputes.
   */
  settlementPending: boolean
  /** During settling, true when the money goes back to the customer
   *  (decision refund/split) rather than to the craftsman (release/reject). */
  settlementIsRefund: boolean

  /** Primary headline shown on the completion card */
  headline: string
  /** Supporting paragraph describing the closure */
  summary: string
  /** Short badge label, e.g. "ABGESCHLOSSEN" */
  badgeLabel: string
}

/**
 * Derives the final completion summary view model for a job.
 *
 * Returns `null` when the job has not yet reached the fully-closed state.
 *
 * Two terminal paths are supported:
 * 1. Release path  – `job.paymentReleasedAt` is set (normal success path)
 * 2. Refund path   – `job.status === 'completed'` AND `payment.state === 'refunded'`
 *    On this path `paymentReleasedAt` is never set; `payment.updatedAt` is used
 *    as the effective closed-at timestamp.
 */
export function deriveJobCompletionSummary(
  job: Job,
  payment?: Payment,
  dispute?: Dispute,
): JobCompletionSummaryViewModel | null {
  const paymentState = payment?.state ?? job.paymentState

  // On the refund path (dispute resolution), `paymentReleasedAt` is never
  // stamped on the job. Fall back to `payment.updatedAt` when the job is
  // in the completed+refunded terminal state.
  const isRefundTerminal =
    job.status === 'completed' && paymentState === 'refunded' && !!payment?.updatedAt

  const effectivePaymentReleasedAt = job.paymentReleasedAt ?? (isRefundTerminal ? payment!.updatedAt : undefined)
  const effectiveWorkCompletedAt = job.workCompletedAt ?? (isRefundTerminal ? payment!.updatedAt : undefined)

  // Neither release path nor refund path is satisfied — job is not terminal
  if (!effectivePaymentReleasedAt || !effectiveWorkCompletedAt) return null

  const isFullyPaid = payment?.state === 'released'

  // Settlement truth lives on the dispute, not the payment. A terminal-decision
  // dispute (resolved/closed) whose money action has NOT completed
  // (`settlementStatus !== 'settled'`) means the funds have not actually moved
  // yet — even though `payment.state` may already read released/refunded. In
  // that window we must show an in-progress money state, never a terminal
  // "Betrag erstattet / Zahlung freigegeben". No dispute (normal release) or a
  // settled/cancelled dispute means money has moved → happy/terminal path stays
  // intact. `cancelled` is excluded by the resolved/closed status check.
  const settlementPending =
    !!dispute &&
    (dispute.status === 'resolved' || dispute.status === 'closed') &&
    dispute.settlementStatus !== 'settled'

  // Settling money DIRECTION follows the dispute DECISION (not payment.state,
  // which may read released/refunded before funds actually move): refund/split →
  // back to the customer (Erstattung); release/reject/none → to the craftsman
  // (Auszahlung). Exposed so every settling surface agrees on direction.
  const settlementIsRefund =
    settlementPending && (dispute?.decision === 'refund' || dispute?.decision === 'split')

  // Canonical display — no payment.amounts fallback for display amounts.
  const canonical = resolveCanonicalAmount(job.id)
  const totalAmount = canonical.amount ?? 0
  const depositAmount = 0  // not meaningful as a display concept (full-upfront)
  const finalAmount = 0    // not meaningful as a display concept (full-upfront)

  let headline: string
  let summary: string
  if (settlementPending) {
    // While settling, the money DIRECTION follows the dispute DECISION, not
    // `isFullyPaid` (payment.state may already read released/refunded before the
    // funds have actually moved). refund/split → money back to the customer
    // (Erstattung); release/reject/none → money to the craftsman (Auszahlung).
    // This mirrors the sibling deriveCustomerDisputeDisplay so every settling
    // surface agrees.
    if (settlementIsRefund) {
      headline = 'Auftrag abgeschlossen – Erstattung wird verarbeitet'
      summary = 'Die Arbeit wurde abgeschlossen. Die Rückerstattung im Rahmen der Streitbeilegung wird derzeit durchgeführt.'
    } else {
      headline = 'Auftrag abgeschlossen – Auszahlung wird verarbeitet'
      summary = 'Die Arbeit wurde fertiggestellt. Die Auszahlung an den Betrieb wird derzeit durchgeführt.'
    }
  } else if (isFullyPaid) {
    headline = 'Auftrag erfolgreich abgeschlossen'
    summary = 'Die Arbeit wurde fertiggestellt und die Zahlung freigegeben. Der Auftrag ist vollständig abgeschlossen und die Auszahlung ist gesichert.'
  } else {
    headline = 'Auftrag abgeschlossen – Betrag erstattet'
    summary = 'Die Arbeit wurde fertiggestellt. Der Betrag wurde im Rahmen der Streitbeilegung erstattet. Der Auftrag ist damit abgeschlossen.'
  }

  // Use canonical facts for customer/location/title to avoid weak placeholders
  // on the completion card when stronger project/offer context exists.
  const canonicalFacts = resolveCanonicalProjectFacts(job.id)

  const formattedTotal =
    totalAmount > 0
      ? formatEuro(totalAmount)
      : canonicalFacts?.canonicalAmount?.formatted
        ? canonicalFacts.canonicalAmount.formatted
        : job.amount.trim() !== ''
          ? job.amount
          : ''

  return {
    jobId: job.id,
    jobTitle: canonicalFacts?.title ?? job.title,
    customer: (canonicalFacts?.customer ?? job.customer) || '–',
    location: canonicalFacts?.location ?? job.location,
    workCompletedAt: effectiveWorkCompletedAt,
    paymentReleasedAt: effectivePaymentReleasedAt,
    totalAmount,
    depositAmount,
    finalAmount,
    formattedTotal,
    isFullyPaid,
    settlementPending,
    settlementIsRefund,
    headline,
    summary,
    badgeLabel: settlementPending ? 'IN ABWICKLUNG' : 'ABGESCHLOSSEN',
  }
}
