import type { NotificationSignal } from '../types'

export interface NotificationRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): NotificationSignal[]
  getForJob(jobId: string): NotificationSignal[]
  getUnread(): NotificationSignal[]
  hasSignal(id: string): boolean
  add(signal: NotificationSignal): void
  markRead(id: string): void
  markAllRead(): void
  subscribe(listener: () => void): () => void
  notify(): void
}
