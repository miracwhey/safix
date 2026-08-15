/**
 * Repository Readiness — Shared Hydration Utilities
 *
 * Provides a deterministic way to check whether one or more repositories
 * have completed their initial data load.  Screens that depend on multiple
 * truth sources must use `areRepositoriesHydrated()` to gate "not found"
 * and "empty" decisions.
 *
 * Readiness contract:
 * - A repository is "hydrated" when its `isHydrated()` returns `true`,
 *   meaning `initialize()` has resolved at least once.
 * - InMemory repositories are always hydrated at construction time.
 * - Supabase-backed repositories become hydrated after their first
 *   successful `initialize()` call, even if the result is an empty set
 *   or the user is not authenticated.
 * - "not found" is only valid after all relevant repositories are hydrated.
 * - "empty" messaging is only valid after all relevant repositories are hydrated.
 * - Subscribers must re-evaluate after hydration completion (repository
 *   `notify()` is called after hydration, which triggers subscriptions).
 */

/**
 * Returns `true` when every readiness check in the provided array returns
 * `true`.  Pass the domain-specific `isXxxRepositoryHydrated` functions
 * that the calling screen depends on.
 *
 * @example
 * ```ts
 * const ready = areRepositoriesHydrated([
 *   isJobRepositoryHydrated,
 *   isPaymentRepositoryHydrated,
 *   isEscrowPlanRepositoryHydrated,
 * ])
 * if (!ready) return <LoadingSpinner />
 * ```
 */
export function areRepositoriesHydrated(checks: Array<() => boolean>): boolean {
  return checks.every((check) => check())
}
