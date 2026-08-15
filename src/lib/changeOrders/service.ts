import type { ChangeOrder } from './types'
import { getChangeOrderRepository } from './repository/registry'

export function getChangeOrdersByJobId(jobId: string): ChangeOrder[] {
  return getChangeOrderRepository().getByJobId(jobId)
}

export function getAcceptedChangeOrderByJobId(jobId: string): ChangeOrder | undefined {
  return getChangeOrderRepository().getAcceptedByJobId(jobId)
}

export function getChangeOrderById(changeOrderId: string): ChangeOrder | undefined {
  return getChangeOrderRepository().getById(changeOrderId)
}

/**
 * Best-effort lazy load of a ChangeOrder not in the user-scoped cache (e.g. a
 * counterparty opening a Nachtrag card / refreshing its status on mount). RLS
 * decides visibility; on success listeners fire and getChangeOrderById resolves.
 */
export function ensureChangeOrderLoaded(changeOrderId: string): Promise<void> {
  return getChangeOrderRepository().ensureLoaded(changeOrderId)
}

export async function addChangeOrder(changeOrder: ChangeOrder): Promise<void> {
  await getChangeOrderRepository().add(changeOrder)
}

export async function updateChangeOrder(
  changeOrderId: string,
  updater: (co: ChangeOrder) => ChangeOrder
): Promise<void> {
  await getChangeOrderRepository().update(changeOrderId, updater)
}

export function subscribeChangeOrders(listener: () => void): () => void {
  return getChangeOrderRepository().subscribe(listener)
}

export function isChangeOrderRepositoryHydrated(): boolean {
  return getChangeOrderRepository().isHydrated()
}
