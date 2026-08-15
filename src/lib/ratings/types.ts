export type Rating = {
  id: string
  jobId: string
  providerUserId: string
  customerUserId: string
  ratingScore: 1 | 2 | 3 | 4 | 5
  ratingComment?: string
  createdAt: number // unix ms
}

export type ProviderReputation = {
  providerUserId: string
  averageRating: number
  ratingCount: number
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>
}

export type RatingSubmission = {
  jobId: string
  providerUserId: string
  customerUserId: string
  ratingScore: 1 | 2 | 3 | 4 | 5
  ratingComment?: string
}
