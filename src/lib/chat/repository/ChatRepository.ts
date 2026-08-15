import type {
  ChatAttachment,
  ChatChannelType,
  ChatDeleteMode,
  ChatLegacySource,
  ChatMessageType,
  ChatMessageViewModel,
  ChatMigrationStatus,
  ChatSearchQuery,
  ChatSearchResult,
  ChatThreadViewModel,
  SendMessageInput,
  UserNotificationPreference,
} from '../types'

/**
 * Realtime connection health, surfaced to the UI (offline banner / send
 * affordance). Derived in the adapter from navigator.onLine + the realtime
 * channel state; the in-memory adapter is always 'connected'.
 */
export type ChatConnectionState = 'offline' | 'connecting' | 'connected'

/** Input for the client-side optimistic insert used by attachment workflows. */
export interface InsertOptimisticMessageInput {
  threadId: string
  clientMessageId: string
  messageType: ChatMessageType
  body?: string | null
  attachments: ChatAttachment[]
  replyToMessageId?: string | null
}

/**
 * ChatRepository — Block D Slice 1 Phase 1a.
 *
 * Coexistence-Read-Strategy lebt im Adapter (NICHT in UI):
 *   - migration_complete | migration_verified → reads only chat_messages
 *   - migrating → dual-fetch + dedup by id/legacyMessageId
 *   - not_migrated | migration_queued → reads from legacy table + lazy-enqueue migration
 *   - migration_failed → legacy fallback + Sentry-Log
 *
 * Realtime-Invarianten:
 *   - clientMessageId UUID für Optimistic-Send-Idempotency (Server-UNIQUE auf
 *     (sender_user_id, client_message_id))
 *   - Cursor-Reconcile via getMessagesSince() auf App-Resume + Network-Reconnect
 *   - Generation-Counter im Adapter gegen stale-callbacks (Pattern aus
 *     Block-A Hydration-Race-Fix)
 */
export interface ChatRepository {
  /** Loads initial dataset. Must be awaited at bootstrap. */
  initialize(): Promise<void>

  /** True after initialize() resolved at least once. */
  isHydrated(): boolean

  /** Last fetch error, null when healthy. */
  getLastError(): string | null

  /** Resets internal state on logout/account-switch. Bumps generation-counter. */
  resetState(): void

  /** Marks for fresh hydration; called via initialize(forResync=true).
   *  Contract: MUST NOT flip isHydrated() back to false once hydrated —
   *  UI gates (useChatHydrated) read it on every notify and would swap a
   *  live timeline for loading placeholders mid-resync. */
  prepareForResync(): void

  /** Restarts realtime subscription if dead. No-op when healthy — unless
   *  `force` is set (pessimistic restart after a real background stay:
   *  socket dead while channel.state still reads 'joined'). Implementations
   *  with the legacy zero-arg signature remain assignable. */
  restartRealtimeIfDead(options?: { force?: boolean }): void

  /** Current realtime connection health for the UI connection-banner. */
  getConnectionState(): ChatConnectionState

  /**
   * True when a server-confirmed (status='sent', non-temp id) message row for
   * this clientMessageId is already in the local cache. The media-outbox
   * drain-worker checks this before re-uploading so an already-delivered send
   * (whose Realtime echo landed but whose ACK was lost pre-remove) is not
   * re-sent — the RPC is idempotent, but skipping the upload avoids the churn.
   */
  hasSentServerRow(clientMessageId: string): boolean

  // ── Reads ─────────────────────────────────────────────────────────────────

  getThread(threadId: string): ChatThreadViewModel | undefined
  getThreads(channelType?: ChatChannelType): ChatThreadViewModel[]

  /**
   * Idempotent cache-seed for a single thread (CHAT-1, first-message fix).
   * No-op when the thread is already cached (returns the cached ViewModel).
   * Otherwise fetches thread + participants + migration-status and inserts
   * the ViewModel into the cache so send-workflows can resolve it without a
   * full re-hydrate — Realtime has no chat_threads INSERT listener, so a
   * thread freshly created via get-or-create RPC never reaches the cache
   * before the next loadForUser without this.
   * Returns undefined when the thread cannot be loaded (fetch error / not
   * visible under RLS / stale generation) — never throws; caller decides
   * how to surface.
   */
  ensureThreadInCache(threadId: string): Promise<ChatThreadViewModel | undefined>

  /** Returns messages for a thread (Coexistence-aware). */
  getMessages(threadId: string): ChatMessageViewModel[]

  /** Cursor-Reconcile: fetch messages newer than sinceMessageId. */
  getMessagesSince(threadId: string, sinceMessageId: string): Promise<ChatMessageViewModel[]>

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Optimistic send with clientMessageId idempotency.
   * Updates local cache immediately with status='pending', then awaits ACK.
   */
  sendMessage(input: SendMessageInput): Promise<ChatMessageViewModel>

  /**
   * Insert a pre-built optimistic row into the local message cache.
   * Used by attachment workflows to show a pending bubble immediately, before
   * the upload + RPC complete.
   *
   * Idempotent per (sender, clientMessageId) — the cache mirror of the server
   * UNIQUE constraint: a re-send with the same clientMessageId replaces the
   * existing optimistic row in place (createdAt preserved so the bubble does
   * not jump); if the server row already landed, this is a no-op returning
   * the server id. Never appends a duplicate row.
   * Returns the tempId (`temp_${clientMessageId}`), or the server row id in
   * the already-landed no-op case.
   */
  insertOptimisticMessage(input: InsertOptimisticMessageInput): string

  /**
   * Mark an optimistic row as failed.
   * The bubble stays in stream with status='failed'; the user can tap to retry.
   */
  failOptimisticMessage(threadId: string, tempId: string): void

  /**
   * Reset a failed optimistic row back to 'pending' for a user-initiated retry.
   * Re-registers the clientKey in optimisticByClientKey so the Realtime echo
   * can replace it after a successful retry upload.
   */
  resetOptimisticToPending(threadId: string, clientMessageId: string): void

  /**
   * Promote an optimistic row to 'sent' once the server ACKs the send.
   * Mirrors failOptimisticMessage for the success direction so a media bubble
   * (photo / voice / video) stops showing the pending clock the moment the RPC
   * succeeds, instead of waiting for the Realtime INSERT echo — which can be
   * delayed or lost when the WebSocket is degraded even though the HTTP RPC
   * committed. Idempotent; no-op if the row was already replaced/removed.
   */
  markOptimisticSent(threadId: string, clientMessageId: string): void

  /**
   * Permanently remove an optimistic row from the local cache.
   * Called when the user discards a permanently-failed send (3+ retries).
   */
  discardOptimisticMessage(threadId: string, clientMessageId: string): void

  /**
   * Patch the in-memory attachment of an optimistic message after the blob
   * upload completes. Sets storagePath (and optionally other fields) so the
   * URL-resolution effect in VideoMessageBubble / ImageMessageBubble can fire
   * before the Realtime echo arrives — without this, storagePath stays '' and
   * the video element is never rendered post-send.
   */
  updateOptimisticAttachment(
    threadId: string,
    clientMessageId: string,
    patch: Partial<Pick<ChatAttachment, 'storagePath' | 'storageBucket' | 'sizeBytes' | 'mimeType' | 'posterStoragePath' | 'width' | 'height'>>,
  ): void

  /** Updates last_read_message_id + last_read_at for current user in thread. */
  markThreadRead(threadId: string, lastMessageId: string): Promise<void>

  /**
   * Delete a chat message (Block 3) via rpc_delete_chat_message.
   *  - 'all'  → sender-only unsend within 15 min: redacts the row so every
   *             participant sees a tombstone (row kept, body cleared,
   *             attachments dropped). Realtime echo reconciles.
   *  - 'self' → hides the message for the current user only (per-user
   *             chat_message_hidden row); the counterpart is untouched.
   * Throws on RLS / not-sender / window-expired — the caller classifies.
   */
  deleteMessage(messageId: string, mode: ChatDeleteMode): Promise<void>

  /**
   * Chat-Cutover: persists reviewed_at/declined_at on an inquiry thread via
   * rpc_update_chat_thread_inquiry_state (set-only-if-null, craftsman-only)
   * and patches the cached ViewModel on success. Throws on persistence
   * failure — callers decide how to surface.
   */
  updateThreadInquiryState(
    threadId: string,
    patch: { reviewedAt?: number; declinedAt?: number },
  ): Promise<void>

  // ── Search ────────────────────────────────────────────────────────────────

  /** Permission-aware FTS over body_tsv. Empty result if not initialized. */
  searchMessages(query: ChatSearchQuery): Promise<ChatSearchResult[]>

  // ── Migration ─────────────────────────────────────────────────────────────

  getMigrationStatus(legacyThreadId: string, legacySource: ChatLegacySource): Promise<ChatMigrationStatus>

  /** Enqueues a thread for lazy-on-access migration. priority=100 = active. */
  enqueueMigration(legacyThreadId: string, legacySource: ChatLegacySource, priority?: number): Promise<void>

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /** Reactive listener for store-wide changes. Returns unsubscribe. */
  subscribe(listener: () => void): () => void

  /**
   * Per-thread realtime subscription. Returns unsubscribe.
   * For Coexistence: handles dual-subscribe during migration internally.
   */
  subscribeToThread(threadId: string, onMessage: (msg: ChatMessageViewModel) => void): () => void

  /** Per-thread-list subscription. Fires on thread-list updates (last_message_at, unread, etc.). */
  subscribeToThreadList(onUpdate: (thread: ChatThreadViewModel) => void): () => void

  // ── Notification-Prefs ────────────────────────────────────────────────────

  getUserNotificationPreference(): UserNotificationPreference | undefined
  updateUserNotificationPreference(patch: Partial<Omit<UserNotificationPreference, 'userId'>>): Promise<void>
}
