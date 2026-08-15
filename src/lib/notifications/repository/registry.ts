import { InMemoryNotificationRepository } from './InMemoryNotificationRepository'
import type { NotificationRepository } from './NotificationRepository'

let activeRepository: NotificationRepository =
  new InMemoryNotificationRepository()

export function getNotificationRepository(): NotificationRepository {
  return activeRepository
}

export function setNotificationRepository(
  repository: NotificationRepository
): void {
  activeRepository = repository
}

export async function initializeNotificationRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

export function restartNotificationRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
