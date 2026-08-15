import { getLedgerRepository } from './repository/index.js'
import type { LedgerEntry, LedgerEntryType } from './ledgerTypes.js'

/**
 * Ledger entry types that must appear at most once per payment.
 *
 * Every payment moves through a single linear lifecycle:
 * escrow_created → deposit_paid → [dispute_hold] →
 *   (released: final_paid + platform_fee + payout)
 *   OR (split: dispute_resolved_release + platform_fee + dispute_resolved_refund)
 *   OR (refunded: refund OR dispute_resolved_refund)
 *
 * None of these paths produce the same type twice for the same payment, so
 * a duplicate is always a sign of a programming error or a race condition.
 * The guard below prevents the duplicate from landing in the repository and
 * logs a warning to aid debugging.
 */
const NON_REPEATING_TYPES = new Set<LedgerEntryType>([
  'escrow_created',
  'deposit_paid',
  'final_paid',
  'platform_fee',
  'payout',
  'refund',
  'dispute_hold',
  'dispute_resolved_release',
  'dispute_resolved_refund',
])

export function createLedgerEntry(params: {
  paymentId: string
  jobId: string
  type: LedgerEntryType
  amount: number
  note?: string
  disputeId?: string
}): LedgerEntry {
  // Idempotency guard: suppress duplicate entries for non-repeating types.
  // Returns the already-existing entry so callers get a valid LedgerEntry
  // regardless of whether a new one was created.
  if (NON_REPEATING_TYPES.has(params.type)) {
    const existing = getLedgerRepository()
      .getForPayment(params.paymentId)
      .find((e) => e.type === params.type)
    if (existing) {
      console.warn(
        `createLedgerEntry: duplicate '${params.type}' entry suppressed for payment ${params.paymentId}`,
      )
      return existing
    }
  }

  // Deterministic IDs for non-repeating types: `ledger_{paymentId}_{type}`.
  // These are DB-idempotent — safe for upsert/retry without creating duplicates.
  // Repeating types (supplementary_*) keep a timestamp suffix for uniqueness.
  const entryId = NON_REPEATING_TYPES.has(params.type)
    ? `ledger_${params.paymentId}_${params.type}`
    : `ledger_${params.paymentId}_${params.type}_${Date.now()}`

  const entry: LedgerEntry = {
    id: entryId,
    paymentId: params.paymentId,
    jobId: params.jobId,
    type: params.type,
    amount: params.amount,
    currency: 'EUR',
    createdAt: Date.now(),
    note: params.note,
    ...(params.disputeId !== undefined ? { disputeId: params.disputeId } : {}),
  }

  getLedgerRepository().add(entry)

  return entry
}

/**
 * Corrects the amount of the `escrow_created` ledger entry for a payment.
 *
 * Must only be called from `updatePaymentAmounts` while the payment is still
 * in `deposit_required` state — i.e. before any funds have moved. This
 * keeps GMV aligned with the canonical payment amount when the agreed total
 * is adjusted before escrow is locked.
 *
 * No-op if no `escrow_created` entry exists for the payment (e.g. legacy or
 * test data that skipped the creation step).
 */
export function correctEscrowCreatedAmount(paymentId: string, newAmount: number): void {
  const existing = getLedgerRepository()
    .getForPayment(paymentId)
    .find((e) => e.type === 'escrow_created')

  if (!existing) return

  getLedgerRepository().updateEntryAmount(existing.id, newAmount)
}
