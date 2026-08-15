import { getChatRepository } from './repository'
import type { ChatConnectionState } from './repository'
import type {
  ChatChannelType,
  ChatMessageViewModel,
  ChatRole,
  ChatThreadViewModel,
} from './types'

/**
 * Selectors für UI-View-Models.
 * Permission-aware: Worker dürfen NIE customer-Channel-Threads sehen.
 * Diese Hard-Exclusion ist auch in RLS-Policy + Workflow-Guard erzwungen.
 *
 * Phase 1a: keine UI consumer; Phase 1b schwenkt UI auf diese Selectors.
 */

export function getThreadsForRole(role: ChatRole): ChatThreadViewModel[] {
  const all = getChatRepository().getThreads()
  if (role === 'worker') {
    return all.filter((t) => t.channelType !== 'customer')
  }
  if (role === 'customer') {
    // Customers see their customer-channel threads plus any 1:1 direct chats.
    return all.filter((t) => t.channelType === 'customer' || t.channelType === 'direct')
  }
  return all
}

export function getThreadsByChannel(channelType: ChatChannelType): ChatThreadViewModel[] {
  return getChatRepository().getThreads(channelType)
}

export function getActiveThreadById(threadId: string): ChatThreadViewModel | undefined {
  return getChatRepository().getThread(threadId)
}

/** Current realtime connection health for the UI connection-banner. */
export function getChatConnectionState(): ChatConnectionState {
  return getChatRepository().getConnectionState()
}

/**
 * Slice 2 M2 — Resolve a chat thread by its legacy conversation/thread id.
 *
 * The chat repository keeps `legacyThreadId` populated on every thread it
 * synthesises from the legacy `conversations` / `message_threads` stores.
 * Subscriber screens that still receive a legacy id from route params, push
 * notifications, or cross-domain links use this lookup to bridge into the
 * chat domain without forcing a refactor of the upstream caller.
 *
 * Returns `undefined` for unmigrated threads — callers MUST fall back to
 * the legacy path when this is null (push-deeplink invariant).
 */
export function getThreadByLegacyConversationId(
  conversationId: string | null | undefined,
): ChatThreadViewModel | undefined {
  if (!conversationId) return undefined
  return getChatRepository()
    .getThreads()
    .find((t) => t.legacyThreadId === conversationId)
}

export function getThreadMessages(threadId: string): ChatMessageViewModel[] {
  return getChatRepository()
    .getMessages(threadId)
    .filter((m) => !m.deletedAt)
}

export function getUnreadCountByChannel(role: ChatRole): Record<ChatChannelType, number> {
  const counts: Record<ChatChannelType, number> = {
    customer: 0,
    office: 0,
    team: 0,
    assignment: 0,
    dispute: 0,
    direct: 0,
  }
  const threads = getThreadsForRole(role)
  for (const t of threads) counts[t.channelType] += t.unreadCount
  return counts
}

/**
 * Aggregierte Unread-Count nach `user_notification_preferences`.
 * BottomNav-Badge konsumiert das.
 */
export function getBadgeUnreadCount(role: ChatRole): number {
  const repo = getChatRepository()
  const pref = repo.getUserNotificationPreference()
  const counts = getUnreadCountByChannel(role)

  let total = 0
  if (!pref || pref.countCustomerChatUnread) total += counts.customer
  if (pref?.countOfficeChatUnread) total += counts.office
  if (pref?.countTeamChatUnread) total += counts.team
  if (pref?.countAssignmentChatUnread) total += counts.assignment
  if (!pref || pref.countDisputeChatUnread) total += counts.dispute
  // Direct 1:1 chats always badge (no per-channel mute preference in v1).
  total += counts.direct
  return total
}

export function getLastMessageBodyPreview(thread: ChatThreadViewModel): string {
  return thread.lastMessageBody?.slice(0, 200) ?? ''
}

export interface ChatThreadListRow {
  avatarUrl: string
  primaryName: string
  secondaryLine: string
  timeLabel: string | undefined
  unreadCount: number
  preview: string
  channelType: ChatChannelType
}

const SAFE_CRAFTSMAN = 'Handwerker'
const SAFE_CUSTOMER = 'Kunde'
const SAFE_PROJECT = 'Projekt'
const SAFE_DETAILS = 'Details fehlen'
const SAFE_PERSON = 'Person'

function formatTimeLabel(ts: number | null | undefined): string | undefined {
  if (!ts) return undefined
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return undefined
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const dd = String(date.getDate()).padStart(2, '0')
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mo}.`
}

/**
 * Customer↔Provider thread row for `MessagesScreen` etc. Reads display data
 * from `thread.displayMetadata` (denormalised by the repo when synthesising
 * legacy threads) so no cross-domain lookup is required.
 */
export function getChatThreadListRow(
  thread: ChatThreadViewModel,
  role: 'customer' | 'craftsman',
  currentUserId?: string | null,
): ChatThreadListRow {
  const meta = thread.displayMetadata ?? {}
  const projectTitle = meta.projectTitle || thread.title || SAFE_PROJECT
  const projectSubtitle = meta.projectSubtitle || SAFE_DETAILS
  const preview = thread.lastMessageBody ?? ''
  const timeLabel = formatTimeLabel(thread.lastMessageAt)

  // Direct 1:1 chat: render the OTHER peer from display_metadata.peers.
  if (thread.channelType === 'direct') {
    const peers = meta.peers ?? {}
    const otherId = Object.keys(peers).find((id) => id !== currentUserId)
    const peer = otherId ? peers[otherId] : undefined
    const name = peer?.displayName || (peer?.handle ? `@${peer.handle}` : SAFE_PERSON)
    return {
      avatarUrl: '',
      primaryName: name,
      secondaryLine: peer?.handle ? `@${peer.handle}` : '',
      timeLabel,
      unreadCount: thread.unreadCount,
      preview,
      channelType: thread.channelType,
    }
  }

  if (role === 'customer') {
    return {
      avatarUrl: meta.craftsmanAvatarUrl ?? '',
      primaryName: meta.craftsmanName || SAFE_CRAFTSMAN,
      secondaryLine: `${projectTitle} • ${projectSubtitle}`,
      timeLabel,
      unreadCount: thread.unreadCount,
      preview,
      channelType: thread.channelType,
    }
  }
  return {
    avatarUrl: meta.customerAvatarUrl ?? '',
    primaryName: meta.customerName || SAFE_CUSTOMER,
    secondaryLine: `${projectTitle} • ${projectSubtitle}`,
    timeLabel,
    unreadCount: thread.unreadCount,
    preview,
    channelType: thread.channelType,
  }
}

/**
 * Sort threads — unread first, then most-recent-first.
 */
export function sortChatThreadsByUnread(
  threads: ChatThreadViewModel[],
): ChatThreadViewModel[] {
  return [...threads].sort((a, b) => {
    const ua = a.unreadCount > 0 ? 1 : 0
    const ub = b.unreadCount > 0 ? 1 : 0
    if (ua !== ub) return ub - ua
    const ta = a.lastMessageAt ?? a.updatedAt ?? 0
    const tb = b.lastMessageAt ?? b.updatedAt ?? 0
    return tb - ta
  })
}
