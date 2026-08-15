import type { Job } from './types'
import type { Payment } from '../payments'
import type { Dispute } from '../disputes/types'

/**
 * Describes the terminal outcome type of a completed job.
 * - 'released'  – payment released to craftsman (success path)
 * - 'refunded'  – payment refunded to customer (dispute resolution path)
 * - 'settling'  – a terminal-decision dispute drove completion but the required
 *                 money action has NOT finished settling yet (in-progress)
 * - 'cancelled' – job was cancelled before successful completion
 * - 'none'      – job is not yet in a terminal state
 */
export type JobOutcomeType = 'released' | 'refunded' | 'settling' | 'cancelled' | 'none'

export interface JobOutcomeViewModel {
  outcomeType: JobOutcomeType
  /** True when the job has reached a fully terminal state */
  isTerminal: boolean
  /** Short badge label for the outcome */
  outcomeBadgeLabel: string
  /** Icon for the outcome */
  outcomeIcon: string
  /** Main outcome headline */
  outcomeHeadline: string
  /** Supporting explanation */
  outcomeSubtext: string
  /** Accent color class prefix for styling ('emerald' or 'amber' or 'slate') */
  accentColor: 'emerald' | 'amber' | 'slate'
}

const NOT_TERMINAL: JobOutcomeViewModel = {
  outcomeType: 'none',
  isTerminal: false,
  outcomeBadgeLabel: '',
  outcomeIcon: '',
  outcomeHeadline: '',
  outcomeSubtext: '',
  accentColor: 'slate',
}

/**
 * Derives the terminal outcome view model for a job.
 *
 * Returns a VM with `isTerminal: false` when the job has not yet reached a
 * fully closed state, or when `payment` is absent and `paymentHydrated` is
 * false (fail-closed: stale job.paymentState must not declare a terminal outcome).
 *
 * @param paymentHydrated  Pass `isPaymentRepositoryHydrated()` from the call site.
 *   Defaults to `true` so pure-function / in-memory-repo call sites are unaffected.
 * @param dispute  The job's dispute, when one exists. Carries the settlement truth
 *   (`settlementStatus`): a terminal-decision dispute whose money action has not
 *   completed must show an in-progress outcome, never a terminal released/refunded
 *   story. Omitting it leaves the no-dispute / already-settled paths unchanged.
 */
export function deriveJobOutcome(
  job: Job,
  payment?: Payment,
  paymentHydrated = true,
  dispute?: Dispute,
): JobOutcomeViewModel {
  const isCompleted = job.status === 'completed'
  const isCancelled = job.status === 'cancelled'

  if (isCancelled) {
    return {
      outcomeType: 'cancelled',
      isTerminal: true,
      outcomeBadgeLabel: 'STORNIERT',
      outcomeIcon: '🚫',
      outcomeHeadline: 'Auftrag storniert',
      outcomeSubtext:
        'Dieser Auftrag wurde abgebrochen und ist nicht mehr aktiv.',
      accentColor: 'slate',
    }
  }

  // Fail-closed: payment-dependent terminal outcomes require hydrated truth.
  // Without it, job.paymentState is a stale mirror and must not declare a final story.
  if (!payment && !paymentHydrated) return NOT_TERMINAL

  const paymentState = payment?.state ?? job.paymentState

  // Settlement truth lives on the dispute. A terminal-decision dispute
  // (resolved/closed) whose money action has NOT completed
  // (`settlementStatus !== 'settled'`) means the funds have not actually moved
  // yet — even though `payment.state` may already read released/refunded. In
  // that window show an in-progress outcome, never a terminal "Betrag erstattet"
  // / "erfolgreich abgeschlossen". No dispute or a settled/cancelled dispute
  // leaves the happy/terminal paths below byte-for-byte unchanged.
  const settlementPending =
    !!dispute &&
    (dispute.status === 'resolved' || dispute.status === 'closed') &&
    dispute.settlementStatus !== 'settled'

  if (isCompleted && settlementPending) {
    // Direction follows the dispute DECISION (mirrors deriveCustomerDisputeDisplay):
    // refund/split → money back to the customer; release/reject/none → payout.
    const isRefundDirection = dispute?.decision === 'refund' || dispute?.decision === 'split'
    return {
      outcomeType: 'settling',
      isTerminal: true,
      outcomeBadgeLabel: 'IN ABWICKLUNG',
      outcomeIcon: '⏳',
      outcomeHeadline: 'Auftrag abgeschlossen – Abwicklung läuft',
      outcomeSubtext: isRefundDirection
        ? 'Die Streitbeilegung ist abgeschlossen. Die Rückerstattung wird gerade verarbeitet.'
        : 'Die Streitbeilegung ist abgeschlossen. Die Auszahlung wird gerade verarbeitet.',
      accentColor: 'amber',
    }
  }

  if (isCompleted && paymentState === 'released') {
    return {
      outcomeType: 'released',
      isTerminal: true,
      outcomeBadgeLabel: 'ABGESCHLOSSEN',
      outcomeIcon: '🎉',
      outcomeHeadline: 'Auftrag erfolgreich abgeschlossen',
      outcomeSubtext:
        'Zahlung wurde freigegeben und Auftrag ist vollständig geschlossen.',
      accentColor: 'emerald',
    }
  }

  if (isCompleted && paymentState === 'refunded') {
    return {
      outcomeType: 'refunded',
      isTerminal: true,
      outcomeBadgeLabel: 'ABGESCHLOSSEN',
      outcomeIcon: '↩',
      outcomeHeadline: 'Auftrag abgeschlossen – Betrag erstattet',
      outcomeSubtext:
        'Der Streitfall wurde beigelegt und der Betrag wurde erstattet.',
      accentColor: 'amber',
    }
  }

  return NOT_TERMINAL
}
