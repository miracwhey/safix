import type { Rating } from '../types'
import type { RatingRepository } from './RatingRepository'

type Listener = () => void

export class InMemoryRatingRepository implements RatingRepository {
  private ratings: Rating[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Rating[] = []) {
    this.ratings = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded at construction time
  }

  isHydrated(): boolean {
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Rating[] {
    return [...this.ratings]
  }

  getById(id: string): Rating | undefined {
    return this.ratings.find((rating) => rating.id === id)
  }

  getByJobId(jobId: string): Rating | undefined {
    return this.ratings.find((rating) => rating.jobId === jobId)
  }

  getByProviderUserId(providerUserId: string): Rating[] {
    return this.ratings.filter((rating) => rating.providerUserId === providerUserId)
  }

  add(rating: Rating): void {
    this.ratings = [rating, ...this.ratings]
    this.notify()
  }

  async addAsync(rating: Rating): Promise<{ ok: boolean }> {
    this.add(rating)
    return { ok: true }
  }
}
