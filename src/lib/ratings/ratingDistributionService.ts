/**
 * Rating Distribution Service — Block 2 (Customer-Discovery Profile-Detail)
 *
 * Customer-side reads for a provider's ratings. The local ratings store
 * (registry.ts) only hydrates ratings authored by or for the signed-in user,
 * so the public profile must query Supabase directly to render the
 * ★-Histogramm and the Stimmen-Liste for a foreign provider.
 *
 * RLS (`authenticated_can_read_ratings`) requires an authenticated session.
 */

import { supabase } from '../supabase'
import { logError } from '../observability'

export type RatingDistributionBucket = {
  stars: 1 | 2 | 3 | 4 | 5
  count: number
}

export type ProviderReviewRow = {
  id: string
  jobId: string
  providerUserId: string
  customerUserId: string
  ratingScore: 1 | 2 | 3 | 4 | 5
  ratingComment: string | null
  createdAt: number
  /** First name or short display name of the reviewer; null when unavailable. */
  reviewerDisplayName: string | null
}

const EMPTY_DISTRIBUTION: RatingDistributionBucket[] = [
  { stars: 5, count: 0 },
  { stars: 4, count: 0 },
  { stars: 3, count: 0 },
  { stars: 2, count: 0 },
  { stars: 1, count: 0 },
]

/**
 * Counts ratings per star bucket for a provider. Returns buckets in
 * descending star order (5 → 1) — the order the histogram renders.
 *
 * Returns all-zero buckets on error or when no ratings exist.
 */
export async function fetchProviderRatingDistribution(
  providerUserId: string
): Promise<RatingDistributionBucket[]> {
  if (!providerUserId) return EMPTY_DISTRIBUTION.map((b) => ({ ...b }))

  const { data, error } = await supabase
    .from('ratings')
    .select('rating_score')
    .eq('provider_user_id', providerUserId)

  if (error) {
    logError('rating_distribution.fetch_failed', error, { providerUserId })
    return EMPTY_DISTRIBUTION.map((b) => ({ ...b }))
  }

  const counts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const row of (data ?? []) as { rating_score: number }[]) {
    const score = row.rating_score as 1 | 2 | 3 | 4 | 5
    if (score >= 1 && score <= 5) counts[score]++
  }

  return [
    { stars: 5, count: counts[5] },
    { stars: 4, count: counts[4] },
    { stars: 3, count: counts[3] },
    { stars: 2, count: counts[2] },
    { stars: 1, count: counts[1] },
  ]
}

/**
 * Fetches all ratings for a provider, newest first. Used by the public
 * profile Stimmen-Tab which needs the full list (not just the recent 3
 * served by the local store + RecentReviewsCard).
 */
export async function fetchProviderReviews(
  providerUserId: string,
  limit = 50
): Promise<ProviderReviewRow[]> {
  if (!providerUserId) return []

  const { data, error } = await supabase
    .from('ratings')
    .select('id, job_id, provider_user_id, customer_user_id, rating_score, rating_comment, created_at')
    .eq('provider_user_id', providerUserId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    logError('rating_distribution.reviews_fetch_failed', error, { providerUserId })
    return []
  }

  type RatingRow = {
    id: string
    job_id: string
    provider_user_id: string
    customer_user_id: string
    rating_score: number
    rating_comment: string | null
    created_at: string
  }

  const rows = (data ?? []) as RatingRow[]

  // Batch-fetch reviewer display names from profiles to avoid N+1.
  const distinctIds = [...new Set(rows.map((r) => r.customer_user_id).filter(Boolean))]
  const nameMap = new Map<string, string>()
  if (distinctIds.length > 0) {
    const { data: profileData } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', distinctIds)
    for (const p of (profileData ?? []) as { id: string; display_name: string | null }[]) {
      if (p.display_name) nameMap.set(p.id, p.display_name)
    }
  }

  return rows.map((r) => {
    const fullName = nameMap.get(r.customer_user_id) ?? null
    // Surface only first name for privacy (e.g. "Max Mustermann" → "Max")
    const reviewerDisplayName = fullName ? fullName.split(' ')[0] ?? fullName : null
    return {
      id: r.id,
      jobId: r.job_id,
      providerUserId: r.provider_user_id,
      customerUserId: r.customer_user_id,
      ratingScore: r.rating_score as 1 | 2 | 3 | 4 | 5,
      ratingComment: r.rating_comment,
      createdAt: new Date(r.created_at).getTime(),
      reviewerDisplayName,
    }
  })
}

/**
 * Returns the subset of `jobIds` whose row in `public.jobs` has
 * `status = 'completed'`. Used to render the „✓ Verifiziertes Projekt"-Badge
 * on review entries without an N+1 query per review.
 *
 * RLS may hide jobs the caller is not party to — in that case those jobs
 * silently miss the verified-badge, which is the desired degraded behaviour.
 */
export async function fetchCompletedJobIds(jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set()
  const unique = Array.from(new Set(jobIds.filter((id) => id && id.length > 0)))
  if (unique.length === 0) return new Set()

  const { data, error } = await supabase
    .from('jobs')
    .select('id, status')
    .in('id', unique)

  if (error) {
    logError('rating_distribution.completed_jobs_failed', error, {
      jobCount: unique.length,
    })
    return new Set()
  }

  const result = new Set<string>()
  for (const row of (data ?? []) as { id: string; status: string }[]) {
    if (row.status === 'completed') result.add(row.id)
  }
  return result
}
