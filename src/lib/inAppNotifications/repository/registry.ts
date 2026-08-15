import { InMemoryInAppNotificationRepository } from './InMemoryInAppNotificationRepository'
import type { InAppNotificationRepository } from './InAppNotificationRepository'

let activeRepository: InAppNotificationRepository =
  new InMemoryInAppNotificationRepository()

export function getInAppNotificationRepository(): InAppNotificationRepository {
  return activeRepository
}

export function setInAppNotificationRepository(
  repository: InAppNotificationRepository,
): void {
  activeRepository = repository
}

export async function initializeInAppNotificationRepository(
  userId: string,
): Promise<void> {
  await activeRepository.initialize(userId)
}

export function resetInAppNotificationRepository(): void {
  activeRepository.reset()
}

export function restartInAppNotificationRealtimeIfDead(options?: { force?: boolean }): void {
  activeRepository.restartRealtimeIfDead(options)
}
