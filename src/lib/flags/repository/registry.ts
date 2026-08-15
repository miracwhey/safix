import { InMemoryFeatureFlagsRepository } from './InMemoryFeatureFlagsRepository'
import type { FeatureFlagsRepository } from '../types'

let activeRepository: FeatureFlagsRepository = new InMemoryFeatureFlagsRepository()

export function getFeatureFlagsRepository(): FeatureFlagsRepository {
  return activeRepository
}

export function setFeatureFlagsRepository(repository: FeatureFlagsRepository): void {
  activeRepository = repository
}

export async function initializeFeatureFlagsRepository(): Promise<void> {
  await activeRepository.initialize()
}

/**
 * Resume-cascade entry point (called from session.ts handleAppResume). No-op
 * unless the active repository exposes a realtime restart (the Supabase one);
 * the in-memory repo has no channel. Keeps session.ts decoupled from the
 * concrete repository class (no import cycle).
 */
export function restartFeatureFlagsRealtimeIfDead(options?: { force?: boolean }): void {
  const repo = activeRepository as Partial<{
    restartRealtimeIfDead: (o?: { force?: boolean }) => void
  }>
  repo.restartRealtimeIfDead?.(options)
}
