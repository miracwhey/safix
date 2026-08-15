import type { Project } from '../projectTypes'

export interface ProjectRepository {
  /**
   * Loads the initial project data from the underlying store.
   * Must be awaited at application bootstrap before any reads or writes occur.
   * For in-memory implementations this is a no-op.
   */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryProjectRepository this is always `true`.
   * For SupabaseProjectRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  subscribe(listener: () => void): () => void
  getAll(): Project[]
  getById(id: string): Project | undefined
  /**
   * Best-effort lazy load of a single project by id that is NOT in the
   * owner-scoped initial cache. Used when a recipient (e.g. a craftsman) needs
   * a project shared into a chat thread they participate in — RLS
   * (`projects_select_shared_in_chat_thread`) decides whether the row is
   * returned. On success the row is merged into the cache and listeners are
   * notified. No-op if already cached or for in-memory stores. Never throws.
   */
  ensureLoaded(id: string): Promise<void>
  getByJobId(jobId: string): Project | undefined
  add(project: Project): Promise<void>
  update(projectId: string, updates: Partial<Project>): Promise<Project | undefined>
  reset(): void
}
