import type { NotificationSignal } from '../types'
import type { NotificationRepository } from './NotificationRepository'

type Listener = () => void

export class InMemoryNotificationRepository implements NotificationRepository {
  private signals: NotificationSignal[] = []
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

  getAll(): NotificationSignal[] {
    return [...this.signals]
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .map((s) => ({ ...s }))
  }

  getForJob(jobId: string): NotificationSignal[] {
    return this.signals
      .filter((signal) => signal.jobId === jobId)
      .sort((a, b) => a.occurredAt - b.occurredAt)
      .map((s) => ({ ...s }))
  }

  getUnread(): NotificationSignal[] {
    return this.signals.filter((signal) => !signal.read).map((s) => ({ ...s }))
  }

  hasSignal(id: string): boolean {
    return this.signals.some((s) => s.id === id)
  }

  add(signal: NotificationSignal): void {
    if (this.hasSignal(signal.id)) return

    this.signals = [...this.signals, signal].sort(
      (a, b) => b.occurredAt - a.occurredAt
    )
    this.notify()
  }

  markRead(id: string): void {
    const updated = this.signals.map((signal) =>
      signal.id === id ? { ...signal, read: true } : signal
    )
    if (updated.some((s, i) => s.read !== this.signals[i].read)) {
      this.signals = updated
      this.notify()
    }
  }

  markAllRead(): void {
    const hasUnread = this.signals.some((s) => !s.read)
    if (!hasUnread) return

    this.signals = this.signals.map((signal) => ({ ...signal, read: true }))
    this.notify()
  }
}
