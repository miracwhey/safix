import type { DomainReactionEvent, ReactionCategory, ReactionHandler } from './types'

type CategoryListenerMap = Map<ReactionCategory, Set<ReactionHandler>>

const globalListeners = new Set<ReactionHandler>()
const categoryListeners: CategoryListenerMap = new Map()

/**
 * Subscribes to all domain reaction events.
 * Returns an unsubscribe function.
 */
export function subscribeToReactions(handler: ReactionHandler): () => void {
  globalListeners.add(handler)
  return () => {
    globalListeners.delete(handler)
  }
}

/**
 * Subscribes to domain reaction events for a specific category.
 * Returns an unsubscribe function.
 */
export function subscribeToReactionCategory(
  category: ReactionCategory,
  handler: ReactionHandler
): () => void {
  if (!categoryListeners.has(category)) {
    categoryListeners.set(category, new Set())
  }
  categoryListeners.get(category)!.add(handler)
  return () => {
    categoryListeners.get(category)?.delete(handler)
  }
}

/**
 * Emits a reaction event to all matching subscribers.
 * Called by the reaction bridge; domain code should not call this directly.
 */
export function emitReactionEvent(event: DomainReactionEvent): void {
  globalListeners.forEach((handler) => handler(event))
  categoryListeners.get(event.category)?.forEach((handler) => handler(event))
}

/**
 * Removes all registered listeners.
 * Primarily useful for testing and cleanup.
 */
export function clearReactionListeners(): void {
  globalListeners.clear()
  categoryListeners.clear()
}
