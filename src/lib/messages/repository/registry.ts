import { InMemoryMessageRepository } from './InMemoryMessageRepository'
import type { MessageRepository } from './MessageRepository'

let activeRepository: MessageRepository = new InMemoryMessageRepository()

export function getMessageRepository(): MessageRepository {
  return activeRepository
}

export function setMessageRepository(repository: MessageRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryMessageRepository` this resolves immediately.
 * For `SupabaseMessageRepository` this loads the initial dataset from the database.
 */
export async function initializeMessageRepository(forResync = false): Promise<void> {
  if (forResync) { (activeRepository as { prepareForResync?: () => void }).prepareForResync?.() }
  await activeRepository.initialize()
}

// Options are forwarded duck-typed: implementations with the legacy
// zero-arg signature simply ignore the extra argument at runtime.
export function restartMessageRealtimeIfDead(options?: { force?: boolean }): void {
  (activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
