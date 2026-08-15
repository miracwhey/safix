import { InMemoryChatRepository } from './InMemoryChatRepository'
import type { ChatRepository } from './ChatRepository'

let activeRepository: ChatRepository = new InMemoryChatRepository()

export function getChatRepository(): ChatRepository {
  return activeRepository
}

export function setChatRepository(repository: ChatRepository): void {
  activeRepository = repository
}

/**
 * Calls `initialize()` on the currently active repository.
 * Must be awaited at application bootstrap before any reads or writes occur.
 * For `InMemoryChatRepository` this resolves immediately.
 * For `SupabaseChatRepository` this loads threads + participants for current user.
 */
export async function initializeChatRepository(forResync = false): Promise<void> {
  if (forResync) {
    ;(activeRepository as { prepareForResync?: () => void }).prepareForResync?.()
  }
  await activeRepository.initialize()
}

export function resetChatRepository(): void {
  ;(activeRepository as { resetState?: () => void }).resetState?.()
}

// Options are forwarded duck-typed: implementations with the legacy
// zero-arg signature simply ignore the extra argument at runtime.
export function restartChatRealtimeIfDead(options?: { force?: boolean }): void {
  ;(activeRepository as { restartRealtimeIfDead?: (options?: { force?: boolean }) => void }).restartRealtimeIfDead?.(options)
}
