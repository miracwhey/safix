/**
 * Remote feature flag (one row of `public.feature_flags`, camelCased).
 * See supabase/migrations/20260629000000_feature_flags.sql for column docs.
 */
export type FeatureFlag = {
  key: string
  enabled: boolean
  /** 0..100 staged rollout; bucketed deterministically by hash(key + user id). */
  rolloutPct: number
  /** App-context role allowlist ('customer'|'owner'|'employee'); empty = all. */
  targetRoles: string[]
  /** Reserved — ignored by the resolver until a region lands on the session. */
  targetRegions: string[]
}

/**
 * Swappable feature-flags repository (mirrors the analytics repository
 * pattern). The Supabase implementation hydrates an in-memory cache at
 * bootstrap and keeps it live via realtime, so reads are synchronous.
 */
export interface FeatureFlagsRepository {
  /** Load all flags into the cache (and, for Supabase, open the live channel). */
  initialize(): Promise<void>
  /** Synchronous cache read; undefined when the flag row is absent. */
  getFlag(key: string): FeatureFlag | undefined
  /** Snapshot of all cached flags (operator/debug surfaces). */
  getAllFlags(): FeatureFlag[]
  /** Subscribe to cache changes (realtime updates). Returns unsubscribe. */
  subscribe(listener: () => void): () => void
  /** True once initialize() has completed at least once. */
  isHydrated(): boolean
}
