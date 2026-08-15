import type { JobFeedback } from '../types'
import type { FeedbackRepository } from './FeedbackRepository'

type Listener = () => void

/**
 * In-memory implementation of FeedbackRepository.
 *
 * Used as the default for development / test environments.
 * Starts empty — no mock seed data because feedback is customer-generated
 * at job completion time.
 */
export class InMemoryFeedbackRepository implements FeedbackRepository {
  private feedbacks: JobFeedback[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // In-memory data is already empty at construction time; nothing to load.
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

  getByJobId(jobId: string): JobFeedback | undefined {
    return this.feedbacks.find((f) => f.jobId === jobId)
  }

  getByCraftsmanId(craftsmanUserId: string): JobFeedback[] {
    return this.feedbacks.filter((f) => f.craftsmanUserId === craftsmanUserId)
  }

  save(feedback: JobFeedback): void {
    const idx = this.feedbacks.findIndex((f) => f.jobId === feedback.jobId)
    if (idx >= 0) {
      this.feedbacks[idx] = feedback
    } else {
      this.feedbacks = [...this.feedbacks, feedback]
    }
    this.notify()
  }

  /** Clears all stored feedbacks. Only meaningful in tests. */
  reset(): void {
    this.feedbacks = []
    this.notify()
  }
}
