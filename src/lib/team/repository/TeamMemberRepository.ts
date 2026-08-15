import type { TeamMember } from '../../jobs/types'

/**
 * Repository interface for the team member domain.
 *
 * Follows the same contract used by all other persisted domains:
 * `initialize()` loads the initial dataset, `subscribe()` enables reactive
 * listeners, and the read/write methods operate on a local in-memory cache
 * that is kept in sync with the underlying store.
 */
export interface TeamMemberRepository {
  /** Loads initial data from the underlying store. Must be awaited at bootstrap. */
  initialize(): Promise<void>
  /** True once the initial load has completed. */
  isHydrated(): boolean
  /** Registers a change listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Returns all team members. */
  getAll(): TeamMember[]
  /** Returns the team member with the given id, or undefined if not found. */
  getById(id: string): TeamMember | undefined
  /** Returns the team member whose userId matches the given Supabase user id. */
  getByUserId(userId: string): TeamMember | undefined
  /** Persists a new team member. */
  add(member: TeamMember): void
  /** Applies an updater function to the team member with the given id. */
  update(memberId: string, updater: (m: TeamMember) => TeamMember): void
  /**
   * Resets to initial state. Only meaningful for in-memory implementations;
   * Supabase-backed implementations may treat this as a no-op.
   */
  reset(): void
}
