import {
  getConversationById,
  getConversations,
  getMessagesByConversationId,
} from './store'
import { getJobs } from '../jobs'
import { getSession } from '../session'
import { filterConversationsByParticipant, deduplicateConversationsByPair, resolveCanonicalConversation, getRelationshipGroup } from './participantScope'
import { findCanonicalJobForConversation } from './threadArtifactSelectors'
import { formatMessageTimeLabel } from './dateUtils'
import { getBlockedUserIdsSync } from '../moderation/moderationService'
import type {
  MessageItem,
  MessageRole,
  MessageThread,
  ThreadHeader,
  ThreadListRow,
} from './types'

/**
 * Builds the consolidated message list for a relationship thread.
 *
 * When multiple conversation rows exist for the same customer ↔ craftsman
 * pair, messages from ALL duplicate conversations are merged and sorted
 * by sentAt so the visible thread shows the full relationship history.
 */
function buildThreadMessages(conversationIds: string[]): MessageItem[] {
  const seen = new Set<string>()
  const items: MessageItem[] = []

  for (const cid of conversationIds) {
    for (const message of getMessagesByConversationId(cid)) {
      // Guard against duplicate message IDs across conversations
      if (seen.has(message.id)) continue
      seen.add(message.id)
      items.push({
        id: message.id,
        sender: message.sender,
        text: message.text,
        createdAtLabel: message.createdAtLabel,
        sentAt: message.sentAt,
        attachmentType: message.attachmentType,
        projectAttachment: message.projectAttachment,
      })
    }
  }

  // Sort chronologically so the full history reads correctly
  items.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
  return items
}

function buildThread(threadId: string): MessageThread | undefined {
  const conversation = getConversationById(threadId)
  if (!conversation) return undefined

  // Collect all conversation IDs in the relationship group so that
  // messages/unread/preview reflect the full consolidated history.
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)

  const messages = buildThreadMessages(groupIds)
  const lastMessage = messages[messages.length - 1]

  // Consolidated unread count: sum across all conversations in the group
  let unreadCount = 0
  for (const cid of groupIds) {
    const c = getConversationById(cid)
    if (c) unreadCount += c.unreadCount ?? 0
  }

  // Derive timeLabel from the actual last event timestamp in the
  // consolidated thread.  This ensures the inbox preview shows the time
  // of the most recent activity across the full relationship group,
  // not a stale per-conversation label that may have been set on a
  // non-canonical duplicate.
  //
  // Priority:
  //   1. Last message sentAt across the consolidated history (most accurate)
  //   2. Most recent conversation createdAt in the group (creation time)
  //   3. Canonical conversation's stored timeLabel (legacy fallback)
  let timeLabel = conversation.timeLabel
  const lastSentAt = lastMessage?.sentAt
  if (lastSentAt && lastSentAt > 0) {
    timeLabel = formatMessageTimeLabel(lastSentAt)
  } else {
    // No messages with timestamps — fall back to the most recent
    // createdAt across the group (thread creation time).
    let latestCreatedAt = 0
    for (const cid of groupIds) {
      const c = getConversationById(cid)
      if (c?.createdAt && c.createdAt > latestCreatedAt) {
        latestCreatedAt = c.createdAt
      }
    }
    if (latestCreatedAt > 0) {
      timeLabel = formatMessageTimeLabel(latestCreatedAt)
    }
  }

  return {
    id: conversation.id,
    customerName: conversation.customerName,
    customerAvatarUrl: conversation.customerAvatarUrl,
    craftsmanName: conversation.craftsmanName,
    craftsmanHandle: conversation.craftsmanHandle,
    craftsmanAvatarUrl: conversation.craftsmanAvatarUrl,
    craftsmanUserId: conversation.craftsmanUserId,
    customerUserId: conversation.customerUserId,
    project: {
      title: conversation.projectTitle,
      subtitle: conversation.projectSubtitle,
      location: conversation.projectLocation,
      costRange: conversation.projectCostRange,
      duration: conversation.projectDuration,
      statusLabel: conversation.projectStatusLabel,
    },
    lastMessagePreview:
      lastMessage?.attachmentType === 'project'
        ? '📋 Projekt angehängt'
        : (lastMessage?.text ?? ''),
    timeLabel,
    unreadCount,
    messages,
  }
}

export function getMessageThreads(): MessageThread[] {
  const allConversations = getConversations()

  // Defense-in-depth: only return threads where the current user is a
  // participant (either customer or craftsman side).  The Supabase
  // repository already scopes at the DB level, but this prevents stale
  // cross-account data from leaking through the cache.
  const currentUserId = getSession().user?.id ?? undefined
  const scoped = filterConversationsByParticipant(allConversations, currentUserId)

  // Deduplicate: show only one canonical thread per customer ↔ craftsman
  // pair.  Multiple historical records for the same pair can exist from
  // legacy data or race conditions; only the most recent is surfaced.
  const conversations = deduplicateConversationsByPair(scoped)

  // Mark conversations with blocked users as read-only instead of hiding them,
  // so users retain access to chat history, offers, and dispute evidence.
  const blockedIds = getBlockedUserIdsSync()

  return conversations
    .map((conversation) => {
      const thread = buildThread(conversation.id)
      if (!thread) return null
      if (blockedIds.size > 0) {
        const counterpartId = conversation.customerUserId === currentUserId
          ? conversation.craftsmanUserId
          : conversation.customerUserId
        if (counterpartId && blockedIds.has(counterpartId)) {
          return { ...thread, isBlocked: true }
        }
      }
      return thread
    })
    .filter((thread): thread is MessageThread => thread !== null)
}

export function getMessageThreadById(threadId: string): MessageThread | undefined {
  // If threadId points to a non-canonical duplicate, resolve to the
  // canonical conversation so the caller always gets the consolidated
  // relationship thread.  This ensures that opening any old duplicate
  // thread ID still returns the correct unified view.
  const canonicalId = resolveCanonicalThreadId(threadId)
  const thread = buildThread(canonicalId)
  if (!thread) return undefined

  // Mark blocked threads as read-only instead of hiding them.
  const currentUserId = getSession().user?.id ?? undefined
  const blockedIds = getBlockedUserIdsSync()
  if (blockedIds.size > 0 && currentUserId) {
    const counterpartId = thread.customerUserId === currentUserId
      ? thread.craftsmanUserId
      : thread.customerUserId
    if (counterpartId && blockedIds.has(counterpartId)) {
      return { ...thread, isBlocked: true }
    }
  }

  return thread
}

/**
 * Returns the canonical conversation ID for the customer ↔ craftsman pair
 * that includes the given threadId.  If the thread is already the canonical
 * winner, returns it unchanged.  If it is a non-canonical duplicate, returns
 * the canonical winner's ID.
 *
 * Uses the same "most recently created wins" rule as
 * `deduplicateConversationsByPair` so inbox, thread view, and write paths
 * all agree on the same canonical conversation.
 *
 * Returns `threadId` unchanged when the conversation is not found or
 * lacks a `customerUserId` (no reliable pair key).
 */
export function resolveCanonicalThreadId(threadId: string): string {
  const conversation = getConversationById(threadId)
  if (!conversation) return threadId

  const allConversations = getConversations()
  const canonical = resolveCanonicalConversation(conversation, allConversations)
  return canonical.id
}

/**
 * Sorts message threads so the most operationally relevant ones surface first:
 *
 * 1. Threads with unread messages come first (sorted by descending unread count).
 * 2. Remaining threads preserve their original store order, which reflects
 *    insertion order from the Supabase repository.
 *
 * Pure function — does not read from any store.
 */
export function sortMessageThreadsByUnread(threads: MessageThread[]): MessageThread[] {
  return [...threads].sort((a, b) => {
    const aUnread = a.unreadCount ?? 0
    const bUnread = b.unreadCount ?? 0
    if (aUnread !== bUnread) return bUnread - aUnread
    return 0
  })
}

export function searchMessageThreads(
  query: string,
  role: MessageRole
): MessageThread[] {
  const normalized = query.trim().toLowerCase()
  const threads = getMessageThreads()

  if (!normalized) return threads

  return threads.filter((thread) => {
    const primaryName =
      role === 'customer' ? thread.craftsmanName : thread.customerName

    return (
      primaryName.toLowerCase().includes(normalized) ||
      thread.project.title.toLowerCase().includes(normalized) ||
      thread.project.subtitle.toLowerCase().includes(normalized) ||
      (thread.project.location ?? '').toLowerCase().includes(normalized) ||
      thread.lastMessagePreview.toLowerCase().includes(normalized)
    )
  })
}

export function getThreadListRow(
  thread: MessageThread,
  role: MessageRole
): ThreadListRow {
  // Safe fallbacks for missing display metadata (prevents "undefined • undefined")
  const projectTitle = thread.project.title || 'Projekt'
  const projectSubtitle = thread.project.subtitle || 'Details fehlen'

  if (role === 'customer') {
    return {
      avatarUrl: thread.craftsmanAvatarUrl,
      primaryName: thread.craftsmanName || 'Handwerker',
      secondaryLine: `${projectTitle} • ${projectSubtitle}`,
      timeLabel: thread.timeLabel,
      unreadCount: thread.unreadCount ?? 0,
      preview: thread.lastMessagePreview,
    }
  }

  return {
    avatarUrl: thread.customerAvatarUrl,
    primaryName: thread.customerName || 'Kunde',
    secondaryLine: `${projectTitle} • ${projectSubtitle}`,
    timeLabel: thread.timeLabel,
    unreadCount: thread.unreadCount ?? 0,
    preview: thread.lastMessagePreview,
  }
}

export function getThreadHeader(
  thread: MessageThread,
  role: MessageRole
): ThreadHeader {
  // Safe fallbacks for missing display metadata
  const projectTitle = thread.project.title || 'Projekt'

  if (role === 'customer') {
    return {
      avatarUrl: thread.craftsmanAvatarUrl,
      primaryName: thread.craftsmanName || 'Handwerker',
      secondaryLine: projectTitle,
      helperLine: thread.project.statusLabel ?? '',
      craftsmanUserId: thread.craftsmanUserId,
    }
  }

  return {
    avatarUrl: thread.customerAvatarUrl,
    primaryName: thread.customerName || 'Kunde',
    secondaryLine: projectTitle,
    helperLine: thread.project.location ?? '',
    customerUserId: thread.customerUserId,
  }
}

/**
 * Returns whether a thread is a pure inquiry (no backing job) or already
 * associated with a structured project/job. Returns null if the thread
 * is not found.
 */
export type ThreadConversionState = 'inquiry' | 'project'

// ── Conversation activity status ──────────────────────────────────────────────

/**
 * Coarse activity state of a thread, derived purely from message
 * count and sender roles — no workflow or domain logic.
 *
 * - `waiting` – no craftsman reply yet (≤1 messages or only customer messages)
 * - `replied` – craftsman has replied (≤2 total messages)
 * - `active`  – ongoing back-and-forth (≥3 messages after craftsman replied)
 */
export type ThreadActivityStatus = 'waiting' | 'replied' | 'active'

/**
 * Derives the coarse conversation activity status from a list of messages.
 * Used to drive dynamic status labels and CTA text in the message thread UI.
 */
export function deriveThreadActivityStatus(
  messages: MessageItem[]
): ThreadActivityStatus {
  const hasCraftsmanReply = messages.some((m) => m.sender === 'counterparty')
  if (!hasCraftsmanReply) return 'waiting'
  if (messages.length <= 2) return 'replied'
  return 'active'
}

export function getThreadConversionState(
  threadId: string
): ThreadConversionState | null {
  const conversation = getConversationById(threadId)
  if (!conversation) return null

  // Use the canonical job lookup helper (primary: sourceConversationId,
  // fallback: projectId matches).
  const jobResult = findCanonicalJobForConversation(conversation, getJobs())
  if (jobResult) return 'project'

  // A customer-attached project (sourceProjectId set) without a linked job
  // is contextual — the thread is still in the inquiry phase.  Only the
  // presence of an actual job marks the thread as "converted".  Previously
  // this check returned 'project' for any linked project, which incorrectly
  // hid the CraftsmanOfferForm and blocked the craftsman from sending an
  // offer after a customer attached a real builder project.
  return 'inquiry'
}

// ── Outbound project request tracking ─────────────────────────────────────────

/**
 * Status of a single outbound inquiry thread originated from a builder project.
 *
 * - `contacted`          – inquiry sent, no messages exchanged yet
 * - `awaiting_reply`     – customer has sent the opening message, craftsman has
 *                          not replied yet
 * - `active_conversation` – craftsman has replied at least once
 */
export type OutboundRequestStatus =
  | 'contacted'
  | 'awaiting_reply'
  | 'active_conversation'

/**
 * A single outbound inquiry that was sent on behalf of a builder project.
 * Returned by `getOutboundProjectRequests`.
 */
export type OutboundProjectRequest = {
  threadId: string
  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl: string
  status: OutboundRequestStatus
  timeLabel?: string
  unreadCount: number
}

/**
 * Returns all outbound inquiry threads that were created for a given
 * builder-project ID (i.e. conversations where `sourceProjectId === projectId`).
 *
 * Derives a human-readable status for each thread based on message activity:
 * - No messages at all         → `contacted`
 * - Only customer messages     → `awaiting_reply`
 * - At least one craftsman reply → `active_conversation`
 */
export function getOutboundProjectRequests(
  projectId: string
): OutboundProjectRequest[] {
  const allConversations = getConversations()

  // Defense-in-depth: scope to current user's conversations.
  const currentUserId = getSession().user?.id ?? undefined
  const scoped = filterConversationsByParticipant(allConversations, currentUserId)

  // Deduplicate: show only one canonical thread per customer ↔ craftsman
  // pair, consistent with inbox and request list surfaces.
  // Filter by sourceProjectId across the FULL relationship group, not
  // just the canonical conversation — a non-canonical duplicate might
  // carry the sourceProjectId from a legacy project attachment.
  const conversations = deduplicateConversationsByPair(scoped)
    .filter((c) => {
      const groupIds = getRelationshipGroup(c, allConversations)
      for (const cid of groupIds) {
        const gc = getConversationById(cid)
        if (gc?.sourceProjectId === projectId) return true
      }
      return false
    })

  return conversations.map((c) => {
    // Consolidate messages across all conversations in the relationship group
    const groupIds = getRelationshipGroup(c, allConversations)
    const seen = new Set<string>()
    const messages: { sender: string; sentAt?: number }[] = []
    for (const cid of groupIds) {
      for (const m of getMessagesByConversationId(cid)) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        messages.push(m)
      }
    }
    // Sort chronologically
    messages.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))

    const hasCraftsmanReply = messages.some((m) => m.sender === 'counterparty')
    const hasUserMessage = messages.some((m) => m.sender === 'user')

    let status: OutboundRequestStatus
    if (hasCraftsmanReply) {
      status = 'active_conversation'
    } else if (hasUserMessage) {
      status = 'awaiting_reply'
    } else {
      status = 'contacted'
    }

    // Consolidated unread count
    let unreadCount = 0
    for (const cid of groupIds) {
      const conv = getConversationById(cid)
      if (conv) unreadCount += conv.unreadCount ?? 0
    }

    // Derive timeLabel from consolidated messages like buildThread does
    const lastSentAt = messages.length > 0 ? messages[messages.length - 1].sentAt : undefined
    let timeLabel = c.timeLabel
    if (lastSentAt && lastSentAt > 0) {
      timeLabel = formatMessageTimeLabel(lastSentAt)
    }

    return {
      threadId: c.id,
      craftsmanName: c.craftsmanName,
      craftsmanHandle: c.craftsmanHandle,
      craftsmanAvatarUrl: c.craftsmanAvatarUrl,
      status,
      timeLabel,
      unreadCount,
    }
  })
}
