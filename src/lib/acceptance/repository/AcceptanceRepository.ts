import type { Acceptance } from '../types'

export interface AcceptanceRepository {
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load.
   * For InMemoryAcceptanceRepository this is always `true`.
   * For SupabaseAcceptanceRepository this becomes `true` after `initialize()` completes.
   */
  isHydrated(): boolean

  getAll(): Acceptance[]
  getById(acceptanceId: string): Acceptance | undefined
  /** Returns the Acceptance for a given job, if one exists. */
  getByJobId(jobId: string): Acceptance | undefined

  /**
   * Returns all acceptances in 'pending' status whose expiresAt <= now.
   * Used by the auto-release cron to find expired acceptances.
   */
  getExpiredPending(nowMs: number): Acceptance[]

  add(acceptance: Acceptance): Promise<void>
  update(acceptanceId: string, updater: (a: Acceptance) => Acceptance): Promise<void>

  subscribe(listener: () => void): () => void
}
