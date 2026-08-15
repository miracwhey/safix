/**
 * Canonical ViewModel for a single provider from the Discovery read-path.
 *
 * Combines data from `providers` (business data) and `profiles` (auth/onboarding
 * data) into a single flat type for use in Explore, Search, and Provider Profile
 * surfaces.
 *
 * DB relationship: providers.profile_id → profiles.id
 */
export type DiscoveryProvider = {
  /** providers.id */
  id: string
  /** providers.profile_id = profiles.id – used as the canonical provider identity key */
  profileId: string
  /** providers.company_name */
  companyName: string
  /** profiles.display_name */
  displayName: string | null
  /** providers.description */
  description: string | null
  /** providers.city */
  city: string | null
  /** providers.trade_categories */
  tradeCategories: string[]
  /** providers.avatar_url */
  avatarUrl: string | null
  /** providers.rating */
  rating: number | null
  /** Number of individual ratings that contributed to `rating`.
   *  Defaults to 0 when no count data is available from the DB row. */
  ratingCount: number
  /** providers.verified */
  verified: boolean
  /** providers.is_public */
  isPublic: boolean
  /** profiles.onboarding_done */
  onboardingDone: boolean
  /** profiles.craftsman_role */
  craftsmanRole: string | null
  /** profiles.is_operator */
  isOperator: boolean
  /** providers.handle — user-set @username (null until onboarding sets it) */
  handle: string | null
  /** providers.created_at (unix ms) */
  createdAt: number
  /** providers.updated_at (unix ms) */
  updatedAt: number
}
