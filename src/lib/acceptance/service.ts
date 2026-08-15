import type { Acceptance } from './types'
import { getAcceptanceRepository } from './repository/registry'

export function getAcceptanceByJobId(jobId: string): Acceptance | undefined {
  return getAcceptanceRepository().getByJobId(jobId)
}

export function getAcceptanceById(acceptanceId: string): Acceptance | undefined {
  return getAcceptanceRepository().getById(acceptanceId)
}

export async function addAcceptance(acceptance: Acceptance): Promise<void> {
  await getAcceptanceRepository().add(acceptance)
}

export async function updateAcceptance(
  acceptanceId: string,
  updater: (a: Acceptance) => Acceptance
): Promise<void> {
  await getAcceptanceRepository().update(acceptanceId, updater)
}

export function getExpiredPendingAcceptances(nowMs: number): Acceptance[] {
  return getAcceptanceRepository().getExpiredPending(nowMs)
}

export function subscribeAcceptances(listener: () => void): () => void {
  return getAcceptanceRepository().subscribe(listener)
}

export function isAcceptanceRepositoryHydrated(): boolean {
  return getAcceptanceRepository().isHydrated()
}
