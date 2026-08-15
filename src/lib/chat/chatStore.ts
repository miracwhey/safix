import { useEffect, useState } from 'react'
import { getChatRepository } from './repository'
import type { ChatConnectionState } from './repository'
import type { ChatChannelType, ChatMessageViewModel, ChatThreadViewModel, UserNotificationPreference } from './types'

export type ChatBadgeRole = 'customer' | 'craftsman' | 'worker'

/**
 * Reactive subscription hooks for the chat repository.
 * Pattern matcht messages/store.ts — dünner Wrapper, alle Logik im Repo.
 *
 * Phase 1a: kein UI consumer noch (UI bleibt auf Legacy bis Phase 1b).
 * Phase 1b: Screens schwenken auf diese Hooks um.
 *
 * Pattern-Hinweis (react-hooks/set-state-in-effect):
 *  - useState-Initializer liefert initialen Wert
 *  - Effect registriert nur Subscriber (kein synchroner setState im Body)
 *  - State wird ausschließlich vom Subscriber-Callback geupdated
 *  - Bei prop-Wechsel (z.B. threadId) wird der State explicit über Subscriber-Re-Run reset
 */

/** Element-wise reference equality. getThreads() returns a fresh array whose
 *  element refs only change when that thread actually mutates (unread /
 *  last-message / title rebuild a new VM via spread), so a ref match means the
 *  visible thread list is unchanged. */
function sameThreadRefs(a: ChatThreadViewModel[], b: ChatThreadViewModel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useChatThreads(channelType?: ChatChannelType): ChatThreadViewModel[] {
  const [threads, setThreads] = useState<ChatThreadViewModel[]>(() =>
    getChatRepository().getThreads(channelType),
  )
  useEffect(() => {
    const repo = getChatRepository()
    // The repo notify fires on EVERY thread's mutation app-wide. Without the ref
    // guard getThreads() would hand back a brand-new array on each unrelated
    // notify, re-rendering every consumer (BottomNav badge, list screens) on
    // chat activity in any channel. Keep the previous reference when the visible
    // list is unchanged so only real thread changes re-render.
    const sync = () =>
      setThreads((prev) => {
        const next = repo.getThreads(channelType)
        return sameThreadRefs(prev, next) ? prev : next
      })
    const unsubscribe = repo.subscribe(sync)
    // Re-trigger einmal asynchron für aktuellen Snapshot (vermeidet sync-setState-im-Effect)
    queueMicrotask(sync)
    return unsubscribe
  }, [channelType])
  return threads
}

export function useChatThread(threadId: string | undefined): ChatThreadViewModel | undefined {
  const [thread, setThread] = useState<ChatThreadViewModel | undefined>(() =>
    threadId ? getChatRepository().getThread(threadId) : undefined,
  )
  useEffect(() => {
    if (!threadId) return
    const repo = getChatRepository()
    const sync = () => setThread(repo.getThread(threadId))
    const unsubscribe = repo.subscribe(sync)
    queueMicrotask(sync)
    // Self-heal a deep-link / push-tap to a chat_threads.id that is not in the
    // cache yet (Realtime has no chat_threads INSERT listener) — without this
    // the header/badge read-surface would render undefined forever. Authoritative
    // one-shot server seed; never throws and notifies subscribers on success so
    // `sync` picks the thread up. No-ops when the thread is already cached — and
    // is skipped when `threadId` is a legacy id whose migrated thread is already
    // cached (keyed by chat-thread id, never the legacy id), otherwise every open
    // of a migrated thread fires a guaranteed-null SELECT.
    if (
      !repo.getThread(threadId) &&
      !repo.getThreads().some((t) => t.legacyThreadId === threadId)
    ) {
      void repo.ensureThreadInCache(threadId)
    }
    return unsubscribe
  }, [threadId])
  return thread
}

/** Element-wise reference equality. getMessages() returns a stable array whose
 *  element refs only change when that thread's messages actually mutate, so a
 *  ref match means the visible slice is unchanged. */
function sameMessageRefs(a: ChatMessageViewModel[], b: ChatMessageViewModel[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useChatMessages(threadId: string | undefined): ChatMessageViewModel[] {
  const [messages, setMessages] = useState<ChatMessageViewModel[]>(() =>
    threadId ? getChatRepository().getMessages(threadId).filter((m) => !m.deletedAt) : [],
  )
  useEffect(() => {
    if (!threadId) return
    const repo = getChatRepository()
    // The repo notify fires on EVERY thread's mutation. Without the ref guard the
    // raw .filter() would hand back a brand-new array on each unrelated notify,
    // re-rendering (and re-sorting the whole timeline of) the open thread on
    // chat activity in other threads. Keep the previous reference when the
    // visible slice is unchanged so only real changes to THIS thread re-render.
    const sync = () =>
      setMessages((prev) => {
        const next = repo.getMessages(threadId).filter((m) => !m.deletedAt)
        return sameMessageRefs(prev, next) ? prev : next
      })
    const unsubscribe = repo.subscribe(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [threadId])
  return messages
}

export function useChatHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => getChatRepository().isHydrated())
  useEffect(() => {
    const repo = getChatRepository()
    const sync = () => setHydrated(repo.isHydrated())
    const unsubscribe = repo.subscribe(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [])
  return hydrated
}

/**
 * Realtime connection health for the UI connection-banner (offline / verbinde…
 * / live). Re-reads on every repo notify — the adapter fires notify() on each
 * connection-state edge (SUBSCRIBED / degraded / online / offline).
 */
export function useChatConnectionState(): ChatConnectionState {
  const [state, setState] = useState<ChatConnectionState>(() =>
    getChatRepository().getConnectionState(),
  )
  useEffect(() => {
    const repo = getChatRepository()
    const sync = () => setState(repo.getConnectionState())
    const unsubscribe = repo.subscribe(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [])
  return state
}

export function useChatNotificationPreference(): UserNotificationPreference | undefined {
  const [pref, setPref] = useState<UserNotificationPreference | undefined>(() =>
    getChatRepository().getUserNotificationPreference(),
  )
  useEffect(() => {
    const repo = getChatRepository()
    const sync = () => setPref(repo.getUserNotificationPreference())
    const unsubscribe = repo.subscribe(sync)
    queueMicrotask(sync)
    return unsubscribe
  }, [])
  return pref
}

/**
 * Per-Persona unread-count, prefs-aware. BottomNav-Badge nutzt das.
 *
 * Customer: counts only customer-channel (default).
 * Craftsman/Owner: counts all channels per UserNotificationPreference toggles
 *   (customer ja default, office/team/assignment off default, dispute ja default).
 * Worker: counts only assignment + team if prefs allow.
 */
export function useChatBadgeCount(role: ChatBadgeRole): number {
  const threads = useChatThreads()
  const pref = useChatNotificationPreference()
  return computeBadgeUnreadCount(threads, pref, role)
}

export function computeBadgeUnreadCount(
  threads: ChatThreadViewModel[],
  pref: UserNotificationPreference | undefined,
  role: ChatBadgeRole,
): number {
  let total = 0
  for (const t of threads) {
    if (t.unreadCount <= 0) continue
    if (!shouldCountThread(t.channelType, role, pref)) continue
    total += t.unreadCount
  }
  return total
}

function shouldCountThread(
  channelType: ChatThreadViewModel['channelType'],
  role: ChatBadgeRole,
  pref: UserNotificationPreference | undefined,
): boolean {
  // Customers see customer-channel threads plus their 1:1 direct chats.
  if (role === 'customer') {
    if (channelType === 'customer') return pref?.countCustomerChatUnread ?? true
    if (channelType === 'direct') return true
    return false
  }
  // Workers must never see customer-channel (architectural invariant).
  if (role === 'worker' && channelType === 'customer') return false

  switch (channelType) {
    case 'customer':
      return pref?.countCustomerChatUnread ?? true
    case 'office':
      return pref?.countOfficeChatUnread ?? false
    case 'team':
      return pref?.countTeamChatUnread ?? false
    case 'assignment':
      return pref?.countAssignmentChatUnread ?? (role === 'worker' ? true : false)
    case 'dispute':
      return pref?.countDisputeChatUnread ?? true
    case 'direct':
      // Direct 1:1 chats always count (no per-channel mute preference in v1).
      return true
    default:
      return false
  }
}
