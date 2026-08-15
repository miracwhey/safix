import { getLedgerRepository } from './repository/index.js'
import type { LedgerEntry } from './ledgerTypes.js'

export function isLedgerRepositoryHydrated(): boolean {
  return getLedgerRepository().isHydrated()
}

export function subscribeLedger(listener: () => void): () => void {
  return getLedgerRepository().subscribe(listener)
}

export function getLedger(): LedgerEntry[] {
  return getLedgerRepository().getAll()
}

export function getLedgerForPayment(paymentId: string): LedgerEntry[] {
  return getLedgerRepository().getForPayment(paymentId)
}

export function getLedgerForJob(jobId: string): LedgerEntry[] {
  return getLedgerRepository().getForJob(jobId)
}
