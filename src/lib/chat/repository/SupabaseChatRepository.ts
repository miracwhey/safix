import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '../../supabase'
import { getAuthSession, isAuthLockStolenError } from '../../auth/authSingleFlight'
import { logError, logInfo } from '../../observability'
import { generateUUID } from '../../shared/generateUUID'
import {
  enqueuePendingMutation,
  getPendingMutations,
  removePendingMutation,
} from '../../persistence/pendingMutationStore'
import { isServerSideError } from '../../persistence/serverErrors'
import { ChatMigrationPendingError } from '../errors'
import type {
  ChatAttachment,
  ChatChannelType,
  ChatDeleteMode,
  ChatInquiryCriteria,
  ChatInquiryOrigin,
  ChatLegacySource,
  ChatMessageStatus,
  ChatMessageViewModel,
  ChatMigrationStatus,
  ChatParticipant,
  ChatRole,
  ChatSearchQuery,
  ChatSearchResult,
  ChatThreadDisplayMetadata,
  ChatThreadViewModel,
  SendMessageInput,
  UserNotificationPreference,
} from '../types'
import type {
  ChatConnectionState,
  ChatRepository,
  InsertOptimisticMessageInput,
} from './ChatRepository'
import {
  requestOutboxDrain,
  listAll as listMediaOutbox,
  type MediaOutboxRecord,
} from '../mediaOutbox'
import { bucketForChannel } from './chatAttachmentUploader'

type Listener = () => void

/** Hard ceiling for the chat_messages INSERT roundtrip. Without it a hanging
 *  WKWebView fetch leaves the optimistic bubble 'pending' forever AND keeps
 *  the screen-level sendingRef lock held (no further sends possible). */
const SEND_MESSAGE_TIMEOUT_MS = 15_000

/** Backoff before the single loadForUser retry after a navigator.locks
 *  steal ('Lock was stolen by another request'): give the lock thief —
 *  usually an internal auth-js token operation — a moment to finish before
 *  contending again. */
const AUTH_LOCK_RETRY_DELAY_MS = 300

/** Grace period before revoking a replaced optimistic attachment's blob URL.
 *  The server echo replaces the temp attachment BEFORE the bubble's signed
 *  URL is resolved — revoking immediately blanks the image for a flash
 *  (media double-load). Keep the blob on the replacing view and revoke +
 *  strip it after the signed URL had ample time to load. */
const LOCAL_BLOB_REVOKE_GRACE_MS = 60_000

/**
 * Block D Slice 1 Phase 1a — Supabase ChatRepository.
 *
 * Core Invariants (Risk-Memo §5):
 *  - clientMessageId UUID Idempotency: server-side UNIQUE on
 *    (sender_user_id, client_message_id). Optimistic insert sets
 *    status='pending' locally, ACK sets 'sent'.
 *  - Cursor-Reconcile via getMessagesSince(threadId, sinceMessageId) on
 *    App-Resume + Network-Reconnect (called from session.ts).
 *  - Generation-Counter against stale callbacks (Block-A Hydration-Race-Fix).
 *  - REPLICA IDENTITY FULL on all chat_* tables → filtered DELETE-Realtime safe.
 *  - Auth-Lifecycle: SIGNED_OUT → resetState(), SIGNED_IN → loadForUser().
 *
 * Coexistence-Strategy (im Repo, NICHT in UI):
 *  - migration_complete | migration_verified → reads only chat_messages
 *  - migrating → dual-fetch + dedup by id/legacyMessageId
 *  - not_migrated | migration_queued → reads from legacy table (stub for 1a;
 *    UI is not yet cut over, so legacy-read is handled by the legacy
 *    SupabaseMessageRepository / SupabaseInternalMessageRepository
 *    until Phase 1b)
 *  - migration_failed → legacy fallback + Sentry-Log
 */

interface ChatThreadRow {
  id: string
  channel_type: ChatChannelType
  customer_user_id: string | null
  craftsman_user_id: string | null
  provider_id: string | null
  dispute_id: string | null
  legacy_thread_id: string | null
  legacy_source: ChatLegacySource | null
  title: string | null
  last_message_id: string | null
  last_message_at: number | null
  last_message_body: string | null
  created_at: number
  updated_at: number
  closed_at: number | null
  // Inquiry metadata (Chat-Cutover, migration 20260611000000). Optional so
  // pre-migration fixtures and prod rows without the columns stay valid.
  inquiry_origin?: ChatInquiryOrigin | null
  declined_at?: number | null
  reviewed_at?: number | null
  source_project_id?: string | null
  inquiry_criteria?: ChatInquiryCriteria | null
  display_metadata?: ChatThreadDisplayMetadata | null
}

interface ChatMessageRow {
  id: string
  thread_id: string
  sender_user_id: string
  client_message_id: string
  body: string | null
  message_type: ChatMessageViewModel['messageType']
  artifact_type: string | null
  artifact_id: string | null
  reply_to_message_id: string | null
  created_at: number
  server_received_at: number
  delivered_at: number | null
  legacy_message_id: string | null
  legacy_source: ChatLegacySource | null
  deleted_at: number | null
  redacted: boolean
  redacted_at: number | null
  redacted_reason: string | null
}

interface ChatParticipantRow {
  thread_id: string
  user_id: string
  role: ChatRole
  joined_at: number
  left_at: number | null
  last_read_message_id: string | null
  last_read_at: number | null
  muted_until: number | null
  pinned: boolean
  notification_preference: Record<string, unknown> | null
  last_visible_message_id: string | null
  last_visible_message_at: number | null
  last_visible_message_body: string | null
  last_visible_message_type: string | null
}

interface ChatAttachmentRow {
  id: string
  message_id: string
  asset_type: ChatAttachment['assetType']
  mime_type: string
  size_bytes: number
  storage_bucket: ChatAttachment['storageBucket']
  storage_path: string
  width: number | null
  height: number | null
  duration_ms: number | null
  poster_storage_path: string | null
  transcript: string | null
  transcript_language: string | null
  uploaded_at: number
  deleted_at: number | null
  transcode_status: ChatAttachment['transcodeStatus']
  h264_url: string | null
  poster_url: string | null
  transcode_provider: string | null
  transcode_error: string | null
}

function threadRowToViewModel(
  row: ChatThreadRow,
  participants: ChatParticipant[],
  unreadCount: number,
  migrationStatus: ChatMigrationStatus,
  myParticipant: ChatParticipant | undefined,
): ChatThreadViewModel {
  // Preview / sort fields come from MY participant's denormalized last-visible
  // snapshot (post-M3-hotfix). chat_threads.last_message_* is server-side truth
  // but leaks blocked-sender preview to a blocker. The participant row was
  // updated by the trigger only if the sender was NOT in my user_blocks.
  // Fallback to chat_threads.* when no participant context (e.g. server-side
  // helpers); in client paths myParticipant is always present.
  const lastMessageId   = myParticipant?.lastVisibleMessageId   ?? null
  const lastMessageAt   = myParticipant?.lastVisibleMessageAt   ?? null
  const lastMessageBody = myParticipant?.lastVisibleMessageBody ?? null
  return {
    id: row.id,
    channelType: row.channel_type,
    customerUserId: row.customer_user_id,
    craftsmanUserId: row.craftsman_user_id,
    providerId: row.provider_id,
    disputeId: row.dispute_id ?? null,
    legacyThreadId: row.legacy_thread_id,
    legacySource: row.legacy_source,
    title: row.title,
    lastMessageId,
    lastMessageAt,
    lastMessageBody,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    displayMetadata: row.display_metadata ?? null,
    inquiryOrigin: row.inquiry_origin ?? null,
    declinedAt: row.declined_at ?? null,
    reviewedAt: row.reviewed_at ?? null,
    sourceProjectId: row.source_project_id ?? null,
    inquiryCriteria: row.inquiry_criteria ?? null,
    participants,
    unreadCount,
    migrationStatus,
  }
}

function messageRowToViewModel(
  row: ChatMessageRow,
  attachments: ChatAttachment[],
  status: ChatMessageStatus,
  senderRole: ChatRole,
): ChatMessageViewModel {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id,
    clientMessageId: row.client_message_id,
    body: row.body,
    messageType: row.message_type,
    artifactType: row.artifact_type,
    artifactId: row.artifact_id,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
    serverReceivedAt: row.server_received_at,
    deliveredAt: row.delivered_at,
    legacyMessageId: row.legacy_message_id,
    legacySource: row.legacy_source,
    deletedAt: row.deleted_at,
    redacted: row.redacted,
    redactedAt: row.redacted_at,
    redactedReason: row.redacted_reason,
    attachments,
    status,
    sender: {
      userId: row.sender_user_id,
      role: senderRole,
      displayName: null,
      avatarUrl: null,
    },
  }
}

function participantRowToView(row: ChatParticipantRow): ChatParticipant {
  return {
    threadId: row.thread_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    lastReadMessageId: row.last_read_message_id,
    lastReadAt: row.last_read_at,
    mutedUntil: row.muted_until,
    pinned: row.pinned,
    notificationPreference: row.notification_preference,
    lastVisibleMessageId: row.last_visible_message_id,
    lastVisibleMessageAt: row.last_visible_message_at,
    lastVisibleMessageBody: row.last_visible_message_body,
    lastVisibleMessageType: row.last_visible_message_type,
  }
}

function attachmentRowToView(row: ChatAttachmentRow): ChatAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    assetType: row.asset_type,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    posterStoragePath: row.poster_storage_path,
    transcript: row.transcript,
    transcriptLanguage: row.transcript_language,
    uploadedAt: row.uploaded_at,
    deletedAt: row.deleted_at,
    transcodeStatus: row.transcode_status,
    h264Url: row.h264_url,
    posterUrl: row.poster_url,
    transcodeProvider: row.transcode_provider,
    transcodeError: row.transcode_error,
  }
}

export class SupabaseChatRepository implements ChatRepository {
  private threads = new Map<string, ChatThreadViewModel>()
  private messagesByThread = new Map<string, ChatMessageViewModel[]>()
  // Block 3: message ids the current user hid for themselves ("Für mich",
  // chat_message_hidden). Loaded per session, excluded from every read path.
  private hiddenMessageIds = new Set<string>()
  // P0-1: track optimistic-pending sends by `${senderUserId}:${clientMessageId}`
  // so realtime-echo + ACK reconcile to a single row instead of duplicating.
  private optimisticByClientKey = new Map<string, string /* tempId */>()
  private notifPref?: UserNotificationPreference

  private currentUid: string | null = null
  private _hydrated = false
  private _lastError: string | null = null
  private _loadGeneration = 0
  /** True while a resume-resync reload is in flight. isHydrated() stays true
   *  during revalidation — see prepareForResync(). */
  private _revalidating = false
  /** Inflight-guard (pattern: SupabaseMessageRepository): concurrent
   *  initialize() callers share ONE load instead of double-fetching. */
  private _initPromise: Promise<void> | null = null
  /** Outbox-replay idempotency: client-generated server row id per
   *  `${uid}:${clientMessageId}`, stable across retries of the same send.
   *  The generic pending-mutation flush replays inserts as
   *  upsert(onConflict:'id') — a fresh id per attempt would collide with the
   *  UNIQUE(sender_user_id, client_message_id) instead of the id conflict
   *  target and be misclassified as a permanent failure. */
  private plannedServerIdByClientKey = new Map<string, string>()

  private realtimeChannel: RealtimeChannel | null = null
  private realtimeGeneration = 0
  private authUnsubscribe: (() => void) | null = null
  /** Track whether realtime is connected (pattern: SupabaseMessageRepository). */
  private isRealtimeConnected = false
  /** Reconnect attempt counter — drives the exponential backoff, reset on
   *  SUBSCRIBED. NEVER capitulates: a short blackout must not brick chat until
   *  the next app-resume (root-cause P1 §5). */
  private reconnectAttempts = 0
  /** Base delay for the first reconnect (ms). */
  private readonly RECONNECT_BASE_DELAY = 3000
  /** Backoff ceiling (ms) — 3s → 6s → 12s → 24s → 48s → 60s → 60s … */
  private readonly RECONNECT_MAX_DELAY = 60_000
  /** Pending reconnect timer so a resume/online trigger can pre-empt the wait. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether the WKWebView-safe network listeners are installed (once). */
  private networkListenersInstalled = false
  /** Last connection state broadcast to the UI — only notify on a real change. */
  private connectionState: ChatConnectionState = 'connecting'
  private readonly onWindowOnline = () => this.handleNetworkWake('online')
  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.handleNetworkWake('visible')
    }
  }
  private readonly onWindowOffline = () => this.recomputeConnectionState()

  private readonly listeners = new Set<Listener>()
  private readonly threadListeners = new Map<string, Set<(msg: ChatMessageViewModel) => void>>()
  private readonly threadListListeners = new Set<(thread: ChatThreadViewModel) => void>()

  async initialize(): Promise<void> {
    // Inflight-guard: a resync wave and a parallel caller (e.g. the
    // TOKEN_REFRESHED auth listener) must share one load, not start two full
    // reloads. prepareForResync() clears the slot so a resync that arrives
    // while an older init is in flight still triggers a FRESH load against
    // the bumped generation (legacy SupabaseMessageRepository pattern).
    if (this._initPromise) return this._initPromise
    const p: Promise<void> = (async () => {
      // Single-flight + lock-stolen retry (Sentry P0 FIXUP-WEB-56): boot /
      // resume fires many repository inits in parallel — a raw getSession()
      // per repo makes each one a navigator.locks contender.
      const { data: { session } } = await getAuthSession()
      const uid = session?.user?.id ?? null

      if (!uid) {
        this._hydrated = true
        this._revalidating = false
        this.notify()
        this.subscribeToAuthChanges()
        return
      }

      this.currentUid = uid
      await this.loadForUser(uid, ++this._loadGeneration)
      this.subscribeToAuthChanges()
    })()
    this._initPromise = p
    void p.then(
      () => { if (this._initPromise === p) this._initPromise = null },
      () => { if (this._initPromise === p) this._initPromise = null },
    )
    return p
  }

  isHydrated(): boolean {
    return this._hydrated
  }

  getLastError(): string | null {
    return this._lastError
  }

  resetState(): void {
    this.threads.clear()
    this.messagesByThread.clear()
    this.hiddenMessageIds.clear()
    this.optimisticByClientKey.clear()
    this.plannedServerIdByClientKey.clear()
    this.notifPref = undefined
    this.currentUid = null
    this._hydrated = false
    this._lastError = null
    this._revalidating = false
    this._initPromise = null
    this._loadGeneration++
    this.realtimeGeneration++
    this.isRealtimeConnected = false
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.removeNetworkListeners()
    this.connectionState = 'connecting'
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    this.notify()
  }

  prepareForResync(): void {
    // Resume-resync must NOT flip _hydrated back to false: useChatHydrated
    // consumers (MessageThreadScreen / CraftsmanNachrichtenThreadScreen
    // gates, device-tested path) read isHydrated() on EVERY notify — a
    // realtime insert mid-resync would swap the live timeline for loading
    // placeholders and re-fire get-or-create RPCs on every false→true flip.
    // _revalidating tracks the in-flight refresh instead; cleared in
    // loadForUser's finally (and in initialize's no-session path).
    this._revalidating = true
    this._loadGeneration++
    // Invalidate any in-flight initialize() so the resync starts a fresh
    // load against the bumped generation instead of attaching to a stale one.
    this._initPromise = null
  }

  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    // Pessimistic restart (force, Block 3): channel.state === 'joined' is a
    // lagging indicator — after a long background the socket can be dead while
    // the state still reads 'joined'. force skips the check and does a clean
    // teardown + re-subscribe; the SUBSCRIBED callback then runs the
    // gap-refetch (fallbackRefresh) so events missed while dead are recovered.
    if (!options?.force && this.realtimeChannel && this.realtimeChannel.state === 'joined') return
    this.reconnectAttempts = 0
    this.subscribeRealtime(this.currentUid, true)
  }

  getConnectionState(): ChatConnectionState {
    return this.deriveConnectionState()
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

  /** Offline (no network) > connecting (network up, socket not SUBSCRIBED) >
   *  connected (socket live). navigator.onLine is the authoritative offline
   *  signal in WKWebView. */
  private deriveConnectionState(): ChatConnectionState {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
    return this.isRealtimeConnected ? 'connected' : 'connecting'
  }

  /** Broadcast a connection-state change to subscribers exactly once per edge. */
  private recomputeConnectionState(): void {
    const next = this.deriveConnectionState()
    if (next === this.connectionState) return
    this.connectionState = next
    this.notify()
  }

  /** Install WKWebView-safe network wake listeners exactly once. A resume /
   *  online / tab-visible event forces a realtime restart if the socket is
   *  dead and nudges the media-outbox drain. */
  private installNetworkListeners(): void {
    if (this.networkListenersInstalled) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    window.addEventListener('online', this.onWindowOnline)
    window.addEventListener('offline', this.onWindowOffline)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.networkListenersInstalled = true
  }

  private removeNetworkListeners(): void {
    if (!this.networkListenersInstalled) return
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', this.onWindowOnline)
      window.removeEventListener('offline', this.onWindowOffline)
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
    }
    this.networkListenersInstalled = false
  }

  /** Network came back (online / tab visible): restart the socket if dead and
   *  flush the outbox. Cheap when already connected (restart no-ops). */
  private handleNetworkWake(source: 'online' | 'visible'): void {
    this.recomputeConnectionState()
    if (!this.currentUid) return
    logInfo('chat.realtime.network_wake', { source })
    this.restartRealtimeIfDead({ force: false })
    // Text outbox flush is handled by the app-wide resume cascade; nudge the
    // media outbox here so a pure 'online' edge (no full resume) still drains.
    requestOutboxDrain()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  private subscribeToAuthChanges(): void {
    if (this.authUnsubscribe) return
    const { data } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        this.resetState()
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        const uid = session?.user?.id ?? null
        if (uid && uid !== this.currentUid) {
          this.resetState()
          this.currentUid = uid
          await this.loadForUser(uid, ++this._loadGeneration)
        } else if (uid && !this._hydrated && !this._revalidating) {
          // !_revalidating: a resync-wave load is already in flight for this
          // uid — a TOKEN_REFRESHED mid-resync must not start a second full
          // reload (the generation guard would only discard its writes, not
          // the duplicate network work).
          await this.loadForUser(uid, ++this._loadGeneration)
        }
      }
    })
    this.authUnsubscribe = () => data.subscription.unsubscribe()
  }

  private async loadForUser(uid: string, gen: number, isLockRetry = false): Promise<void> {
    try {
      this._lastError = null

      // 1) Threads für aktuellen User (RLS filtert automatisch via chat_participants).
      //    Sort is re-applied client-side using my-participant.lastVisibleMessageAt
      //    (post-M3-hotfix). chat_threads.last_message_at would leak blocked
      //    sender's bump into the order.
      const { data: threadRows, error: threadErr } = await supabase
        .from('chat_threads')
        .select('*')
      if (threadErr) throw threadErr
      if (gen !== this._loadGeneration) return

      const threadIds = (threadRows ?? []).map((r) => r.id)

      // 2) Participants für die Threads
      const { data: participantRows, error: pErr } = threadIds.length === 0
        ? { data: [], error: null }
        : await supabase
            .from('chat_participants')
            .select('*')
            .in('thread_id', threadIds)
      if (pErr) throw pErr
      if (gen !== this._loadGeneration) return

      const participantsByThread = new Map<string, ChatParticipant[]>()
      for (const row of (participantRows ?? []) as ChatParticipantRow[]) {
        const view = participantRowToView(row)
        const existing = participantsByThread.get(row.thread_id) ?? []
        existing.push(view)
        participantsByThread.set(row.thread_id, existing)
      }

      // 3) Migration-Status für Threads (zur Diagnostic-Anzeige + Coexistence-Switch)
      const { data: migrationRows } = threadIds.length === 0
        ? { data: [] }
        : await supabase
            .from('chat_thread_migration_status')
            .select('thread_id, legacy_thread_id, legacy_source, status')
            .in('thread_id', threadIds)
      if (gen !== this._loadGeneration) return

      const migrationByThread = new Map<string, ChatMigrationStatus>()
      for (const row of migrationRows ?? []) {
        migrationByThread.set(row.thread_id, row.status as ChatMigrationStatus)
      }

      // 4) Notification-Preference
      const { data: prefRow } = await supabase
        .from('user_notification_preferences')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle()
      if (gen !== this._loadGeneration) return

      if (prefRow) {
        this.notifPref = {
          userId: prefRow.user_id,
          quietHoursStart: prefRow.quiet_hours_start,
          quietHoursEnd: prefRow.quiet_hours_end,
          isAlwaysReachable: prefRow.is_always_reachable,
          countCustomerChatUnread: prefRow.count_customer_chat_unread,
          countOfficeChatUnread: prefRow.count_office_chat_unread,
          countTeamChatUnread: prefRow.count_team_chat_unread,
          countAssignmentChatUnread: prefRow.count_assignment_chat_unread,
          countDisputeChatUnread: prefRow.count_dispute_chat_unread,
          createdAt: prefRow.created_at,
          updatedAt: prefRow.updated_at,
        }
      }

      // 5) Threads in den Cache schreiben.
      //    Preview / sort / unread now sourced from my-participant.lastVisible*
      //    (post-M3-hotfix). Sort applied here in JS — Postgres no longer
      //    orders by chat_threads.last_message_at because that field leaks
      //    blocked-sender bumps.
      // Resume-Resilienz: optimistische temp_/pending/failed-Rows sind
      // Client-only-Wahrheit (der Failed-Bubble ist die einzige Retry-
      // Oberfläche, die den Nachrichtentext hält) — vor dem Wipe sichern und
      // nach der Repopulation dedupliziert re-appenden.
      const prevMessages = new Map(this.messagesByThread)
      this.threads.clear()
      this.messagesByThread.clear()
      const orderedRows = [...((threadRows ?? []) as ChatThreadRow[])].sort((a, b) => {
        const aP = (participantsByThread.get(a.id) ?? []).find((p) => p.userId === uid)
        const bP = (participantsByThread.get(b.id) ?? []).find((p) => p.userId === uid)
        const aAt = aP?.lastVisibleMessageAt ?? 0
        const bAt = bP?.lastVisibleMessageAt ?? 0
        return bAt - aAt
      })
      for (const row of orderedRows) {
        const participants = participantsByThread.get(row.id) ?? []
        const myP = participants.find((p) => p.userId === uid)
        const unread = computeUnreadCount(myP)
        const migrationStatus = migrationByThread.get(row.id) ?? 'migration_complete'
        this.threads.set(row.id, threadRowToViewModel(row, participants, unread, migrationStatus, myP))
      }

      // Block 3: load the current user's per-user hides BEFORE preload so the
      // read filter can drop them (a "Für mich" delete survives reload).
      await this.loadHiddenMessageIds(uid, gen)
      if (gen !== this._loadGeneration) return

      // 6) Pre-fetch chat_messages for all threads (small volume; OK
      //    for Phase 1b — Slice 5 will switch to per-thread on-demand fetch).
      const preloadOk = await this.preloadChatMessagesForThreads(threadIds, gen)
      if (gen !== this._loadGeneration) return

      if (preloadOk) {
        this.restoreOptimisticRows(prevMessages)
      } else {
        // Message-Preload schlug NACH dem Clear fehl: vorherigen Message-
        // Cache komplett behalten statt einer leeren Map. _hydrated wird
        // gleich true gesetzt — ein transienter Fetch-Fehler (Resume im
        // Funkloch) würde sonst alle Bubbles stumm wegwischen. Thread-Level-
        // Fehler brechen dagegen oben VOR dem Clear ab (catch unten).
        this.messagesByThread = prevMessages
        // Fehler signalisieren: der bootstrap-Resync wertet Repos mit
        // getLastError() als fehlgeschlagen — ohne das würde lastResyncAt
        // advancen und der nächste Resume-Retry 30s weggedebounced, mit
        // still-stalem Message-Cache dahinter.
        this._lastError = 'chat_messages preload failed — stale cache retained'
      }
      // Outbox: queued Sends (Cold-Reload-Überlebende) als pending-Bubbles
      // rekonstruieren — dedupliziert gegen Server-Rows + restaurierte
      // optimistische Rows.
      this.hydrateFromQueue(uid)

      this._hydrated = true
      this.subscribeRealtime(uid)
      this.notify()
      // Media-Outbox (IDB, async): survivors of a cold reload become pending/
      // failed bubbles, deduped against loaded rows. Fire-and-forget so the
      // initial render never blocks on IDB; it notifies + drains when done.
      void this.hydrateFromMediaOutbox(uid)
    } catch (err) {
      if (gen !== this._loadGeneration) return
      // Auth-lock steal (Sentry P0 FIXUP-WEB-56): a parallel boot/resume
      // reader stole the navigator.locks auth lock mid-query — the data is
      // fine, only the token read was aborted. Retry EXACTLY once against a
      // fresh generation instead of hard-failing the chat init. A second
      // lock-stolen failure falls through to the normal error path below
      // (stale-while-revalidate semantics unchanged).
      if (!isLockRetry && isAuthLockStolenError(err)) {
        logInfo('chat.repository.auth_lock_retry', { uid })
        await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_RETRY_DELAY_MS))
        // Re-check after the backoff: a resync/sign-out that arrived during
        // the wait owns the load now — retrying would only duplicate work.
        if (gen !== this._loadGeneration) return
        return this.loadForUser(uid, ++this._loadGeneration, true)
      }
      this._lastError = err instanceof Error ? err.message : String(err)
      this._hydrated = true
      logError('chat.repository.initialize_failed', err, { uid })
      this.notify()
    } finally {
      // Nur der Load der aktuellen Generation beendet die Revalidierung —
      // ein stale Load (gen-Guard-Abbruch) darf das Flag des frischen Loads
      // nicht vorzeitig löschen.
      if (gen === this._loadGeneration) this._revalidating = false
    }
  }

  /** Re-appends optimistic rows (temp_/pending/failed) that the resync wipe
   *  removed, deduped against freshly loaded server rows by
   *  clientMessageId+senderUserId (same match as replaceOptimistic). A failed
   *  send whose row IS now on the server (insert landed despite a client
   *  timeout) is dropped in favor of the server row. */
  private restoreOptimisticRows(prev: Map<string, ChatMessageViewModel[]>): void {
    for (const [threadId, msgs] of prev.entries()) {
      const optimistic = msgs.filter(
        (m) => m.id.startsWith('temp_') || m.status === 'pending' || m.status === 'failed',
      )
      if (optimistic.length === 0) continue
      const current = this.messagesByThread.get(threadId) ?? []
      const toAppend = optimistic.filter(
        (o) =>
          !current.some(
            (m) => m.clientMessageId === o.clientMessageId && m.senderUserId === o.senderUserId,
          ),
      )
      if (toAppend.length === 0) continue
      this.commitThreadMessages(threadId, [...current, ...toAppend])
    }
  }

  /**
   * Outbox-Anschluss (Lese-Seite): rebuilds optimistic 'pending' bubbles for
   * queued chat_messages inserts after a cold reload (WebView memory kill) —
   * mirrors SupabaseMessageRepository.hydrateFromQueue. In-memory optimistic
   * rows survive resyncs via restoreOptimisticRows; this covers the
   * localStorage queue across full reloads. The generic flush replays the raw
   * insert (upsert onConflict:'id'); the realtime INSERT echo then reconciles
   * the temp row via handleRealtimeInsert.
   */
  private hydrateFromQueue(uid: string): void {
    for (const m of getPendingMutations()) {
      if (m.table !== 'chat_messages' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      const payload = m.payload as Partial<ChatMessageRow>
      if (!payload?.id || !payload.thread_id || !payload.client_message_id) continue
      if (payload.sender_user_id !== uid) continue
      const thread = this.threads.get(payload.thread_id)
      if (!thread) continue
      const list = this.messagesByThread.get(payload.thread_id) ?? []
      if (
        list.some(
          (msg) =>
            msg.id === payload.id ||
            (msg.clientMessageId === payload.client_message_id && msg.senderUserId === uid),
        )
      ) continue
      const clientKey = optimisticKey(uid, payload.client_message_id)
      const tempId = `temp_${payload.client_message_id}`
      const role: ChatRole =
        thread.participants.find((p) => p.userId === uid)?.role ?? 'craftsman'
      const view: ChatMessageViewModel = {
        id: tempId,
        threadId: payload.thread_id,
        senderUserId: uid,
        clientMessageId: payload.client_message_id,
        body: payload.body ?? null,
        messageType: payload.message_type ?? 'text',
        artifactType: payload.artifact_type ?? null,
        artifactId: payload.artifact_id ?? null,
        replyToMessageId: payload.reply_to_message_id ?? null,
        createdAt: m.enqueuedAt,
        serverReceivedAt: m.enqueuedAt,
        deliveredAt: null,
        legacyMessageId: null,
        legacySource: null,
        deletedAt: null,
        redacted: false,
        redactedAt: null,
        redactedReason: null,
        attachments: [],
        status: 'pending',
        sender: { userId: uid, role, displayName: null, avatarUrl: null },
      }
      this.commitThreadMessages(payload.thread_id, [...list, view])
      this.optimisticByClientKey.set(clientKey, tempId)
      // Planned server id stays stable: a manual retry of this
      // clientMessageId must insert with the SAME id the queued replay uses.
      this.plannedServerIdByClientKey.set(clientKey, payload.id)
    }
  }

  /**
   * Media-Outbox read-side rehydration (mirror of hydrateFromQueue for media).
   * A voice/photo/document/video send queued in the IDB media outbox that has
   * no server row after a cold reload is rebuilt as a pending (state 'queued')
   * or failed (state 'failed') optimistic bubble — the outbox record is the
   * durable truth, the blob lives in recordingCache/attachmentPendingCache.
   * Deduped by clientMessageId+sender against server rows AND already-restored
   * optimistic rows (restoreOptimisticRows), then a drain is nudged so a queued
   * survivor retries immediately.
   */
  private async hydrateFromMediaOutbox(uid: string): Promise<void> {
    const gen = this._loadGeneration
    let records: MediaOutboxRecord[]
    try {
      records = await listMediaOutbox()
    } catch {
      return
    }
    if (gen !== this._loadGeneration) return
    if (records.length === 0) return

    let mutated = false
    for (const record of records) {
      const thread = this.threads.get(record.threadId)
      if (!thread) continue
      const list = this.messagesByThread.get(record.threadId) ?? []
      const alreadyPresent = list.some(
        (m) => m.clientMessageId === record.clientMessageId && m.senderUserId === uid,
      )
      if (alreadyPresent) continue

      const tempId = `temp_${record.clientMessageId}`
      const clientKey = optimisticKey(uid, record.clientMessageId)
      const role: ChatRole =
        thread.participants.find((p) => p.userId === uid)?.role ?? 'craftsman'
      const status: ChatMessageStatus = record.state === 'failed' ? 'failed' : 'pending'
      const messageType = record.kind === 'image' ? 'image' : record.kind
      const attachment: ChatAttachment = {
        id: `temp_att_${record.clientMessageId}`,
        messageId: tempId,
        assetType: record.kind,
        mimeType: record.mimeType,
        sizeBytes: 0,
        storageBucket: bucketForChannel(record.channelType),
        storagePath: record.storagePath || '',
        width: record.metadata.width ?? null,
        height: record.metadata.height ?? null,
        durationMs: record.metadata.durationMs ?? null,
        posterStoragePath: record.metadata.posterStoragePath ?? null,
        transcript: null,
        transcriptLanguage: null,
        uploadedAt: record.createdAt,
        deletedAt: null,
        fileName: record.fileName,
        transcodeStatus: 'none',
        h264Url: null,
        posterUrl: null,
        transcodeProvider: null,
        transcodeError: null,
      }
      const view: ChatMessageViewModel = {
        id: tempId,
        threadId: record.threadId,
        senderUserId: uid,
        clientMessageId: record.clientMessageId,
        body: record.metadata.caption ?? null,
        messageType,
        artifactType: null,
        artifactId: null,
        replyToMessageId: null,
        createdAt: record.createdAt,
        serverReceivedAt: record.createdAt,
        deliveredAt: null,
        legacyMessageId: null,
        legacySource: null,
        deletedAt: null,
        redacted: false,
        redactedAt: null,
        redactedReason: null,
        attachments: [attachment],
        status,
        sender: { userId: uid, role, displayName: null, avatarUrl: null },
      }
      this.commitThreadMessages(record.threadId, [...list, view])
      this.optimisticByClientKey.set(clientKey, tempId)
      mutated = true
    }

    if (mutated) this.notify()
    // Retry queued survivors now that their bubbles exist.
    requestOutboxDrain()
  }

  /** Returns false when the message fetch itself failed — the caller keeps
   *  the previous message cache instead of leaving a wiped-empty map behind
   *  a repo that reports _hydrated=true. */
  private async preloadChatMessagesForThreads(threadIds: string[], gen: number): Promise<boolean> {
    if (threadIds.length === 0) return true
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .in('thread_id', threadIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(2000)
    if (error) {
      logError('chat.repository.chat_messages_preload_failed', error, { threadCount: threadIds.length })
      return false
    }
    if (gen !== this._loadGeneration) return true
    const rows = this.excludeHidden((data ?? []) as ChatMessageRow[])
    // CHAT-2: hydrate chat_attachments for media messages. Without this every
    // media bubble degraded to an empty text bubble after reload.
    const attMap = await this.fetchAttachmentsByMessageIds(mediaMessageIds(rows))
    if (gen !== this._loadGeneration) return true
    const grouped = new Map<string, ChatMessageViewModel[]>()
    for (const row of rows) {
      const t = this.threads.get(row.thread_id)
      const role: ChatRole =
        t?.participants.find((p) => p.userId === row.sender_user_id)?.role ?? 'craftsman'
      const view = messageRowToViewModel(row, attMap.get(row.id) ?? [], 'sent', role)
      const arr = grouped.get(row.thread_id) ?? []
      arr.push(view)
      grouped.set(row.thread_id, arr)
    }
    for (const [threadId, msgs] of grouped.entries()) {
      this.commitThreadMessages(threadId, msgs)
    }
    return true
  }

  /** Block 3: fetch the current user's chat_message_hidden ids into the
   *  exclusion set. Graceful — on error the set is left unchanged (a transient
   *  failure never re-surfaces or wipes hidden messages). RLS scopes to own
   *  rows; the explicit user_id filter is belt-and-suspenders. */
  private async loadHiddenMessageIds(uid: string, gen: number): Promise<void> {
    const { data, error } = await supabase
      .from('chat_message_hidden')
      .select('message_id')
      .eq('user_id', uid)
    if (error) {
      logError('chat.repository.hidden_load_failed', error, { uid })
      return
    }
    if (gen !== this._loadGeneration) return
    this.hiddenMessageIds = new Set(
      (data ?? []).map((r) => (r as { message_id: string }).message_id),
    )
  }

  /** Drops rows the current user hid for themselves ("Für mich"). Applied by
   *  every chat_messages read path so a hide survives reload + resume. */
  private excludeHidden(rows: ChatMessageRow[]): ChatMessageRow[] {
    if (this.hiddenMessageIds.size === 0) return rows
    return rows.filter((r) => !this.hiddenMessageIds.has(r.id))
  }

  /**
   * CHAT-2: Fetch chat_attachments for a set of message ids, grouped by
   * message_id. Chunked .in() — PostgREST GET-URL limits cap at ~100 uuids
   * per request with up to 2000 preloaded messages (chunking is a
   * correctness requirement, not an optimisation).
   * Graceful degradation: on fetch error, logs + returns what was collected
   * so far — the message still renders (without attachments), consistent
   * with the existing error-swallowing of the read paths.
   */
  private async fetchAttachmentsByMessageIds(
    messageIds: string[],
  ): Promise<Map<string, ChatAttachment[]>> {
    const byMessage = new Map<string, ChatAttachment[]>()
    if (messageIds.length === 0) return byMessage
    for (let i = 0; i < messageIds.length; i += ATTACHMENT_FETCH_CHUNK_SIZE) {
      const chunk = messageIds.slice(i, i + ATTACHMENT_FETCH_CHUNK_SIZE)
      const { data, error } = await supabase
        .from('chat_attachments')
        .select('*')
        .in('message_id', chunk)
        .is('deleted_at', null)
      if (error) {
        logError('chat.repository.attachments_fetch_failed', error, {
          chunkStart: i,
          chunkSize: chunk.length,
          totalIds: messageIds.length,
        })
        return byMessage
      }
      for (const row of (data ?? []) as ChatAttachmentRow[]) {
        const view = attachmentRowToView(row)
        const arr = byMessage.get(row.message_id) ?? []
        arr.push(view)
        byMessage.set(row.message_id, arr)
      }
    }
    return byMessage
  }

  private subscribeRealtime(uid: string, fromReconnection = false): void {
    this.installNetworkListeners()
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
      this.realtimeChannel = null
    }
    const myGen = ++this.realtimeGeneration
    const channel = supabase
      .channel(`fixup-chat-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          const row = payload.new as ChatMessageRow
          this.handleRealtimeInsert(row)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          const row = payload.new as ChatMessageRow
          this.handleRealtimeUpdate(row)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_threads' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          const row = payload.new as ChatThreadRow
          this.handleThreadRealtimeUpdate(row)
        },
      )
      // Post-M3-hotfix: subscribe to chat_participants UPDATE so my row's
      // last_visible_message_* bumps (or stays) deliver into the cache without
      // a re-hydrate. The trigger only updates chat_participants for users who
      // have NOT blocked the sender, so non-events for blocked-from messages
      // are physically absent (silent drop end-to-end).
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_participants' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          const row = payload.new as ChatParticipantRow
          this.handleParticipantRealtimeUpdate(row)
        },
      )
      // CHAT-2: chat_attachments INSERT — the receiver's chat_messages INSERT
      // echo carries [] attachments (only the sender keeps its optimistic
      // ones); this listener hydrates the attachment into the cached message
      // so media bubbles render live instead of as empty text bubbles.
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_attachments' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          this.handleAttachmentRealtimeInsert(payload.new as ChatAttachmentRow)
        },
      )
      // CHAT-2: chat_attachments UPDATE — delivers transcode status /
      // h264_url / poster_url live (mediaProcessingAdapter webhook) instead
      // of only after reload.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_attachments' },
        (payload) => {
          if (myGen !== this.realtimeGeneration) return
          this.handleAttachmentRealtimeUpdate(payload.new as ChatAttachmentRow)
        },
      )
      .subscribe((status) => {
        if (myGen !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
          }
          // Gap-refetch after a reconnect: every event emitted while the
          // channel was down is lost — fetch everything newer than the cache.
          if (fromReconnection) void this.fallbackRefresh(uid)
          // A live socket is the moment queued media can flow — drain the
          // outbox (WhatsApp: reconnect flushes the send queue).
          requestOutboxDrain()
          this.recomputeConnectionState()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logInfo('chat.realtime.degraded', { status })
          this.recomputeConnectionState()
          // Recovery (Block 3, pattern: SupabaseMessageRepository): gap-refetch
          // immediately so the timeline stays current even without realtime,
          // then re-subscribe with unbounded, capped exponential backoff.
          void this.fallbackRefresh(uid)
          this.attemptReconnection(uid)
        }
      })
    this.realtimeChannel = channel
  }

  /**
   * Gap-refetch (non-destructive): fetch chat_messages newer than the newest
   * server-confirmed row in the cache and reconcile them through the realtime
   * insert path (dedupe by server id, optimistic replace by
   * clientMessageId+sender). Never clears the cache — Block-1
   * stale-while-revalidate semantics: a failing fetch leaves everything as-is.
   */
  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      const gen = this._loadGeneration
      const threadIds = [...this.threads.keys()]
      if (threadIds.length === 0) return
      logInfo('chat.realtime.fallback_refresh', { uid, threadCount: threadIds.length })
      const since = this.maxCachedServerCreatedAt()
      let query = supabase
        .from('chat_messages')
        .select('*')
        .in('thread_id', threadIds)
        .is('deleted_at', null)
      if (since > 0) query = query.gt('created_at', since)
      const { data, error } = await query
        .order('created_at', { ascending: true })
        .limit(2000)
      if (error) {
        logError('chat.repository.fallback_refresh_failed', error, { uid })
        return
      }
      if (gen !== this._loadGeneration) return
      const rows = (data ?? []) as ChatMessageRow[]
      if (rows.length > 0) {
        // Hydrate attachments for media rows missed during the outage — their
        // chat_attachments INSERT events were lost together with the message events.
        const attMap = await this.fetchAttachmentsByMessageIds(mediaMessageIds(rows))
        if (gen !== this._loadGeneration) return
        for (const row of rows) {
          this.handleRealtimeInsert(row, attMap.get(row.id) ?? [])
        }
      }
      // Reconcile tombstones too — runs even when there were no new inserts.
      await this.reconcileTombstonesOnReconnect(threadIds, gen)
    } catch (err) {
      logError('chat.repository.fallback_refresh_error', err, { uid })
    }
  }

  /**
   * Reconcile soft-delete / redaction tombstones missed during a realtime
   * outage. The insert-only {@link fallbackRefresh} query never removes an
   * already-cached row: a message soft-deleted or moderator-redacted while the
   * channel was down carries `deleted_at` (excluded by the `deleted_at IS NULL`
   * filter) and an old `created_at` (excluded by the since-cursor), so its
   * tombstone is never applied and the peer keeps seeing the original text.
   *
   * We fetch the (bounded) set of currently deleted/redacted rows in the cached
   * threads and route them through {@link handleRealtimeUpdate}, which no-ops
   * for any row not in the local cache — so reconciling old, never-cached
   * deletions is harmless. chat_messages is REPLICA IDENTITY FULL, so the live
   * UPDATE path carries these fields too; this only closes the outage gap.
   */
  private async reconcileTombstonesOnReconnect(threadIds: string[], gen: number): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .in('thread_id', threadIds)
        .or('deleted_at.not.is.null,redacted.is.true')
        .order('created_at', { ascending: false })
        .limit(2000)
      if (error || !data) return
      if (gen !== this._loadGeneration) return
      for (const row of data as ChatMessageRow[]) {
        this.handleRealtimeUpdate(row)
      }
    } catch (err) {
      logError('chat.repository.tombstone_reconcile_error', err, {})
    }
  }

  /** Newest server-confirmed createdAt across all cached threads — the
   *  since-cursor for the gap-refetch. Optimistic rows (temp_/pending/failed)
   *  carry client clock and are excluded; for echo-replaced rows (which keep
   *  the optimistic createdAt against timeline jumps) the server-stamped
   *  serverReceivedAt bounds the cursor so client clock skew can never push
   *  it past unseen server rows. */
  private maxCachedServerCreatedAt(): number {
    let max = 0
    for (const list of this.messagesByThread.values()) {
      for (const m of list) {
        if (m.id.startsWith('temp_') || m.status !== 'sent') continue
        const at = Math.min(m.createdAt, m.serverReceivedAt)
        if (at > max) max = at
      }
    }
    return max
  }

  /** Re-subscribe with UNBOUNDED capped exponential backoff (3s → 60s cap).
   *  Root-cause P1 §5: the old 5-attempt ceiling left the channel dead until
   *  the next app-resume after a ~45s blackout. A live socket is the only path
   *  that flushes the outbox, so we never give up — the delay just plateaus at
   *  60s. `online` / `visibilitychange` / app-resume pre-empt the wait. */
  private attemptReconnection(uid: string): void {
    if (this.reconnectTimer) return // a reconnect is already scheduled
    const delay = Math.min(
      this.RECONNECT_MAX_DELAY,
      this.RECONNECT_BASE_DELAY * 2 ** this.reconnectAttempts,
    )
    this.reconnectAttempts++
    logInfo('chat.realtime.reconnect_attempt', { uid, attempt: this.reconnectAttempts, delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.subscribeRealtime(uid, true)
      }
    }, delay)
  }

  /** Single write chokepoint for messagesByThread: every mutation commits
   *  through here so {@link enforceClientMessageUniqueness} holds as a cache
   *  invariant regardless of which path (optimistic insert, ACK, Realtime
   *  echo, gap-refetch, resync merge, outbox rehydration) wrote last.
   *  Does NOT notify — callers own their notify()/listener semantics. */
  private commitThreadMessages(threadId: string, next: ChatMessageViewModel[]): void {
    this.messagesByThread.set(threadId, enforceClientMessageUniqueness(next))
  }

  private handleRealtimeInsert(row: ChatMessageRow, fetchedAttachments: ChatAttachment[] = []): void {
    // Block 3: a message the current user hid for themselves ("Für mich") must
    // not be re-surfaced by the live INSERT listener nor the gap-refetch
    // (fallbackRefresh) — both funnel through here. The other reads filter via
    // excludeHidden; this is the realtime chokepoint equivalent.
    if (this.hiddenMessageIds.has(row.id)) return
    const existing = this.messagesByThread.get(row.thread_id) ?? []
    const clientKey = optimisticKey(row.sender_user_id, row.client_message_id)

    // P0-1: Three-way reconcile against optimistic + ACK + Realtime echo.
    // 1. If a Realtime row with the SAME server `id` already exists → no-op
    //    (e.g. ACK ran first, this is the echo we just placed).
    if (existing.some((m) => m.id === row.id)) {
      return
    }
    // 2. Find optimistic-pending by clientMessageId+sender (this is the
    //    sender's own echo) — replace in place.
    const dupIdx = existing.findIndex(
      (m) =>
        m.clientMessageId === row.client_message_id && m.senderUserId === row.sender_user_id,
    )
    const role: ChatRole =
      this.threads.get(row.thread_id)?.participants.find((p) => p.userId === row.sender_user_id)
        ?.role ?? 'craftsman'
    const optimistic = dupIdx >= 0 ? existing[dupIdx] : null
    // Preserve optimistic attachments (video/image/doc) when replacing the
    // optimistic row. Realtime fires on chat_messages only — no attachment join
    // until Slice 5. Without this, video/image bubbles lose their attachment data
    // the moment the Realtime echo arrives and fall back to a plain text bubble.
    // The gap-refetch path (fallbackRefresh) passes server-hydrated attachments
    // for rows whose chat_attachments events were missed during the outage.
    const attachments =
      fetchedAttachments.length > 0 ? fetchedAttachments : (optimistic?.attachments ?? [])
    let view = messageRowToViewModel(row, attachments, 'sent', role)
    if (optimistic) {
      // Twofer (Block 3): keep the optimistic row's createdAt when replacing —
      // screens sort chronologically by createdAt; swapping in the server
      // timestamp under client clock skew makes the bubble jump in the
      // timeline. Server createdAt only applies to rows we did not send
      // optimistically. clientMessageId is identical on both sides (UNIQUE
      // sender+clientMessageId), so clientMessageId-keyed rendering stays
      // stable across the replace.
      view = { ...view, createdAt: optimistic.createdAt }
    }
    if (dupIdx >= 0) {
      const updated = [...existing]
      updated[dupIdx] = view
      this.commitThreadMessages(row.thread_id, updated)
    } else {
      this.commitThreadMessages(row.thread_id, [...existing, view])
    }
    // Drop tracking entry — sender + clientMessageId is now reconciled.
    this.optimisticByClientKey.delete(clientKey)
    this.threadListeners.get(row.thread_id)?.forEach((l) => l(view))
    this.notify()
  }

  private handleRealtimeUpdate(row: ChatMessageRow): void {
    const list = this.messagesByThread.get(row.thread_id)
    if (!list) return
    const idx = list.findIndex((m) => m.id === row.id)
    if (idx < 0) return
    const role: ChatRole = list[idx].sender.role
    const updated = [...list]
    updated[idx] = {
      ...messageRowToViewModel(row, list[idx].attachments ?? [], 'sent', role),
      // Keep the cached createdAt: echo-replaced own sends preserve the
      // optimistic timestamp (timeline stability) — a later UPDATE event
      // (e.g. redaction) must not re-introduce the clock-skew jump.
      createdAt: list[idx].createdAt,
    }
    this.commitThreadMessages(row.thread_id, updated)
    this.notify()
  }

  private handleThreadRealtimeUpdate(row: ChatThreadRow): void {
    const cached = this.threads.get(row.id)
    if (!cached) return
    // Post-M3-hotfix: don't copy last_message_* from chat_threads — those are
    // global server truth and leak blocked-sender bumps. The per-participant
    // last_visible_* fields drive preview / sort / unread and are kept in
    // sync via handleParticipantRealtimeUpdate.
    const updated: ChatThreadViewModel = {
      ...cached,
      title: row.title,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
    }
    this.threads.set(row.id, updated)
    this.threadListListeners.forEach((l) => l(updated))
    this.notify()
  }

  private handleParticipantRealtimeUpdate(row: ChatParticipantRow): void {
    if (row.user_id !== this.currentUid) return
    const cached = this.threads.get(row.thread_id)
    if (!cached) return
    const myParticipant = participantRowToView(row)
    const otherParticipants = cached.participants.filter((p) => p.userId !== row.user_id)
    const participants = [...otherParticipants, myParticipant]
    const unread = computeUnreadCount(myParticipant)
    const updated: ChatThreadViewModel = {
      ...cached,
      participants,
      lastMessageId:   myParticipant.lastVisibleMessageId   ?? null,
      lastMessageAt:   myParticipant.lastVisibleMessageAt   ?? null,
      lastMessageBody: myParticipant.lastVisibleMessageBody ?? null,
      unreadCount: unread,
    }
    this.threads.set(row.thread_id, updated)
    this.threadListListeners.forEach((l) => l(updated))
    this.notify()
  }

  /** Locate the cached message owning an attachment row. Linear scan over
   *  threads is cheap — preload caps the cache at ≤2000 messages. */
  private findCachedMessageByServerId(
    messageId: string,
  ): { threadId: string; index: number; list: ChatMessageViewModel[] } | null {
    for (const [threadId, list] of this.messagesByThread.entries()) {
      const index = list.findIndex((m) => m.id === messageId)
      if (index >= 0) return { threadId, index, list }
    }
    return null
  }

  async deleteMessage(messageId: string, mode: ChatDeleteMode): Promise<void> {
    const { error } = await supabase.rpc('rpc_delete_chat_message', {
      p_message_id: messageId,
      p_mode: mode,
    })
    if (error) {
      logError('chat.repository.delete_message_failed', error, { messageId, mode })
      throw error
    }
    if (mode === 'self') {
      // Hide locally + remember the id so reload / resume reads keep it dropped.
      this.hiddenMessageIds.add(messageId)
      this.removeMessageFromCache(messageId)
    } else {
      // Optimistic tombstone; the realtime UPDATE echo reconciles to the same
      // redacted view (idempotent) and the attachment-delete echo drops blobs.
      this.applyLocalRedaction(messageId)
    }
    this.notify()
  }

  /** Removes a message from its cached thread list ("Für mich" hide). */
  private removeMessageFromCache(messageId: string): void {
    const located = this.findCachedMessageByServerId(messageId)
    if (!located) return
    const { threadId, list } = located
    this.commitThreadMessages(
      threadId,
      list.filter((m) => m.id !== messageId),
    )
  }

  /** Marks a cached message redacted in place ("Für alle" tombstone): clears
   *  the body + attachments but keeps the row so the tombstone renders. */
  private applyLocalRedaction(messageId: string): void {
    const located = this.findCachedMessageByServerId(messageId)
    if (!located) return
    const { threadId, index, list } = located
    const updated = [...list]
    updated[index] = {
      ...list[index],
      redacted: true,
      redactedAt: list[index].redactedAt ?? Date.now(),
      redactedReason: 'sender_unsend',
      body: null,
      attachments: [],
    }
    this.commitThreadMessages(threadId, updated)
  }

  private handleAttachmentRealtimeInsert(row: ChatAttachmentRow): void {
    if (row.deleted_at) return
    const located = this.findCachedMessageByServerId(row.message_id)
    // Message not cached yet: commit order guarantees the chat_messages
    // INSERT precedes chat_attachments in the same tx — if its event has not
    // landed, the read paths (preload / getMessagesSince /
    // fetchMessagesForThread) hydrate the attachment later.
    if (!located) return
    const { threadId, index, list } = located
    const msg = list[index]
    const attachments = msg.attachments ?? []
    // Dedup by server id (echo of a row we already placed).
    if (attachments.some((a) => a.id === row.id)) return
    const view = attachmentRowToView(row)
    // Sender-echo: handleRealtimeInsert preserves the optimistic
    // `temp_att_*` attachment when replacing the optimistic message row —
    // REPLACE it instead of appending a duplicate. Match by storagePath
    // (image/doc/video set it via updateOptimisticAttachment); fall back to
    // asset-type match on a path-less temp row (voice never patches the
    // storagePath).
    let tempIdx = attachments.findIndex(
      (a) => a.id.startsWith('temp_att_') && a.storagePath !== '' && a.storagePath === row.storage_path,
    )
    if (tempIdx < 0) {
      tempIdx = attachments.findIndex(
        (a) => a.id.startsWith('temp_att_') && a.storagePath === '' && a.assetType === row.asset_type,
      )
    }
    let nextAttachments: ChatAttachment[]
    if (tempIdx >= 0) {
      const replaced = attachments[tempIdx]
      nextAttachments = [...attachments]
      if (replaced.localBlobUrl) {
        // Media double-load fix (Block 3): do NOT revoke the optimistic blob
        // URL here — the bubble's signed URL is not resolved yet, an
        // immediate revoke blanks the already-rendered image for a flash.
        // Carry the blob over to the server view and revoke after a grace
        // period, once the signed URL had time to load.
        nextAttachments[tempIdx] = { ...view, localBlobUrl: replaced.localBlobUrl }
        this.scheduleLocalBlobRevoke(row.message_id, row.id, replaced.localBlobUrl)
      } else {
        nextAttachments[tempIdx] = view
      }
    } else {
      nextAttachments = [...attachments, view]
    }
    const updatedMsg: ChatMessageViewModel = { ...msg, attachments: nextAttachments }
    const updated = [...list]
    updated[index] = updatedMsg
    this.commitThreadMessages(threadId, updated)
    this.threadListeners.get(threadId)?.forEach((l) => l(updatedMsg))
    this.notify()
  }

  /** Deferred revoke for a blob URL carried over onto a server attachment
   *  view (see handleAttachmentRealtimeInsert). Revokes the URL and strips
   *  the field from the cached view so the UI falls back to the (by now
   *  loaded) signed URL. If the cache was reloaded in the meantime the fresh
   *  server view no longer carries the blob — then only the revoke runs. */
  private scheduleLocalBlobRevoke(messageId: string, attachmentId: string, blobUrl: string): void {
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl) } catch { /* best-effort */ }
      const located = this.findCachedMessageByServerId(messageId)
      if (!located) return
      const { threadId, index, list } = located
      const msg = list[index]
      const attachments = msg.attachments ?? []
      const attIdx = attachments.findIndex(
        (a) => a.id === attachmentId && a.localBlobUrl === blobUrl,
      )
      if (attIdx < 0) return
      const nextAttachments = [...attachments]
      nextAttachments[attIdx] = { ...nextAttachments[attIdx], localBlobUrl: undefined }
      const updated = [...list]
      updated[index] = { ...msg, attachments: nextAttachments }
      this.commitThreadMessages(threadId, updated)
      this.notify()
    }, LOCAL_BLOB_REVOKE_GRACE_MS)
  }

  private handleAttachmentRealtimeUpdate(row: ChatAttachmentRow): void {
    const located = this.findCachedMessageByServerId(row.message_id)
    if (!located) return
    const { threadId, index, list } = located
    const msg = list[index]
    const attachments = msg.attachments ?? []
    const attIdx = attachments.findIndex((a) => a.id === row.id)
    if (attIdx < 0) return
    let nextAttachments: ChatAttachment[]
    if (row.deleted_at) {
      // Soft-delete mirrors the read paths' `.is('deleted_at', null)` filter.
      nextAttachments = attachments.filter((a) => a.id !== row.id)
    } else {
      nextAttachments = [...attachments]
      nextAttachments[attIdx] = attachmentRowToView(row)
    }
    const updatedMsg: ChatMessageViewModel = { ...msg, attachments: nextAttachments }
    const updated = [...list]
    updated[index] = updatedMsg
    this.commitThreadMessages(threadId, updated)
    this.threadListeners.get(threadId)?.forEach((l) => l(updatedMsg))
    this.notify()
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  getThread(threadId: string): ChatThreadViewModel | undefined {
    return this.threads.get(threadId)
  }

  /**
   * CHAT-1: Idempotent single-thread cache-seed. A thread freshly created via
   * get-or-create RPC never reaches the cache before the next full hydrate —
   * Realtime subscribes no chat_threads INSERT and handleThreadRealtimeUpdate
   * ignores unknown threads — so the first send always failed with
   * thread_not_found. Mirrors the loadForUser mapping for ONE thread.
   * Never throws: fetch error / RLS-invisible / stale generation → undefined.
   */
  async ensureThreadInCache(threadId: string): Promise<ChatThreadViewModel | undefined> {
    const cached = this.threads.get(threadId)
    if (cached) return cached
    // Generation snapshot — logout/account-switch during the fetch must not
    // seed a stale cache (Block-A hydration-race pattern).
    const gen = this._loadGeneration
    try {
      const { data: threadRow, error: threadErr } = await supabase
        .from('chat_threads')
        .select('*')
        .eq('id', threadId)
        .maybeSingle()
      if (threadErr) throw threadErr
      if (gen !== this._loadGeneration) return undefined
      if (!threadRow) return undefined

      const { data: participantRows, error: pErr } = await supabase
        .from('chat_participants')
        .select('*')
        .eq('thread_id', threadId)
      if (pErr) throw pErr
      if (gen !== this._loadGeneration) return undefined

      // Same default as loadForUser: RPC-created threads have no migration
      // row — they were born in the new world.
      const { data: migrationRow } = await supabase
        .from('chat_thread_migration_status')
        .select('thread_id, status')
        .eq('thread_id', threadId)
        .maybeSingle()
      if (gen !== this._loadGeneration) return undefined

      const participants = ((participantRows ?? []) as ChatParticipantRow[]).map(participantRowToView)
      const myP = participants.find((p) => p.userId === this.currentUid)
      const unread = computeUnreadCount(myP)
      const migrationStatus = (migrationRow?.status as ChatMigrationStatus | undefined) ?? 'migration_complete'
      const view = threadRowToViewModel(threadRow as ChatThreadRow, participants, unread, migrationStatus, myP)
      this.threads.set(threadId, view)
      this.threadListListeners.forEach((l) => l(view))
      this.notify()
      return view
    } catch (err) {
      logError('chat.repository.ensure_thread_in_cache_failed', err, { threadId })
      return undefined
    }
  }

  getThreads(channelType?: ChatChannelType): ChatThreadViewModel[] {
    const all = [...this.threads.values()]
    if (!channelType) return all
    return all.filter((t) => t.channelType === channelType)
  }

  getMessages(threadId: string): ChatMessageViewModel[] {
    return this.messagesByThread.get(threadId) ?? []
  }

  async getMessagesSince(threadId: string, sinceMessageId: string): Promise<ChatMessageViewModel[]> {
    const cached = this.messagesByThread.get(threadId) ?? []
    const sinceCached = cached.find((m) => m.id === sinceMessageId)
    if (!sinceCached) {
      // Refetch komplett wenn cursor nicht im Cache ist
      return this.fetchMessagesForThread(threadId)
    }
    const gen = this._loadGeneration
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      // Resume/gap read must drop soft-deleted rows so a message deleted while
      // the app was backgrounded is not re-pulled into the cache and re-rendered.
      // Mirrors the other cache-loading reads (preloadChatMessagesForThreads,
      // fallbackRefresh) which both filter `.is('deleted_at', null)`.
      .is('deleted_at', null)
      .gt('created_at', sinceCached.createdAt)
      .order('created_at', { ascending: true })
    if (error) {
      logError('chat.repository.getMessagesSince_failed', error, { threadId, sinceMessageId })
      return []
    }
    if (gen !== this._loadGeneration) return []
    const rows = this.excludeHidden((data ?? []) as ChatMessageRow[])
    // CHAT-2: hydrate attachments for media messages in the reconcile gap.
    const attMap = await this.fetchAttachmentsByMessageIds(mediaMessageIds(rows))
    if (gen !== this._loadGeneration) return []
    const senderRoles = this.buildSenderRoleMap(threadId)
    const newMsgs = rows.map((row) =>
      messageRowToViewModel(row, attMap.get(row.id) ?? [], 'sent', senderRoles.get(row.sender_user_id) ?? 'craftsman'),
    )
    if (newMsgs.length > 0) {
      const merged = mergeMessages(this.messagesByThread.get(threadId) ?? cached, newMsgs)
      this.commitThreadMessages(threadId, merged)
      this.notify()
    }
    return newMsgs
  }

  private buildSenderRoleMap(threadId: string): Map<string, ChatRole> {
    const t = this.threads.get(threadId)
    const map = new Map<string, ChatRole>()
    if (!t) return map
    for (const p of t.participants) map.set(p.userId, p.role)
    return map
  }

  private async fetchMessagesForThread(threadId: string): Promise<ChatMessageViewModel[]> {
    const gen = this._loadGeneration
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', threadId)
      // Full thread refetch (cursor lost / resume) must drop soft-deleted rows,
      // identical to preloadChatMessagesForThreads + fallbackRefresh — otherwise
      // a message deleted while backgrounded re-enters the cache on reconnect.
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
    if (error) {
      logError('chat.repository.fetchMessages_failed', error, { threadId })
      return []
    }
    if (gen !== this._loadGeneration) return []
    const rows = this.excludeHidden((data ?? []) as ChatMessageRow[])
    // CHAT-2: hydrate attachments for media messages.
    const attMap = await this.fetchAttachmentsByMessageIds(mediaMessageIds(rows))
    if (gen !== this._loadGeneration) return []
    const roles = this.buildSenderRoleMap(threadId)
    const view = rows.map((row) =>
      messageRowToViewModel(row, attMap.get(row.id) ?? [], 'sent', roles.get(row.sender_user_id) ?? 'craftsman'),
    )
    this.commitThreadMessages(threadId, view)
    this.notify()
    return view
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<ChatMessageViewModel> {
    if (!this.currentUid) throw new Error('chat.sendMessage: no authenticated session')
    const uid = this.currentUid

    // Coexistence-Send-Guard: a legacy synth-thread must finish migration
    // BEFORE any send. Master-Plan §11.2: "NIEMALS Split-Brain."
    // The caller (workflow) should surface a "Wird synchronisiert…" hint.
    const targetThread = this.threads.get(input.threadId)
    if (
      targetThread &&
      (targetThread.migrationStatus === 'not_migrated' ||
        targetThread.migrationStatus === 'migration_queued' ||
        targetThread.migrationStatus === 'migrating' ||
        targetThread.migrationStatus === 'migration_failed')
    ) {
      // Trigger migration if not already in flight
      if (targetThread.legacyThreadId && targetThread.legacySource) {
        void this.enqueueMigration(
          targetThread.legacyThreadId,
          targetThread.legacySource as ChatLegacySource,
          200,
        ).catch(() => undefined)
      }
      throw new ChatMigrationPendingError(input.threadId, targetThread.migrationStatus)
    }

    // Optimistic-Insert mit status='pending'
    const tempId = `temp_${input.clientMessageId}`
    const clientKey = optimisticKey(uid, input.clientMessageId)
    const now = Date.now()
    const role: ChatRole =
      this.threads.get(input.threadId)?.participants.find((p) => p.userId === uid)?.role ?? 'craftsman'
    const optimistic: ChatMessageViewModel = {
      id: tempId,
      threadId: input.threadId,
      senderUserId: uid,
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
      attachments: [],
      status: 'pending',
      sender: { userId: uid, role, displayName: null, avatarUrl: null },
    }
    const existing = this.messagesByThread.get(input.threadId) ?? []
    const existingIdx = existing.findIndex((m) => m.id === tempId)
    if (existingIdx >= 0) {
      // Retry path: reset failed row to pending instead of appending a duplicate.
      const updated = [...existing]
      updated[existingIdx] = { ...updated[existingIdx], status: 'pending' }
      this.commitThreadMessages(input.threadId, updated)
    } else {
      this.commitThreadMessages(input.threadId, [...existing, optimistic])
    }
    this.optimisticByClientKey.set(clientKey, tempId)
    this.notify()

    // Outbox-Replay-Idempotenz: Server-Row-id CLIENT-seitig generieren und
    // über Retries desselben clientMessageId stabil halten (s. Feld-Doku).
    const plannedId = this.plannedServerIdByClientKey.get(clientKey) ?? generateUUID()
    this.plannedServerIdByClientKey.set(clientKey, plannedId)
    const insertPayload = {
      id: plannedId,
      thread_id: input.threadId,
      sender_user_id: uid,
      client_message_id: input.clientMessageId,
      body: input.body ?? null,
      message_type: input.messageType ?? 'text',
      artifact_type: input.artifactType ?? null,
      artifact_id: input.artifactId ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
    }

    // Offline-Send = Erfolg aus User-Sicht (WhatsApp): statt einen roten
    // Fehler zu werfen, bleibt die Bubble 'pending' und der Text landet in der
    // Pending-Mutation-Outbox — der Reconnect-Flush (hydrateFromQueue /
    // flushPendingMutations) sendet ihn. Kein Throw, kein failed-State.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      enqueuePendingMutation({
        operation: 'insert',
        table: 'chat_messages',
        payload: insertPayload as unknown as Record<string, unknown>,
        domain: 'chat',
        entityId: input.clientMessageId,
      })
      const list = this.messagesByThread.get(input.threadId) ?? []
      const pendingView = list.find((m) => m.id === tempId)
      return pendingView ?? optimistic
    }

    // Persist mit clientMessageId-Idempotency. AbortSignal.timeout: ein
    // hängender Fetch muss deterministisch in 'failed' enden statt die
    // Bubble (und den Screen-Send-Lock) unbegrenzt 'pending' zu halten.
    let data: unknown = null
    let error: (Error & { code?: string }) | null = null
    try {
      const result = await supabase
        .from('chat_messages')
        .insert(insertPayload)
        .select('*')
        .abortSignal(AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS))
        .single()
      data = result.data
      error = result.error
    } catch (err) {
      // postgrest-js liefert Fetch-Fehler (inkl. Abort) als `error` zurück —
      // dieser Catch ist das Sicherheitsnetz, damit KEIN Throw-Pfad die
      // Bubble jemals dauerhaft 'pending' zurücklassen kann.
      error = err instanceof Error ? err : new Error(String(err))
    }

    if (error) {
      // Bei UNIQUE-Conflict (gleicher clientMessageId): re-fetch existing row
      const isUniqueConflict =
        typeof error.code === 'string' && (error.code === '23505' || error.code === 'PGRST116')
      if (isUniqueConflict) {
        const { data: existingRow } = await supabase
          .from('chat_messages')
          .select('*')
          .eq('sender_user_id', uid)
          .eq('client_message_id', input.clientMessageId)
          .abortSignal(AbortSignal.timeout(SEND_MESSAGE_TIMEOUT_MS))
          .single()
        if (existingRow) {
          const view = messageRowToViewModel(existingRow as ChatMessageRow, [], 'sent', role)
          this.replaceOptimistic(input.threadId, tempId, view)
          this.clearSendOutbox(uid, input.clientMessageId)
          return view
        }
      }
      // Transienter Fehler (Netz-Drop, Abort/Timeout — postgrest mappt
      // Fetch-Aborts auf einen code-losen Error): für Background-Replay in
      // die generische Pending-Mutation-Outbox einreihen. Server-seitige
      // Rejections (RLS / Constraint / Validation, Code-Klassen 22/23/42)
      // werden NICHT gequeued — Replay würde deterministisch wieder
      // scheitern (Gate gespiegelt aus dem Legacy-Message-Enqueue).
      if (!isServerSideError(error)) {
        enqueuePendingMutation({
          operation: 'insert',
          table: 'chat_messages',
          payload: insertPayload as unknown as Record<string, unknown>,
          domain: 'chat',
          entityId: input.clientMessageId,
        })
      }
      // Failure: status='failed'
      this.markOptimisticFailed(input.threadId, tempId, error.message)
      throw error
    }

    const view = messageRowToViewModel(data as ChatMessageRow, [], 'sent', role)
    this.replaceOptimistic(input.threadId, tempId, view)
    this.clearSendOutbox(uid, input.clientMessageId)
    return view
  }

  /** Drop the queued outbox entry + planned id once a send reached the server
   *  (ACK or unique-conflict refetch) or was explicitly discarded. */
  private clearSendOutbox(uid: string, clientMessageId: string): void {
    this.plannedServerIdByClientKey.delete(optimisticKey(uid, clientMessageId))
    this.removeQueuedSend(clientMessageId)
  }

  private removeQueuedSend(clientMessageId: string): void {
    const queued = getPendingMutations().find(
      (m) => m.table === 'chat_messages' && m.entityId === clientMessageId,
    )
    if (queued) removePendingMutation(queued.id)
  }

  private replaceOptimistic(threadId: string, tempId: string, view: ChatMessageViewModel): void {
    const list = this.messagesByThread.get(threadId) ?? []
    // P0-1 fix: Match by tempId OR by clientMessageId+sender. The Realtime echo
    // may have already replaced the row with a server-id before the ACK arrives;
    // matching by tempId alone would silently push a duplicate. Also dedup if
    // a row with the same server-id is already present (Realtime arrived first).
    if (list.some((m) => m.id === view.id)) {
      // Already in cache via Realtime — drop tracking, plus any lingering
      // optimistic duplicate (a retry that raced the echo would otherwise
      // leave an eternal 'pending' temp row next to the server row).
      if (list.some((m) => m.id === tempId)) {
        this.commitThreadMessages(threadId, list.filter((m) => m.id !== tempId))
        this.notify()
      }
      this.optimisticByClientKey.delete(optimisticKey(view.senderUserId, view.clientMessageId))
      return
    }
    // Revoke any localBlobUrls from the outgoing optimistic row to free memory.
    const oldRow = list.find((m) => m.id === tempId)
    if (oldRow?.attachments) {
      for (const a of oldRow.attachments) {
        if (a.localBlobUrl) {
          try { URL.revokeObjectURL(a.localBlobUrl) } catch { /* best-effort */ }
        }
      }
    }
    let idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) {
      idx = list.findIndex(
        (m) =>
          m.clientMessageId === view.clientMessageId && m.senderUserId === view.senderUserId,
      )
    }
    if (idx < 0) {
      this.commitThreadMessages(threadId, [...list, view])
    } else {
      const updated = [...list]
      // Twofer (Block 3): preserve the optimistic createdAt on ACK-replace —
      // same timeline-stability rule as handleRealtimeInsert. The server
      // timestamp under client clock skew would make the bubble jump.
      updated[idx] = { ...view, createdAt: list[idx].createdAt }
      this.commitThreadMessages(threadId, updated)
    }
    this.optimisticByClientKey.delete(optimisticKey(view.senderUserId, view.clientMessageId))
    this.notify()
  }

  private markOptimisticFailed(threadId: string, tempId: string, errorMessage: string): void {
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'failed' }
    this.commitThreadMessages(threadId, updated)
    logError('chat.repository.send_failed', new Error(errorMessage), { threadId, tempId })
    this.notify()
  }

  async markThreadRead(threadId: string, lastMessageId: string): Promise<void> {
    if (!this.currentUid) return
    // Optimistic rows carry a synthetic `temp_<clientMessageId>` id — never a
    // valid uuid for last_read_message_id (observed as PATCH 400 / 22P02 on
    // device when the preceding send had failed). Skip; the read-mark lands
    // with the next real message id.
    if (lastMessageId.startsWith('temp_')) return
    const now = Date.now()
    const { error } = await supabase
      .from('chat_participants')
      .update({ last_read_message_id: lastMessageId, last_read_at: now })
      .eq('thread_id', threadId)
      .eq('user_id', this.currentUid)
    if (error) {
      logError('chat.repository.markThreadRead_failed', error, { threadId, lastMessageId })
      return
    }
    const t = this.threads.get(threadId)
    if (t) {
      const updatedParticipants = t.participants.map((p) =>
        p.userId === this.currentUid ? { ...p, lastReadMessageId: lastMessageId, lastReadAt: now } : p,
      )
      this.threads.set(threadId, { ...t, participants: updatedParticipants, unreadCount: 0 })
    }
    this.notify()
  }

  async updateThreadInquiryState(
    threadId: string,
    patch: { reviewedAt?: number; declinedAt?: number },
  ): Promise<void> {
    // Persist-first (markThreadRead pattern), but THROW on failure so the
    // workflow can decide — a silently-dropped decline would resurface the
    // request in the inbox after the next hydrate.
    const { error } = await supabase.rpc('rpc_update_chat_thread_inquiry_state', {
      p_thread_id: threadId,
      p_reviewed_at: patch.reviewedAt ?? null,
      p_declined_at: patch.declinedAt ?? null,
    })
    if (error) {
      logError('chat.repository.updateThreadInquiryState_failed', error, { threadId })
      throw error
    }
    const t = this.threads.get(threadId)
    if (t) {
      this.threads.set(threadId, {
        ...t,
        // Mirror the RPC's set-only-if-null semantics in the cache.
        reviewedAt: t.reviewedAt ?? patch.reviewedAt ?? null,
        declinedAt: t.declinedAt ?? patch.declinedAt ?? null,
        updatedAt: Date.now(),
      })
    }
    this.notify()
  }

  // ── Search (Foundation, Full-UI in Slice 5) ──────────────────────────────

  async searchMessages(query: ChatSearchQuery): Promise<ChatSearchResult[]> {
    let q = supabase
      .from('chat_messages')
      .select('id, thread_id, sender_user_id, body, created_at')
      .is('deleted_at', null)
      .eq('redacted', false)
      .textSearch('body_tsv', query.query, { config: 'german' })
      .order('created_at', { ascending: false })
    if (query.threadId) q = q.eq('thread_id', query.threadId)
    if (query.since) q = q.gte('created_at', query.since)
    if (query.until) q = q.lte('created_at', query.until)
    if (query.limit) q = q.limit(query.limit)

    const { data, error } = await q
    if (error) {
      logError('chat.repository.searchMessages_failed', error, { query })
      return []
    }

    const results: ChatSearchResult[] = []
    for (const row of (data ?? []) as Array<Pick<ChatMessageRow, 'id' | 'thread_id' | 'sender_user_id' | 'body' | 'created_at'>>) {
      // Per-user hides ("Für mich") are excluded from the searcher's own
      // results too, mirroring the timeline reads' excludeHidden.
      if (this.hiddenMessageIds.has(row.id)) continue
      const thread = this.threads.get(row.thread_id)
      if (query.channelType && thread?.channelType !== query.channelType) continue
      results.push({
        threadId: row.thread_id,
        messageId: row.id,
        channelType: thread?.channelType ?? 'customer',
        snippet: (row.body ?? '').slice(0, 200),
        senderUserId: row.sender_user_id,
        createdAt: row.created_at,
        routeTo: { type: 'message', id: row.id, focus: row.id },
      })
    }
    return results
  }

  // ── Migration ────────────────────────────────────────────────────────────

  async getMigrationStatus(
    legacyThreadId: string,
    legacySource: ChatLegacySource,
  ): Promise<ChatMigrationStatus> {
    const { data } = await supabase
      .from('chat_thread_migration_status')
      .select('status')
      .eq('legacy_thread_id', legacyThreadId)
      .eq('legacy_source', legacySource)
      .maybeSingle()
    return (data?.status as ChatMigrationStatus | undefined) ?? 'not_migrated'
  }

  async enqueueMigration(
    legacyThreadId: string,
    legacySource: ChatLegacySource,
    priority = 100,
  ): Promise<void> {
    // Phase 1b: rpc_enqueue_thread_migration is live (migration 20260514000001).
    // It performs auth + membership pre-check and fires Edge-Fn lazy-mode via
    // pg_net when no migration_status row exists yet.
    if (legacySource !== 'conversations' && legacySource !== 'message_threads') {
      logInfo('chat.repository.enqueueMigration_unsupported_source', { legacySource })
      return
    }
    const { error } = await supabase.rpc('rpc_enqueue_thread_migration', {
      p_legacy_thread_id: legacyThreadId,
      p_legacy_source: legacySource,
      p_priority: priority,
    })
    if (error) {
      logInfo('chat.repository.enqueueMigration_failed', {
        legacyThreadId,
        legacySource,
        reason: error.message,
      })
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

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

  // ── Notification-Prefs ──────────────────────────────────────────────────

  getUserNotificationPreference(): UserNotificationPreference | undefined {
    return this.notifPref
  }

  async updateUserNotificationPreference(
    patch: Partial<Omit<UserNotificationPreference, 'userId'>>,
  ): Promise<void> {
    if (!this.currentUid) throw new Error('chat.notif: no authenticated session')
    const uid = this.currentUid
    const dbPatch: Record<string, unknown> = {}
    if (patch.quietHoursStart !== undefined) dbPatch.quiet_hours_start = patch.quietHoursStart
    if (patch.quietHoursEnd !== undefined) dbPatch.quiet_hours_end = patch.quietHoursEnd
    if (patch.isAlwaysReachable !== undefined) dbPatch.is_always_reachable = patch.isAlwaysReachable
    if (patch.countCustomerChatUnread !== undefined)
      dbPatch.count_customer_chat_unread = patch.countCustomerChatUnread
    if (patch.countOfficeChatUnread !== undefined)
      dbPatch.count_office_chat_unread = patch.countOfficeChatUnread
    if (patch.countTeamChatUnread !== undefined)
      dbPatch.count_team_chat_unread = patch.countTeamChatUnread
    if (patch.countAssignmentChatUnread !== undefined)
      dbPatch.count_assignment_chat_unread = patch.countAssignmentChatUnread
    if (patch.countDisputeChatUnread !== undefined)
      dbPatch.count_dispute_chat_unread = patch.countDisputeChatUnread

    const { data, error } = await supabase
      .from('user_notification_preferences')
      .upsert({ user_id: uid, ...dbPatch }, { onConflict: 'user_id' })
      .select('*')
      .single()
    if (error) {
      logError('chat.repository.updateNotifPref_failed', error)
      throw error
    }
    this.notifPref = {
      userId: data.user_id,
      quietHoursStart: data.quiet_hours_start,
      quietHoursEnd: data.quiet_hours_end,
      isAlwaysReachable: data.is_always_reachable,
      countCustomerChatUnread: data.count_customer_chat_unread,
      countOfficeChatUnread: data.count_office_chat_unread,
      countTeamChatUnread: data.count_team_chat_unread,
      countAssignmentChatUnread: data.count_assignment_chat_unread,
      countDisputeChatUnread: data.count_dispute_chat_unread,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    }
    this.notify()
  }

  // ── Optimistic attachment helpers (Slice B) ───────────────────────────────

  insertOptimisticMessage(input: InsertOptimisticMessageInput): string {
    if (!this.currentUid) throw new Error('chat.insertOptimistic: no authenticated session')
    const uid = this.currentUid
    const tempId = `temp_${input.clientMessageId}`
    const clientKey = optimisticKey(uid, input.clientMessageId)
    const now = Date.now()
    const role =
      this.threads.get(input.threadId)?.participants.find((p) => p.userId === uid)?.role ??
      'craftsman'
    const optimistic: ChatMessageViewModel = {
      id: tempId,
      threadId: input.threadId,
      senderUserId: uid,
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
      sender: { userId: uid, role, displayName: null, avatarUrl: null },
    }
    const existing = this.messagesByThread.get(input.threadId) ?? []
    // Client-side idempotency mirror of the server UNIQUE(sender_user_id,
    // client_message_id): a re-send with the same clientMessageId (media
    // retry, drain replay racing a manual send) must never append a second
    // row — the echo/ACK reconcilers only ever replace the FIRST match, so a
    // duplicate would survive as an eternal unplayable ghost bubble.
    const priorIdx = existing.findIndex(
      (m) => m.clientMessageId === input.clientMessageId && m.senderUserId === uid,
    )
    if (priorIdx >= 0) {
      const prior = existing[priorIdx]
      if (!prior.id.startsWith('temp_')) {
        // The server row already landed (idempotent RPC re-send after a
        // success whose cleanup was lost) — nothing optimistic to insert.
        return prior.id
      }
      // Retry re-entry: replace in place. Keep createdAt/serverReceivedAt so
      // the bubble does not jump in the timeline across retries.
      const replaced: ChatMessageViewModel = {
        ...optimistic,
        createdAt: prior.createdAt,
        serverReceivedAt: prior.serverReceivedAt,
      }
      const nextUrls = new Set(
        (optimistic.attachments ?? []).map((a) => a.localBlobUrl).filter(Boolean),
      )
      for (const a of prior.attachments ?? []) {
        if (a.localBlobUrl && !nextUrls.has(a.localBlobUrl)) {
          try { URL.revokeObjectURL(a.localBlobUrl) } catch { /* best-effort */ }
        }
      }
      const updated = [...existing]
      updated[priorIdx] = replaced
      this.commitThreadMessages(input.threadId, updated)
      this.optimisticByClientKey.set(clientKey, tempId)
      this.notify()
      return tempId
    }
    this.commitThreadMessages(input.threadId, [...existing, optimistic])
    this.optimisticByClientKey.set(clientKey, tempId)
    this.notify()
    return tempId
  }

  failOptimisticMessage(threadId: string, tempId: string): void {
    this.markOptimisticFailed(threadId, tempId, 'upload failed after retries')
  }

  resetOptimisticToPending(threadId: string, clientMessageId: string): void {
    if (!this.currentUid) return
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'pending' }
    this.commitThreadMessages(threadId, updated)
    this.optimisticByClientKey.set(optimisticKey(this.currentUid, clientMessageId), tempId)
    this.notify()
  }

  markOptimisticSent(threadId: string, clientMessageId: string): void {
    const tempId = `temp_${clientMessageId}`
    const list = this.messagesByThread.get(threadId) ?? []
    const idx = list.findIndex((m) => m.id === tempId)
    if (idx < 0) return
    // Leave optimisticByClientKey registered so the later Realtime INSERT echo
    // still replaceOptimistic's this temp row with the canonical server row.
    const updated = [...list]
    updated[idx] = { ...updated[idx], status: 'sent' }
    this.commitThreadMessages(threadId, updated)
    this.notify()
  }

  updateOptimisticAttachment(
    threadId: string,
    clientMessageId: string,
    patch: Partial<Pick<ChatAttachment, 'storagePath' | 'storageBucket' | 'sizeBytes' | 'mimeType' | 'posterStoragePath' | 'width' | 'height'>>,
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
    this.commitThreadMessages(threadId, updated)
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
    this.commitThreadMessages(threadId, filtered)
    if (this.currentUid) {
      this.optimisticByClientKey.delete(optimisticKey(this.currentUid, clientMessageId))
      this.plannedServerIdByClientKey.delete(optimisticKey(this.currentUid, clientMessageId))
    }
    // Explizites Verwerfen muss auch den queued Background-Replay canceln —
    // sonst taucht der verworfene Text nach dem nächsten Flush als gesendete
    // Nachricht wieder auf.
    this.removeQueuedSend(clientMessageId)
    this.notify()
  }
}

function computeUnreadCount(myParticipant: ChatParticipant | undefined): number {
  // Post-M3-hotfix: rely on per-participant lastVisibleMessageAt, NOT
  // chat_threads.last_message_at — the latter would leak blocked-sender bumps
  // into the badge for blockers.
  if (!myParticipant) return 0
  const lastVisibleAt = myParticipant.lastVisibleMessageAt ?? null
  if (!lastVisibleAt) return 0
  const lastReadAt = myParticipant.lastReadAt ?? 0
  return lastVisibleAt > lastReadAt ? 1 : 0
}

/** Stable key for the optimistic-pending tracker. Sender + clientMessageId is
 *  unique per UNIQUE-constraint on chat_messages. */
function optimisticKey(senderUserId: string, clientMessageId: string): string {
  return `${senderUserId}:${clientMessageId}`
}

function mergeMessages(
  existing: ChatMessageViewModel[],
  incoming: ChatMessageViewModel[],
): ChatMessageViewModel[] {
  const byId = new Map<string, ChatMessageViewModel>()
  for (const m of existing) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** Collision winner for {@link enforceClientMessageUniqueness}: a server row
 *  beats an optimistic temp_ row; two temp rows resolve to the newer payload.
 *  The survivor keeps the earlier row's createdAt (timeline stability — same
 *  rule as handleRealtimeInsert/replaceOptimistic) and inherits the temp
 *  row's attachments when the server row carries none, so a media bubble
 *  never degrades to an empty text row while its attachment hydrates. */
function resolveDuplicateViews(
  first: ChatMessageViewModel,
  second: ChatMessageViewModel,
): ChatMessageViewModel {
  const firstIsTemp = first.id.startsWith('temp_')
  const secondIsTemp = second.id.startsWith('temp_')
  if (firstIsTemp === secondIsTemp) {
    // temp+temp (same tempId): newer payload, original position/createdAt.
    // server+server cannot happen (UNIQUE + id-dedup upstream); if it ever
    // does, keeping the first row is the deterministic no-op.
    return firstIsTemp ? { ...second, createdAt: first.createdAt } : first
  }
  const server = firstIsTemp ? second : first
  const temp = firstIsTemp ? first : second
  return {
    ...server,
    createdAt: temp.createdAt,
    attachments: server.attachments?.length ? server.attachments : temp.attachments,
  }
}

/** Cache mirror of the server UNIQUE(sender_user_id, client_message_id):
 *  at most ONE row per sender+clientMessageId in a thread list. Every write
 *  to messagesByThread funnels through this (commitThreadMessages), so no
 *  interleaving of optimistic insert / ACK / Realtime echo / gap-refetch /
 *  resync merge can materialize a duplicate bubble. Rows without a
 *  clientMessageId (legacy imports) are never deduped. Fast path returns the
 *  input array unchanged so ref-guarded consumers see no spurious mutation. */
function enforceClientMessageUniqueness(list: ChatMessageViewModel[]): ChatMessageViewModel[] {
  const seen = new Set<string>()
  let hasDuplicate = false
  for (const m of list) {
    if (!m.clientMessageId) continue
    const key = optimisticKey(m.senderUserId, m.clientMessageId)
    if (seen.has(key)) {
      hasDuplicate = true
      break
    }
    seen.add(key)
  }
  if (!hasDuplicate) return list

  const winnerByKey = new Map<string, ChatMessageViewModel>()
  const slots: Array<{ key: string | null; view: ChatMessageViewModel }> = []
  for (const m of list) {
    if (!m.clientMessageId) {
      slots.push({ key: null, view: m })
      continue
    }
    const key = optimisticKey(m.senderUserId, m.clientMessageId)
    const prior = winnerByKey.get(key)
    if (!prior) {
      winnerByKey.set(key, m)
      slots.push({ key, view: m })
      continue
    }
    winnerByKey.set(key, resolveDuplicateViews(prior, m))
  }
  return slots.map((s) => (s.key ? winnerByKey.get(s.key)! : s.view))
}

// ── CHAT-2 attachment hydration helpers ─────────────────────────────────────

/** PostgREST GET-URL limit: ~100 uuids per .in() request is safe with up to
 *  2000 preloaded messages. */
const ATTACHMENT_FETCH_CHUNK_SIZE = 100

/** message_types that can own chat_attachments rows. Read paths see the
 *  already-promoted type — fn_chat_set_message_type_on_attachment runs in the
 *  same tx as the RPC insert — so text-only threads pay no extra roundtrip. */
const MEDIA_MESSAGE_TYPES = new Set<ChatMessageViewModel['messageType']>([
  'image',
  'document',
  'voice',
  'video',
  'mixed',
])

function mediaMessageIds(rows: ChatMessageRow[]): string[] {
  return rows.filter((r) => MEDIA_MESSAGE_TYPES.has(r.message_type)).map((r) => r.id)
}
