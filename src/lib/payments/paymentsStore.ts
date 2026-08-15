import { getPaymentRepository } from './repository/index.js'
import type { Payment } from './types.js'

export function subscribePayments(listener: () => void): () => void {
  return getPaymentRepository().subscribe(listener)
}

export function getPayments(): Payment[] {
  return getPaymentRepository().getAll()
}

export function getPaymentForJob(jobId: string): Payment | undefined {
  return getPaymentRepository().getByJobId(jobId)
}
