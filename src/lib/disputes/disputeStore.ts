import { getDisputeRepository } from './repository'
import type { Dispute } from './types'

export function subscribeDisputes(listener: () => void): () => void {
  return getDisputeRepository().subscribe(listener)
}

export function getDisputes(): Dispute[] {
  return getDisputeRepository().getAll()
}

export function getDisputeById(disputeId: string): Dispute | undefined {
  return getDisputeRepository().getById(disputeId)
}

export function isDisputeRepositoryHydrated(): boolean {
  return getDisputeRepository().isHydrated()
}

export function getDisputeByJobId(jobId: string): Dispute | undefined {
  return getDisputeRepository().getByJobId(jobId)
}

export function getDisputesByJobId(jobId: string): Dispute[] {
  return getDisputeRepository().getDisputesByJob(jobId)
}
