import type { Conversation, Message } from '../types'

export interface MessageRepository {
  /**
   * Loads the initial dataset from the underlying store.
   * Must be called once during application bootstrap after the repository
   * is registered via `setMessageRepository()`.
   * For in-memory implementations this is a no-op.
   */
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by screens that need to distinguish between "entity not loaded yet"
   * and "entity genuinely does not exist" without resorting to a timeout.
   *
   * For InMemoryMessageRepository this is always `true` (data is available at
   * construction time).
   * For SupabaseMessageRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  /**
   * Returns a human-readable error string when the last load attempt failed
   * (e.g. Auth/RLS/Session/network error), or `null` when the repository is
   * healthy.  A successful load always clears this back to `null`.
   *
   * Callers must treat a non-null value as a fetch error — never as an
   * "empty" state.  Empty state is only valid when this returns `null` AND
   * the repository is hydrated.
   */
  getLastError(): string | null

  getConversations(): Conversation[]
  getConversationById(id: string): Conversation | undefined
  getConversationByProjectId(id: string): Conversation | undefined
  getMessages(): Message[]
  getMessagesByConversationId(id: string): Message[]
  addConversation(conversation: Conversation): Promise<void>
  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void
  addMessageAndUpdateConversation(
    message: Message,
    conversationId: string,
    conversationPatch: Partial<Omit<Conversation, 'id'>>
  ): Promise<void>
  subscribe(listener: () => void): () => void
}
