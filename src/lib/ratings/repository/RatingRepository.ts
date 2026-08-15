import type { Rating } from '../types'

export interface RatingRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): Rating[]
  getById(id: string): Rating | undefined
  getByJobId(jobId: string): Rating | undefined
  getByProviderUserId(providerUserId: string): Rating[]
  add(rating: Rating): void
  /**
   * Awaitable insert. Resolves `{ ok: true }` when the rating is durably
   * persisted OR safely queued for replay; resolves `{ ok: false }` when the
   * server rejected the write for a non-retryable reason (and the in-memory
   * optimistic row has been rolled back). Lets the UI defer its success state
   * until persistence is confirmed.
   */
  addAsync(rating: Rating): Promise<{ ok: boolean }>
  subscribe(listener: () => void): () => void
}
