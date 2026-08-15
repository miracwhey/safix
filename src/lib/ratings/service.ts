import type { Rating } from './types'
import { getRatingRepository } from './repository/registry'

export function getRatings(): Rating[] {
  return getRatingRepository().getAll()
}

export function getRatingById(id: string): Rating | undefined {
  return getRatingRepository().getById(id)
}

export function getRatingByJobId(jobId: string): Rating | undefined {
  return getRatingRepository().getByJobId(jobId)
}

export function getRatingsByProviderUserId(providerUserId: string): Rating[] {
  return getRatingRepository().getByProviderUserId(providerUserId)
}

export function addRating(rating: Rating): void {
  getRatingRepository().add(rating)
}

export function addRatingAsync(rating: Rating): Promise<{ ok: boolean }> {
  return getRatingRepository().addAsync(rating)
}

export function subscribeRatings(listener: () => void): () => void {
  return getRatingRepository().subscribe(listener)
}

export function isRatingsHydrated(): boolean {
  return getRatingRepository().isHydrated()
}
