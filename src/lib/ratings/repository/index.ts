export type { RatingRepository } from './RatingRepository'
export { InMemoryRatingRepository } from './InMemoryRatingRepository'
export { SupabaseRatingRepository } from './SupabaseRatingRepository'
export { getRatingRepository, setRatingRepository, initializeRatingRepository } from './registry'
