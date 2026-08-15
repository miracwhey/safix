import type {
  ChatChannelType,
  ChatDeleteMode,
  ChatLegacySource,
  ChatMessageStatus,
  ChatMessageViewModel,
  ChatMigrationStatus,
  ChatParticipant,
  ChatRole,
  ChatSearchQuery,
  ChatSearchResult,
  ChatThreadViewModel,
  SendMessageInput,
  UserNotificationPreference,
} from '../types'
import type {
  ChatConnectionState,
  ChatRepository,
  InsertOptimisticMessageInput,
} from './ChatRepository'

/**
 * InMemoryChatRepository — Test-Double für vitest und Mock-Mode.
 *
 * - Threads/Messages/Participants live in Maps
 * - sendMessage(): Optimistic insert mit status='sent' (sofort)
 * - clientMessageId-Dedup wird simuliert via UNIQUE-Check
 * - Coexistence: getMigrationStatus() returns 'migration_complete' immer
 *   (kein Legacy-Fallback nötig, alle Threads "in der neuen Welt")
 * - Realtime: notify() ruft alle Listener; subscribeToThread() filtert
 */
export class InMemoryChatRepository implements ChatRepository {
  private threads = new Map<string, ChatThreadViewModel>()
  private messagesByThread = new Map<string, ChatMessageViewModel[]>()
  private participantsByThread = new Map<string, ChatParticipant[]>()
  // Block 3 parity: ids hidden for the current user ("Für mich").
  private readonly hiddenMessageIds = new Set<string>()
  private hydrated = false
  private notifPref?: UserNotificationPreference
  private readonly listeners = new Set<() => void>()
  private readonly threadListeners = new Map<string, Set<(msg: ChatMessageViewModel) => void>>()
  private readonly threadListListeners = new Set<(thread: ChatThreadViewModel) => void>()
  private readonly defaultUserId = 'inmemory-user'
  private readonly defaultRole: ChatRole = 'craftsman'
  private lastError: string | null = null

  async initialize(): Promise<void> {
    this.hydrated = true
    this.notify()
  }

  isHydrated(): boolean {
    return this.hydrated
  }

  getLastError(): string | null {
    return this.lastError
  }

  resetState(): void {
    this.threads.clear()
    this.messagesByThread.clear()
    this.hiddenMessageIds.clear()
    this.participantsByThread.clear()
    this.hydrated = false
    this.notifPref = undefined
    this.lastError = null
    this.notify()
  }

  prepareForResync(): void {
    // Parity with SupabaseChatRepository: a resync must NOT de-hydrate —
    // isHydrated() stays true once hydrated so useChatHydrated-gated UI
    // doesn't flicker into loading placeholders during a resume.
  }

  restartRealtimeIfDead(): void {
    // No-op: in-memory has no realtime channel
  }

  getConnectionState(): ChatConnectionState {
    // In-memory has no socket — it is always usable ("connected").
    return 'connected'
  }

  hasSentServerRow(clientMessageId: string): boolean {
    for (const list of this.messagesByThread.values()) {
      if (
        list.some(
          (m) =>
            m.clientMessageId === clientMessageId &&
            m.status === 'sent' &&
            !m.id.startsWith('temp_'),
        )
      ) {
        return true
      }
    }
    return false
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  getThread(threadId: string): ChatThreadViewModel | undefined {
    return this.threads.get(threadId)
  }

  getThreads(channelType?: ChatChannelType): ChatThreadViewModel[] {
    const all = [...this.threads.values()]
    if (!channelType) return all
    return all.filter((t) => t.channelType === channelType)
  }

  /** Parity contract with SupabaseChatRepository.ensureThreadInCache:
   *  cached thread → ViewModel, unknown thread → undefined (never throws). */
  async ensureThreadInCache(threadId: string): Promise<ChatThreadViewModel | undefined> {
    return this.threads.get(threadId)
  }

  getMessages(threadId: string): ChatMessageViewModel[] {
    const list = this.messagesByThread.get(threadId) ?? []
    if (this.hiddenMessageIds.size === 0) return list
    return list.filter((m) => !this.hiddenMessageIds.has(m.id))
  }

  async deleteMessage(messageId: string, mode: ChatDeleteMode): Promise<void> {
    let located:
      | { threadId: string; list: ChatMessageViewModel[]; msg: ChatMessageViewModel }
      | null = null
    for (const [threadId, list] of this.messagesByThread.entries()) {
      const msg = list.find((m) => m.id === messageId)
      if (msg) {
        located = { threadId, list, msg }
        break
      }
    }
    if (!located) throw new Error('message_not_found')
    const { threadId, list, msg } = located

    if (mode === 'self') {
      this.hiddenMessageIds.add(messageId)
      this.messagesByThread.set(
        threadId,
        list.filter((m) => m.id !== messageId),
      )
      this.notify()
      return
    }

    // 'all' — mirror the RPC guards so tests exercise the real contract.
    if (msg.senderUserId !== this.defaultUserId) throw new Error('not_sender')
    if (msg.createdAt < Date.now() - 15 * 60 * 1000) throw new Error('unsend_window_expired')
    this.messagesByThread.set(
      threadId,
      list.map((m) =>
        m.id === messageId
          ? {
              ...m,
              redacted: true,
              redactedAt: Date.now(),
              redactedReason: 'sender_unsend',
              body: null,
              attachments: [],
            }
          : m,
      ),
    )
    this.notify()
  }

  async getMessagesSince(threadId: string, sinceMessageId: string): Promise<ChatMessageViewModel[]> {
    const all = this.messagesByThread.get(threadId) ?? []
    // Parity with SupabaseChatRepository.getMessagesSince: a resume/gap read
    // excludes soft-deleted rows (`.is('deleted_at', null)`) so a message
    // deleted while backgrounded is never re-surfaced. Consistent with the
    // other cache-loading reads (preload + fallbackRefresh).
    const visible = all.filter((m) => !m.deletedAt)
    const idx = visible.findIndex((m) => m.id === sinceMessageId)
    if (idx < 0) return visible
    return visible.slice(idx + 1)
  }

  async sendMessage(input: SendMessageInput): Promise<ChatMessageViewModel> {
    const existing = this.messagesByThread.get(input.threadId) ?? []
    const dup = existing.find(
      (m) => m.senderUserId === this.defaultUserId && m.clientMessageId === input.clientMessageId,
    )
    if (dup) return dup

    const now = Date.now()
    const message: ChatMessageViewModel = {
      id: `msg_${now}_${Math.random().toString(36).slice(2, 8)}`,
      threadId: input.threadId,
      senderUserId: this.defaultUserId,
      clientMessageId: input.clientMessageId,
      body: input.body ?? null,
      messageType: input.messageType ?? 'text',
      artifactType: input.artifactType ?? null,
      artifactId: input.artifactId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt: now,
      serverReceivedAt: now,
      deliveredAt: null,
      legacyMessageId: null,
      legacySource: null,
      deletedAt: null,
      redacted: false,
      redactedAt: null,
      redactedReason: null,
      status: 'sent' as ChatMessageStatus,
      sender: { userId: this.defaultUserId, role: this.defaultRole, displayName: null, avatarUrl: null },
      attachments: [],
    }

    this.messagesByThread.set(input.threadId, [...existing, message])

    const thread = this.threads.get(input.threadId)
    if (thread) {
      this.threads.set(input.threadId, {
        ...thread,
        lastMessageId: message.id,
        lastMessageAt: now,
        lastMessageBody: input.body?.slice(0, 200) ?? null,
        updatedAt: now,
      })
    }

    this.threadListeners.get(input.threadId)?.forEach((l) => l(message))
    if (thread) this.threadListListeners.forEach((l) => l(this.threads.get(input.threadId)!))
    this.notify()
    return message
  }

  async markThreadRead(threadId: string, lastMessageId: string): Promise<void> {
    const participants = this.participantsByThread.get(threadId) ?? []
    const now = Date.now()
    this.participantsByThread.set(
      threadId,
      participants.map((p) =>
        p.userId === this.defaultUserId
          ? { ...p, lastReadMessageId: lastMessageId, lastReadAt: now }
          : p,
      ),
    )
    const thread = this.threads.get(threadId)
    if (thread) this.threads.set(threadId, { ...thread, unreadCount: 0 })
    this.notify()
  }

  async updateThreadInquiryState(
    threadId: string,
    patch: { reviewedAt?: number; declinedAt?: number },
  ): Promise<void> {
    const thread = this.threads.get(threadId)
    if (!thread) return
    // Parity with the RPC: set-only-if-null.
    this.threads.set(threadId, {
      ...thread,
      reviewedAt: thread.reviewedAt ?? patch.reviewedAt ?? null,
      declinedAt: thread.declinedAt ?? patch.declinedAt ?? null,
      updatedAt: Date.now(),
    })
    this.notify()
  }

  async searchMessages(query: ChatSearchQuery): Promise<ChatSearchResult[]> {
    const needle = query.query.toLowerCase()
    const results: ChatSearchResult[] = []
    for (const [threadId, msgs] of this.messagesByThread.entries()) {
      const thread = this.threads.get(threadId)
      if (!thread) continue
      if (query.threadId && threadId !== query.threadId) continue
      if (query.channelType && thread.channelType !== query.channelType) continue
      for (const m of msgs) {
        if (!m.body) continue
        if (m.deletedAt || m.redacted) continue
        if (query.since && m.createdAt < query.since) continue
        if (query.until && m.createdAt > query.until) continue
        if (m.body.toLowerCase().includes(needle)) {
          results.push({
            threadId,
            messageId: m.id,
            channelType: thread.channelType,
            snippet: m.body.slice(0, 200),
            senderUserId: m.senderUserId,
            createdAt: m.createdAt,
            routeTo: { type: 'message', id: m.id, focus: m.id },
          })
        }
      }
    }
    if (query.limit) return results.slice(0, query.limit)
    return results
  }

  async getMigrationStatus(_legacyThreadId: string, _legacySource: ChatLegacySource): Promise<ChatMigrationStatus> {
    return 'migration_complete'
  }

  async enqueueMigration(_legacyThreadId: string, _legacySource: ChatLegacySource, _priority?: number): Promise<void> {
    // no-op in-memory
  }

  subscribeToThread(threadId: string, onMessage: (msg: ChatMessageViewModel) => void): () => void {
    let set = this.threadListeners.get(threadId)
    if (!set) {
      set = new Set()
      this.threadListeners.set(threadId, set)
    }
    set.add(onMessage)
    return () => set?.delete(onMessage)
  }

  subscribeToThreadList(onUpdate: (thread: ChatThreadViewModel) => void): () => void {
    this.threadListListeners.add(onUpdate)
    return () => this.threadListListeners.delete(onUpdate)
  }

  getUserNotificationPreference(): UserNotificationPreference | undefined {
    return this.notifPref
  }

  async updateUserNotificationPreference(
    patch: Partial<Omit<UserNotificationPreference, 'userId'>>,
  ): Promise<void> {
    const now = Date.now()
    const existing: UserNotificationPreference = this.notifPref ?? {
      userId: this.defaultUserId,
      quietHoursStart: null,
      quietHoursEnd: null,
      isAlwaysReachable: false,
      countCustomerChatUnread: true,
      countOfficeChatUnread: false,
      countTeamChatUnread: false,
      countAssignmentChatUnread: false,
      countDisputeChatUnread: true,
      createdAt: now,
      updatedAt: now,
    }
    this.notifPref = { ...existing, ...patch, updatedAt: now }
    this.notify()
  }

  // ── Optimistic attachment helpers (Slice B) ───────────────────────────────

  insertOptimisticMessage(input: InsertOptimisticMessageInput): string {
    const tempId = `temp_${input.clientMessageId}`
    const now = Date.now()
    const msg: ChatMessageViewModel = {
      id: tempId,
      threadId: input.threadId,
      senderUserId: this.defaultUserId,
      clientMessageId: input.clientMessageId,
      body: input.body ?? null,
      messageType: input.messageType,
      artifactType: null,
      artifactId: null,
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt: now,
      serverReceivedAt: now,
      deliveredAt: null,
      legacyMessageId: null,
      legacySource: null,
      deletedAt: null,
      redacted: false,
      redactedAt: null,
      redactedReason: null,
      attachments: input.attachments,
      status: 'pending',
      sender: { userId: this.defaultUserId, role: this.defaultRole, displayName: null, avatarUrl: null },
    }
    const existing = this.messagesByThread.get(input.threadId) ?? []
    // Parity with SupabaseChatRepository: idempotent per clientMessageId —
    // a re-send replaces the optimistic row in place (createdAt preserved)
    // instead of appending a duplicate; a landed server row wins outright.
    const priorIdx = existing.findIndex(
      (m) => m.clientMessageId === input.clientMessageId && m.senderUserId === this.defaultUserId,
    )
    if (priorIdx >= 0) {
      const prior = existing[priorIdx]
      if (!prior.id.startsWith('temp_')) return prior.id
      const updated = [...existing]
      updated[priorIdx] = { ...msg, createdAt: prior.createdAt, serverReceivedAt: prior.serverReceivedAt }
      this.messagesByThread.set(input.threadId, updated)
      this.notify()
      return tempId
    }
    this.messagesByThread.set(input.threadId, [...existing, msg])
    this.notify()
    return tempId
  }

  failOptimisticMessage(threadId: string, tempId: string): void {
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'failed' as ChatMessageStatus }
    this.messagesByThread.set(threadId, updated)
    this.notify()
  }

  resetOptimisticToPending(threadId: string, clientMessageId: string): void {
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'pending' as ChatMessageStatus }
    this.messagesByThread.set(threadId, updated)
    this.notify()
  }

  markOptimisticSent(threadId: string, clientMessageId: string): void {
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'sent' as ChatMessageStatus }
    this.messagesByThread.set(threadId, updated)
    this.notify()
  }

  discardOptimisticMessage(threadId: string, clientMessageId: string): void {
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    // Revoke any Object URLs so image / video poster blobs are freed immediately.
    const toDiscard = list.find((m) => m.id === tempId)
    if (toDiscard && typeof URL !== 'undefined') {
      for (const att of toDiscard.attachments ?? []) {
        if (att.localBlobUrl) URL.revokeObjectURL(att.localBlobUrl)
      }
    }
    const filtered = list.filter((m) => m.id !== tempId)
    this.messagesByThread.set(threadId, filtered)
    this.notify()
  }

  updateOptimisticAttachment(
    threadId: string,
    clientMessageId: string,
    patch: Partial<Pick<import('../types').ChatAttachment, 'storagePath' | 'storageBucket' | 'sizeBytes' | 'mimeType' | 'posterStoragePath' | 'width' | 'height'>>,
  ): void {
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    const msgIdx = list.findIndex((m) => m.id === tempId)
    if (msgIdx < 0) return
    const msg = list[msgIdx]
    if (!msg.attachments?.length) return
    const updatedAttachments = msg.attachments.map((a) =>
      a.id === `temp_att_${clientMessageId}` ? { ...a, ...patch } : a,
    )
    const updated = [...list]
    updated[msgIdx] = { ...msg, attachments: updatedAttachments }
    this.messagesByThread.set(threadId, updated)
    this.notify()
  }

  // ── Test-helpers (nicht im Interface, in vitest verwendet) ──────────────

  _seedThread(thread: ChatThreadViewModel): void {
    this.threads.set(thread.id, thread)
    if (!this.messagesByThread.has(thread.id)) this.messagesByThread.set(thread.id, [])
    if (!this.participantsByThread.has(thread.id)) {
      this.participantsByThread.set(thread.id, thread.participants ?? [])
    }
    this.notify()
  }

  _seedParticipants(threadId: string, participants: ChatParticipant[]): void {
    this.participantsByThread.set(threadId, participants)
    const t = this.threads.get(threadId)
    if (t) this.threads.set(threadId, { ...t, participants })
    this.notify()
  }

  /** Test seed: append a fully-formed message (e.g. a peer's) to a thread. */
  _seedMessage(threadId: string, message: ChatMessageViewModel): void {
    const list = this.messagesByThread.get(threadId) ?? []
    this.messagesByThread.set(threadId, [...list, message])
    this.notify()
  }
}
