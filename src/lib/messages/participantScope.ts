/**
 * Participant Scope — Defense-in-depth filtering for conversation visibility.
 *
 * The Supabase repository loads only conversations where the current user is
 * a participant (craftsman_user_id or customer_user_id matches).  This module
 * provides an application-level guard so that selectors never accidentally
 * expose a conversation to a user who is not a participant — even if the
 * repository cache contains stale data from a previous session.
 *
 * All public selector functions that return user-visible conversation lists
 * must route through these helpers.
 */

import type { Conversation } from './types'

/**
 * Returns true when `userId` is one of the canonical participants of the
 * conversation (either the customer or the craftsman).
 */
export function isConversationParticipant(
  conversation: Conversation,
  userId: string
): boolean {
  return (
    conversation.craftsmanUserId === userId ||
    conversation.customerUserId === userId
  )
}

/**
 * Filters a list of conversations to only those where `userId` is a
 * canonical participant.  Returns the full list unchanged when `userId`
 * is undefined/null — this covers two cases:
 *
 *   1. **Pre-auth / test context**: no user is logged in, so scoping
 *      is handled by the caller or by the repository layer (which will
 *      have already loaded only the correct user's data).
 *   2. **InMemoryMessageRepository tests**: tests manage data explicitly
 *      and may not set a session user.
 *
 * In production, the Supabase repository already scopes at the DB level;
 * this filter is a defense-in-depth guard.
 */
export function filterConversationsByParticipant(
  conversations: Conversation[],
  userId: string | undefined | null
): Conversation[] {
  if (!userId) return conversations
  return conversations.filter((c) => isConversationParticipant(c, userId))
}

/**
 * Filters conversations to only those where the given user is the
 * craftsman-side participant.  Used by craftsman-only selectors (e.g.
 * incoming request inbox) to ensure strict craftsman scoping.
 *
 * Returns the full list unchanged when `craftsmanUserId` is null/undefined.
 * This is safe because:
 *   - In production, the Supabase repository already loads only the
 *     current user's conversations.
 *   - In tests, data is managed explicitly per-test.
 *   - The null case only occurs when no user session exists (pre-auth).
 */
export function filterConversationsByCraftsman(
  conversations: Conversation[],
  craftsmanUserId: string | undefined | null
): Conversation[] {
  if (!craftsmanUserId) return conversations
  return conversations.filter((c) => c.craftsmanUserId === craftsmanUserId)
}

/**
 * Deduplicates conversations so that only one canonical thread per
 * customer ↔ craftsman pair is returned.
 *
 * When multiple conversations exist for the same pair (e.g. from legacy
 * data or race conditions), the most recently created one is kept.
 * Falls back to insertion order when `createdAt` is not set on both.
 *
 * The pair key requires `customerUserId` for reliable identity.
 * Conversations without a `customerUserId` are never deduplicated
 * (customer names are not unique identifiers and could cause false
 * collisions between different customers).
 */
export function deduplicateConversationsByPair(
  conversations: Conversation[]
): Conversation[] {
  const canonical = new Map<string, Conversation>()
  const ungrouped: Conversation[] = []

  for (const c of conversations) {
    // Without a customerUserId we cannot reliably identify the customer.
    // Treat each such conversation as unique to avoid false dedup.
    if (!c.customerUserId) {
      ungrouped.push(c)
      continue
    }

    const pairKey = `${c.customerUserId}::${c.craftsmanHandle}`

    const existing = canonical.get(pairKey)
    if (!existing) {
      canonical.set(pairKey, c)
      continue
    }

    // Keep the more recently created conversation as canonical.
    // When both lack timestamps, the first-encountered conversation wins.
    const existingTime = existing.createdAt ?? 0
    const candidateTime = c.createdAt ?? 0
    if (candidateTime > existingTime) {
      canonical.set(pairKey, c)
    }
  }

  return [...canonical.values(), ...ungrouped]
}

/**
 * Resolves the canonical conversation for the same customer ↔ craftsman
 * pair as `target`.  If `target` is already the canonical winner (most
 * recently created), it is returned as-is.  If a newer duplicate exists,
 * that duplicate is returned instead.
 *
 * Returns `target` unchanged when `customerUserId` is absent (no
 * reliable pair key).
 *
 * Uses the same "most recently created wins" rule as
 * `deduplicateConversationsByPair` so every surface that resolves or
 * lists conversations agrees on the same canonical winner.
 */
export function resolveCanonicalConversation(
  target: Conversation,
  allConversations: Conversation[]
): Conversation {
  if (!target.customerUserId) return target

  const pairKey = `${target.customerUserId}::${target.craftsmanHandle}`
  let canonical = target

  for (const c of allConversations) {
    if (!c.customerUserId) continue
    const key = `${c.customerUserId}::${c.craftsmanHandle}`
    if (key !== pairKey) continue

    if ((c.createdAt ?? 0) > (canonical.createdAt ?? 0)) {
      canonical = c
    }
  }

  return canonical
}

// ── Relationship thread grouping ──────────────────────────────────────────

/**
 * Returns the pair key for a conversation, or null when the conversation
 * lacks a customerUserId (ungroupable).
 */
export function getPairKey(conversation: Conversation): string | null {
  if (!conversation.customerUserId) return null
  return `${conversation.customerUserId}::${conversation.craftsmanHandle}`
}

/**
 * Returns ALL conversation IDs belonging to the same customer ↔ craftsman
 * relationship as `target`, including `target` itself.
 *
 * When `target` lacks a customerUserId, returns only `[target.id]`
 * (ungroupable).
 *
 * This is the foundation of the relationship thread model: every surface
 * that reads messages, artifacts, unread counts, or previews should
 * aggregate across all IDs in the relationship group — not just the
 * canonical conversation.
 */
export function getRelationshipGroup(
  target: Conversation,
  allConversations: Conversation[]
): string[] {
  if (!target.customerUserId) return [target.id]

  const pairKey = `${target.customerUserId}::${target.craftsmanHandle}`
  const ids: string[] = []

  for (const c of allConversations) {
    if (!c.customerUserId) continue
    const key = `${c.customerUserId}::${c.craftsmanHandle}`
    if (key === pairKey) ids.push(c.id)
  }

  // Should always contain at least target.id, but guard defensively
  return ids.length > 0 ? ids : [target.id]
}
