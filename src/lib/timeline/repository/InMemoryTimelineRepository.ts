import type { ProjectTimelineEventType, ProjectTimelineSignal } from '../types'
import type { TimelineRepository } from './TimelineRepository'

type Listener = () => void

export class InMemoryTimelineRepository implements TimelineRepository {
  private signals: ProjectTimelineSignal[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // In-memory data is already loaded at construction time
  }

  isHydrated(): boolean {
    return true
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): ProjectTimelineSignal[] {
    return [...this.signals]
  }

  getForJob(jobId: string): ProjectTimelineSignal[] {
    return this.signals
      .filter((signal) => signal.jobId === jobId)
      .sort((a, b) => a.occurredAt - b.occurredAt)
  }

  hasEventOfType(jobId: string, type: ProjectTimelineEventType): boolean {
    return this.signals.some(
      (signal) => signal.jobId === jobId && signal.type === type
    )
  }

  add(signal: ProjectTimelineSignal): void {
    if (this.signals.some((s) => s.id === signal.id)) return
    this.signals = [...this.signals, signal].sort(
      (a, b) => a.occurredAt - b.occurredAt
    )
    this.notify()
  }
}
