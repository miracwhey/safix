import type { LedgerEntry } from '../ledgerTypes.js'

export interface LedgerRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): LedgerEntry[]
  getForPayment(paymentId: string): LedgerEntry[]
  getForJob(jobId: string): LedgerEntry[]
  add(entry: LedgerEntry): void
  /**
   * Corrects the amount of an existing ledger entry in-place.
   *
   * Only valid for `escrow_created` entries in `deposit_required` state —
   * i.e. before any funds have moved. This keeps GMV aligned with the
   * canonical payment amount when `updatePaymentAmounts` adjusts the total
   * before escrow is locked.
   */
  updateEntryAmount(entryId: string, newAmount: number): void
  subscribe(listener: () => void): () => void
}
