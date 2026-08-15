import type { Rating, ProviderReputation } from './types'

/**
 * Returns the N most recent ratings for a provider, sorted by `createdAt`
 * descending (newest first).
 *
 * Pure function — no side effects.
 */
export function getRecentRatings(
  providerUserId: string,
  ratings: Rating[],
  limit = 3
): Rating[] {
  return ratings
    .filter((r) => r.providerUserId === providerUserId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function deriveProviderReputation(
  providerUserId: string,
  ratings: Rating[]
): ProviderReputation {
  const providerRatings = ratings.filter((r) => r.providerUserId === providerUserId)

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let total = 0

  for (const r of providerRatings) {
    distribution[r.ratingScore]++
    total += r.ratingScore
  }

  const ratingCount = providerRatings.length
  // Round to one decimal place: multiply by 10, round, then divide back.
  const averageRating = ratingCount > 0 ? Math.round((total / ratingCount) * 10) / 10 : 0

  return { providerUserId, averageRating, ratingCount, ratingDistribution: distribution }
}

export function canSubmitRating(
  job: { id: string; status: string; customerUserId?: string },
  existingRating: Rating | undefined,
  callerUserId: string
): boolean {
  if (job.status !== 'completed') return false
  if (existingRating !== undefined) return false
  if (!job.customerUserId || job.customerUserId !== callerUserId) return false
  return true
}

export function formatAverageRating(reputation: ProviderReputation): string {
  if (reputation.ratingCount === 0) return '–'
  return reputation.averageRating.toFixed(1)
}
