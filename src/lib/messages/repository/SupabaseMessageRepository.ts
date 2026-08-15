import { supabase } from '../../supabase'
import { getAuthSession, isAuthLockStolenError } from '../../auth/authSingleFlight'
import { recordPersistenceFailure, enqueuePendingMutation, getPendingMutations, isServerSideError } from '../../persistence'
import { logBreadcrumb, logError, logInfo, logWarning } from '../../observability'
import { formatMessageTimeLabel } from '../dateUtils'
import { isValidProjectId } from '../../projects/projectId'
import type {
  Conversation,
  InquiryOrigin,
  Message,
  MessageSender,
} from '../types'
import type { MessageRepository } from './MessageRepository'

type Listener = () => void

/** Backoff before the single loadForUser retry after a navigator.locks
 *  steal ('Lock was stolen by another request'): give the lock thief —
 *  usually an internal auth-js token operation — a moment to finish before
 *  contending again. */
const AUTH_LOCK_RETRY_DELAY_MS = 300

/** Clock-skew guard for the fallbackRefresh since-cursor. Own optimistic
 *  sends carry the CLIENT clock as created_at/sentAt, so the newest-cached
 *  timestamp can sit ahead of the server clock. Subtracting this margin
 *  before the `.gt('created_at', …)` filter prevents the gap-refetch from
 *  silently skipping counterparty messages whose server created_at falls
 *  inside the skew window of the last own send. The id-dedup downstream
 *  absorbs the small re-fetch overlap the margin introduces. */
const MESSAGE_CURSOR_SKEW_GUARD_MS = 5 * 60_000

/**
 * Shape of a `conversations` row as stored in the Supabase database.
 * Optional fields are stored as nullable columns.
 * Unix timestamps (ms) are stored as numeric (bigint-compatible) columns.
 */
interface ConversationRow {
  id: string
  customer_name: string
  customer_avatar_url: string
  craftsman_name: string
  craftsman_handle: string
  craftsman_avatar_url: string
  craftsman_user_id: string | null
  // Canonical direct customer owner link. Stamped at conversation-creation
  // time from the initiating customer's session UID.
  customer_user_id: string | null
  project_title: string
  project_subtitle: string
  project_location: string | null
  project_cost_range: string | null
  project_duration: string | null
  project_status_label: string | null
  time_label: string | null
  unread_count: number | null
  inquiry_origin: string | null
  source_project_id: string | null
  reviewed_at: number | null
  declined_at: number | null
  // Canonical sort key for repository-level ordering (newest thread first).
  // Added by migration 20241200000000_conversations_messages_timestamps.sql.
  created_at: number
  // Inquiry-context fields added by migration 20260317000011.
  // Optional in the interface so they can be omitted from INSERT/UPDATE
  // payloads when null — avoids PostgREST "unknown column" errors on
  // instances where the migration has not yet been applied.
  project_description?: string | null
  inquiry_criteria?: Record<string, unknown> | null
}

/**
 * Shape of a `messages` row as stored in the live Supabase database.
 *
 * Live schema columns: id, conversation_id, sender_user_id, content,
 * created_at, media_url.  All other fields (sender label, created_at_label,
 * attachment_type, project_attachment) are kept in-memory only.
 */
interface MessageRow {
  id: string
  conversation_id: string
  /** Supabase user_id of the message author. */
  sender_user_id: string | null
  /** Body text of the message. */
  content: string
  /** Sort key: epoch ms stamped when message is sent. */
  created_at: number
  /** Optional media attachment URL. */
  media_url: string | null
}

function rowToConversation(row: ConversationRow): Conversation {
  // Restore sourceProjectId for any conversation that has a *real* (UUID)
  // project ID persisted, regardless of inquiry_origin.
  // sendProjectAttachmentToThread stamps source_project_id on ANY thread
  // when a customer attaches a real builder project, so limiting rehydration
  // to 'project'-origin conversations caused project cards to vanish after
  // reload on profile-/category-/reel-origin threads.
  // Synthetic IDs (e.g. project_profile_*) are NOT valid UUIDs and must not
  // be surfaced as sourceProjectId — they are placeholders, not real entities.
  const sourceProjectId =
    row.source_project_id && isValidProjectId(row.source_project_id)
      ? row.source_project_id
      : undefined

  return {
    id: row.id,
    // source_project_id is the canonical persisted project reference.
    // Persist it on both projectId (legacy field) and sourceProjectId so
    // selectors that rely on either property can resolve the linkage even
    // after a reload.
    projectId: row.source_project_id ?? '',
    ...(sourceProjectId != null && { sourceProjectId }),
    customerName: row.customer_name,
    customerAvatarUrl: row.customer_avatar_url,
    craftsmanName: row.craftsman_name,
    craftsmanHandle: row.craftsman_handle,
    craftsmanAvatarUrl: row.craftsman_avatar_url,
    ...(row.craftsman_user_id != null && { craftsmanUserId: row.craftsman_user_id }),
    ...(row.customer_user_id != null && { customerUserId: row.customer_user_id }),
    projectTitle: row.project_title,
    projectSubtitle: row.project_subtitle,
    ...(row.project_location != null && { projectLocation: row.project_location }),
    ...(row.project_cost_range != null && { projectCostRange: row.project_cost_range }),
    ...(row.project_duration != null && { projectDuration: row.project_duration }),
    ...(row.project_status_label != null && { projectStatusLabel: row.project_status_label }),
    ...(row.time_label != null && { timeLabel: row.time_label }),
    ...(row.unread_count != null && { unreadCount: row.unread_count }),
    ...(row.inquiry_origin != null && { inquiryOrigin: row.inquiry_origin as InquiryOrigin }),
    ...(row.reviewed_at != null && { reviewedAt: row.reviewed_at }),
    ...(row.declined_at != null && { declinedAt: row.declined_at }),
    ...(row.created_at !== 0 && { createdAt: row.created_at }),
    ...(row.project_description != null && { projectDescription: row.project_description }),
    ...(row.inquiry_criteria != null && {
      inquiryCriteria: row.inquiry_criteria as Conversation['inquiryCriteria'],
    }),
  }
}

/**
 * Extracts all columns that exist in the live `conversations` table for
 * Supabase INSERT / UPDATE payloads.
 *
 * IMPORTANT: All display metadata (customer_name, craftsman_name, project_title,
 * etc.) MUST be persisted so that thread identity/context survives reload.
 * Previously only user IDs were written, causing "undefined" display on reload.
 */
function conversationToDbPayload(conversation: Conversation) {
  return {
    id: conversation.id,

    // Customer display info
    customer_name: conversation.customerName,
    customer_avatar_url: conversation.customerAvatarUrl,
    customer_user_id: conversation.customerUserId ?? null,

    // Craftsman display info
    craftsman_name: conversation.craftsmanName,
    craftsman_handle: conversation.craftsmanHandle,
    craftsman_avatar_url: conversation.craftsmanAvatarUrl,
    craftsman_user_id: conversation.craftsmanUserId ?? null,

    // Project context
    project_title: conversation.projectTitle,
    project_subtitle: conversation.projectSubtitle,
    project_location: conversation.projectLocation ?? null,
    project_cost_range: conversation.projectCostRange ?? null,
    project_duration: conversation.projectDuration ?? null,
    project_status_label: conversation.projectStatusLabel ?? null,

    // UI state
    time_label: conversation.timeLabel ?? null,
    unread_count: conversation.unreadCount ?? null,

  // Inquiry metadata
  inquiry_origin: conversation.inquiryOrigin ?? null,
  // source_project_id is the single canonical persisted project reference.
  // Only write valid project UUIDs — synthetic placeholder IDs (e.g.
  // "project_reel_conv123") must NOT pollute this canonical column.
  // On read, rowToConversation already filters via isValidProjectId, but
  // preventing the write avoids split-brain between the DB canonical
  // column and the in-memory canonical sourceProjectId field.
  source_project_id:
    conversation.sourceProjectId ??
    (conversation.projectId && isValidProjectId(conversation.projectId)
      ? conversation.projectId
      : null),

    // Lifecycle timestamps
    reviewed_at: conversation.reviewedAt ?? null,
    declined_at: conversation.declinedAt ?? null,

    // Sort key
    created_at: conversation.createdAt ?? 0,

    // Inquiry context (optional fields from newer migration)
    ...(conversation.projectDescription != null && { project_description: conversation.projectDescription }),
    ...(conversation.inquiryCriteria != null && { inquiry_criteria: conversation.inquiryCriteria }),
  }
}

function rowToMessage(row: MessageRow, currentUid?: string): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    // Derive the view-relative sender label from the stored user ID.
    // If the author matches the current session user they are 'user';
    // any other author (or an unknown one) is 'counterparty'.
    sender: (currentUid && row.sender_user_id === currentUid ? 'user' : 'counterparty') as MessageSender,
    text: row.content,
    // Recompute the display label from the stored epoch timestamp so it
    // stays accurate after a reload (no created_at_label column in live DB).
    createdAtLabel: row.created_at ? formatMessageTimeLabel(row.created_at) : '',
    ...(row.created_at !== 0 && { sentAt: row.created_at }),
  }
}

/**
 * Extracts only the columns that exist in the live `messages` table for
 * Supabase INSERT payloads.
 *
 * Live schema columns: id, conversation_id, sender_user_id, content,
 * created_at, media_url.
 */
function messageToDbPayload(message: Message, senderUserId: string) {
  return {
    id: message.id,
    conversation_id: message.conversationId,
    sender_user_id: senderUserId,
    content: message.text,
    created_at: message.sentAt ?? 0,
    media_url: null,
  }
}

/**
 * Supabase-backed implementation of the MessageRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `conversations` and `messages` tables.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setMessageRepository()`.
 * 3. Await `initializeMessageRepository()` (or `repo.initialize()` directly)
 *    to load the initial dataset from Supabase before the UI first renders.
 *
 * Write path:
 * - `addMessageAndUpdateConversation` updates the local cache immediately
 *   (optimistic) and then awaits the Supabase INSERT.  If the INSERT fails
 *   the error is thrown so the calling workflow can surface it in the UI.
 * - `addConversation` awaits the Supabase INSERT before resolving so that
 *   the immediately-following opening-message INSERT never races the
 *   conversations RLS check (messages_insert_own requires the parent
 *   conversation row to exist).
 * - `updateConversation` remains fire-and-forget because it is a
 *   non-critical metadata sync (status labels, timestamps) where a brief
 *   inconsistency is acceptable and no RLS dependency chain exists.
 * Realtime path:
 * - After initial load, a Supabase Realtime channel subscribes to INSERT
 *   events on the `messages` table.  Incoming rows are deduplicated by ID
 *   (preventing double-display of messages the local user just sent) and
 *   appended to the cache, which triggers a notify() → UI re-render.
 */
export class SupabaseMessageRepository implements MessageRepository {
  private conversations: Conversation[] = []
  private messages: Message[] = []
  private readonly listeners = new Set<Listener>()
  /** Active Supabase Realtime channel, or null when not subscribed. */
  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  /** Current user ID, needed for subscription management. */
  private currentUid: string | null = null
  /** Unsubscribe handler for auth state changes. */
  private authUnsubscribe: (() => void) | null = null
  /** Track whether realtime is connected. */
  private isRealtimeConnected = false
  /** Track reconnection attempts to prevent infinite retry spam. */
  private reconnectAttempts = 0
  /** Maximum reconnection attempts before giving up. */
  private readonly MAX_RECONNECT_ATTEMPTS = 5
  /** Delay between reconnection attempts (ms). */
  private readonly RECONNECT_DELAY = 3000
  /** Generation counter — incremented on every new channel to invalidate stale subscribe callbacks. */
  private realtimeGeneration = 0
  private _hydrated = false
  private _lastError: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      this._lastError = null
      try {
        // Single-flight + lock-stolen retry (Sentry P0 FIXUP-WEB-B/9): boot /
        // resume fires many repository inits in parallel — a raw getSession()
        // per repo makes each one a navigator.locks contender.
        const {
          data: { session },
        } = await getAuthSession()
        if (generation !== this._loadGeneration) return
        if (!session?.user) {
          this.resetState()
          this._hydrated = true
          this.notify()
          this.ensureAuthListener()
          return
        }
        await this.loadForUser(session.user.id, generation)
        this._hydrated = true
        this.notify()
        this.ensureAuthListener()
      } catch (error) {
        logError('repository.messages.initialize_failed', error as Error, {})
        this._lastError = 'Nachrichten konnten nicht geladen werden.'
        // Stale-while-revalidate: a transient initialize failure (e.g. network
        // drop during resume-resync) must NOT wipe an already-hydrated cache —
        // subscribers would otherwise see an empty inbox until the next
        // successful reload. First load without cache behaves identically
        // (arrays are still empty). Sign-out still clears via the SIGNED_OUT
        // branch in ensureAuthListener() → resetState().
        this._hydrated = true
        this.notify()
        this.ensureAuthListener()
      }
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

  reset(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  getLastError(): string | null {
    return this._lastError
  }

  private async loadForUser(uid: string, generationSnapshot: number, isLockRetry = false): Promise<void> {
    this._lastError = null
    // Remember whose data the current cache belongs to BEFORE re-pointing
    // currentUid — on a transient fetch error we keep the cache only when it
    // belongs to the same user (stale-while-revalidate). A uid change with a
    // failing fetch must still clear so no cross-account data survives.
    const previousUid = this.currentUid
    this.currentUid = uid
    const [conversationsResult, messagesResult] = await Promise.all([
      // Fetch conversations where the logged-in user is either the craftsman OR the
      // customer.  The explicit OR filter mirrors the conversations_select_own RLS
      // policy (migration 20241000000000) and ensures customers see their own threads
      // after a reload — not only craftsmen.
      supabase
        .from('conversations')
        .select('*')
        .or(`craftsman_user_id.eq.${uid},customer_user_id.eq.${uid}`)
        .order('created_at', { ascending: false })
        .limit(200),
      // Messages are scoped via the messages_select_own RLS policy
      // (conversation_id IN conversations owned by either party).  No additional
      // client-side filter is needed here.
      // NEWEST 2000, reversed client-side to chronological order below —
      // ascending+limit loaded the OLDEST 2000, so past >2000 total rows new
      // messages were never loaded again (Block 3 P2).
      supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(2000),
    ])
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    // Auth-lock steal (Sentry P0 FIXUP-WEB-B/9): postgrest-js wraps the
    // navigator.locks AbortError ('Lock was stolen by another request') from
    // its internal token read into result.error — the inbox data itself is
    // fine. Retry the whole load EXACTLY once after a short backoff instead
    // of hard-failing into the stale-cache path. A second lock-stolen
    // failure falls through to the normal error handling below
    // (stale-while-revalidate semantics unchanged).
    if (
      !isLockRetry &&
      (isAuthLockStolenError(conversationsResult.error) || isAuthLockStolenError(messagesResult.error))
    ) {
      logInfo('repository.messages.auth_lock_retry', { userId: uid })
      await new Promise((resolve) => setTimeout(resolve, AUTH_LOCK_RETRY_DELAY_MS))
      // Re-check after the backoff: a resync/sign-out/account-switch that
      // arrived during the wait owns the load now.
      if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
      return this.loadForUser(uid, generationSnapshot, true)
    }
    if (conversationsResult.error) {
      logError('repository.messages.initialize_conversations_failed', conversationsResult.error, { userId: uid })
      // Preserve error state — callers must check getLastError(), not assume empty = OK.
      this._lastError = 'Nachrichten konnten nicht geladen werden.'
      // Stale-while-revalidate: keep the previously loaded cache for the SAME
      // user instead of wiping it to [] on a transient fetch error — a resume
      // resync over a flaky connection must not blank the inbox. Only clear
      // when the cache belongs to a different user (account switch).
      if (previousUid !== uid) this.conversations = []
    } else {
      this.conversations = ((conversationsResult.data ?? []) as ConversationRow[]).map(rowToConversation)
    }
    if (messagesResult.error) {
      logError('repository.messages.initialize_messages_failed', messagesResult.error, { userId: uid })
      this._lastError = 'Nachrichten konnten nicht geladen werden.'
      if (previousUid !== uid) this.messages = []
    } else {
      // .reverse(): rows arrive newest-first (descending fetch above), the
      // cache is kept in chronological (ascending) order.
      this.messages = ((messagesResult.data ?? []) as MessageRow[])
        .map((row) => rowToMessage(row, uid))
        .reverse()
    }
    this.hydrateFromQueue(uid)
    this.notify()
    // Start realtime subscription so new messages from other participants
    // (or from other devices/tabs for the current user) appear without a reload.
    this.startRealtimeSubscription(uid)
  }

  private resetState(): void {
    this._initPromise = null
    this.realtimeGeneration++
    this.conversations = []
    this.messages = []
    this.currentUid = null
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && uid && (uid !== this.currentUid || !this._hydrated)) {
        void this.loadForUser(uid, this._loadGeneration)
      }
      if (event === 'SIGNED_OUT') {
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe ? subscription.unsubscribe.bind(subscription) : null
  }

  /**
   * Subscribes to INSERT events on the `messages` table via Supabase Realtime.
   *
   * Deduplication: if the arriving message ID already exists in the local cache
   * (inserted optimistically by this client moments earlier) we silently drop it,
   * preventing double-display.
   *
   * Conversation guard: we only append a message if its conversation_id is
   * already in the local conversations cache — this ensures we never receive
   * messages from unrelated threads that happened to pass RLS on the realtime
   * channel.
   *
   * Unread count: when a message arrives via realtime (not sent by this client),
   * increment the conversation's unread count so the recipient sees the badge.
   *
   * Status handling: tracks connection status and attempts reconnection on failure.
   */
  private startRealtimeSubscription(uid: string, fromReconnection = false): void {
    // Remove any previously active channel before creating a new one.
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    const generation = ++this.realtimeGeneration
    this.realtimeChannel = supabase
      .channel(`fixup-messages-${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          if (generation !== this.realtimeGeneration) return
          const row = payload.new as MessageRow
          // Deduplicate: skip if this message was already added optimistically.
          if (this.messages.some((m) => m.id === row.id)) return
          // Guard: only accept messages for conversations we know about.
          const conversation = this.conversations.find((c) => c.id === row.conversation_id)
          if (!conversation) return
          const message = rowToMessage(row, uid)
          this.messages = [...this.messages, message]
          // Refresh the conversation's time label and increment unread count.
          // The unread count increment is only applied when the message arrives
          // via realtime (not optimistically added by this client), so it correctly
          // reflects "I received a message I haven't read yet".
          this.conversations = this.conversations.map((c) =>
            c.id === message.conversationId
              ? {
                  ...c,
                  timeLabel: message.createdAtLabel,
                  unreadCount: (c.unreadCount ?? 0) + 1,
                }
              : c
          )
          this.notify()
          logInfo('message.realtime_received', {
            messageId: message.id,
            conversationId: message.conversationId,
          })
        },
      )
      .subscribe((status) => {
        if (generation !== this.realtimeGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isRealtimeConnected = true
          this.reconnectAttempts = 0
          logInfo('message.realtime_connected', { userId: uid })
          if (fromReconnection) void this.fallbackRefresh(uid)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isRealtimeConnected = false
          logBreadcrumb('repository.messages.realtime_disconnected', 'warning', {
            userId: uid,
            status,
          })
          // Trigger fallback refresh to ensure messages are up-to-date
          void this.fallbackRefresh(uid)
          // Attempt reconnection with exponential backoff
          this.attemptReconnection(uid)
        }
      })
  }

  /**
   * Fallback refresh mechanism: manually fetch latest messages when realtime fails.
   * This ensures threads eventually reflect correct state even without realtime.
   */
  private async fallbackRefresh(uid: string): Promise<void> {
    try {
      logInfo('message.fallback_refresh_started', { userId: uid })
      // Since-cursor (Block 3 P2): only fetch rows newer than the newest
      // cached message. The previous full-table ascending+limit(2000) fetch
      // returned the OLDEST 2000 rows — past 2000 total rows the gap was
      // never closed. Descending+reverse keeps the empty-cache case correct
      // (newest 2000 instead of oldest 2000).
      const since = this.maxCachedMessageSentAt()
      let query = supabase.from('messages').select('*')
      // Skew-guarded cursor: see MESSAGE_CURSOR_SKEW_GUARD_MS. Without the
      // margin a client clock ahead of the server drops counterparty messages
      // inside the skew window of the last own send — silent message loss.
      if (since > 0) query = query.gt('created_at', since - MESSAGE_CURSOR_SKEW_GUARD_MS)
      const messagesResult = await query
        .order('created_at', { ascending: false })
        .limit(2000)

      if (messagesResult.error) {
        logError('repository.messages.fallback_refresh_failed', messagesResult.error, { userId: uid })
        return
      }

      // Update messages, deduplicating by ID. .reverse(): rows arrive
      // newest-first, the cache is chronological.
      const newMessages = ((messagesResult.data ?? []) as MessageRow[])
        .map((row) => rowToMessage(row, uid))
        .reverse()
      const existingIds = new Set(this.messages.map((m) => m.id))
      const freshMessages = newMessages.filter((m) => !existingIds.has(m.id))

      if (freshMessages.length > 0) {
        this.messages = [...this.messages, ...freshMessages]
        // Update conversation time labels for any new messages
        freshMessages.forEach((message) => {
          // Badge-inflation fix (Block 3 P2): own sends echoed back by the
          // refetch must not bump unread — only counterparty messages are
          // "received and not yet read" (mirrors the realtime path semantics).
          const isOwn = message.sender === 'user'
          this.conversations = this.conversations.map((c) =>
            c.id === message.conversationId
              ? {
                  ...c,
                  timeLabel: message.createdAtLabel,
                  unreadCount: isOwn ? (c.unreadCount ?? 0) : (c.unreadCount ?? 0) + 1,
                }
              : c
          )
        })
        this.notify()
        logInfo('message.fallback_refresh_completed', {
          userId: uid,
          newMessagesCount: freshMessages.length,
        })
      }
    } catch (error) {
      logError('repository.messages.fallback_refresh_error', error as Error, { userId: uid })
    }
  }

  /** Newest cached message timestamp — the since-cursor for fallbackRefresh.
   *  sentAt mirrors the DB created_at column (rowToMessage). */
  private maxCachedMessageSentAt(): number {
    let max = 0
    for (const m of this.messages) {
      const at = m.sentAt ?? 0
      if (at > max) max = at
    }
    return max
  }

  /**
   * Attempt to reconnect the realtime subscription with retry logic.
   */
  private attemptReconnection(uid: string): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logWarning(
        'repository.messages.realtime_reconnect_exhausted',
        { userId: uid, attempts: this.reconnectAttempts }
      )
      return
    }

    this.reconnectAttempts++
    logInfo('message.realtime_reconnect_attempt', {
      userId: uid,
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
    })

    setTimeout(() => {
      if (!this.isRealtimeConnected && this.currentUid === uid) {
        this.startRealtimeSubscription(uid, true)
      }
    }, this.RECONNECT_DELAY * this.reconnectAttempts)
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'messages' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.messages.some((msg) => msg.id === m.entityId)) continue
      const payload = m.payload as unknown as MessageRow
      if (!payload?.id || !payload.conversation_id) continue
      if (!this.conversations.some((c) => c.id === payload.conversation_id)) continue
      try {
        const msg = rowToMessage(payload, uid)
        this.messages = [...this.messages, msg]
      } catch { /* malformed payload */ }
    }
  }

  getConversations(): Conversation[] {
    return this.conversations
  }

  getConversationById(id: string): Conversation | undefined {
    return this.conversations.find((c) => c.id === id)
  }

  getConversationByProjectId(id: string): Conversation | undefined {
    return this.conversations.find(
      (c) => c.projectId === id || c.sourceProjectId === id
    )
  }

  getMessages(): Message[] {
    return this.messages
  }

  getMessagesByConversationId(id: string): Message[] {
    return this.messages.filter((m) => m.conversationId === id)
  }

  async addConversation(conversation: Conversation): Promise<void> {
    const stamped: Conversation = { ...conversation, createdAt: conversation.createdAt ?? Date.now() }
    // Optimistic add — shows the thread immediately in the UI.
    this.conversations = [...this.conversations, stamped]
    this.notify()
    const { error } = await supabase
      .from('conversations')
      .insert(conversationToDbPayload(stamped))
    if (error) {
      // Roll back the optimistic add so a ghost thread is not left in the UI.
      this.conversations = this.conversations.filter((c) => c.id !== stamped.id)
      this.notify()
      logError('repository.messages.add_conversation_failed', error, { entityId: conversation.id })
      recordPersistenceFailure({ domain: 'messages', operation: 'add', entityId: conversation.id, error, occurredAt: Date.now() })
      throw error
    }
  }

  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): void {
    this.conversations = this.conversations.map((c) =>
      c.id === id ? { ...c, ...patch } : c
    )
    this.notify()
    const updated = this.conversations.find((c) => c.id === id)
    if (updated) {
      supabase
        .from('conversations')
        .update(conversationToDbPayload(updated))
        .eq('id', id)
        .then(({ error }) => {
          if (error) {
            logError('repository.messages.update_conversation_failed', error, { entityId: id })
            // Non-critical metadata sync: permanent server-side errors (42xxx, 23xxx, RLS)
            // must not escalate the SyncStatusBar — logError + Sentry is sufficient.
            if (!isServerSideError(error)) {
              recordPersistenceFailure({ domain: 'messages', operation: 'update', entityId: id, error, occurredAt: Date.now() })
            }
          }
        })
    }
  }

  async addMessageAndUpdateConversation(
    message: Message,
    conversationId: string,
    conversationPatch: Partial<Omit<Conversation, 'id'>>
  ): Promise<void> {
    // Client-side guard: conversation must be in the local cache (loaded for
    // this user) to prevent sending messages to threads the user is not part
    // of.  The server-side RLS policy (messages_insert_own) enforces the same
    // constraint even if this check were somehow bypassed by a crafted request.
    if (!this.conversations.some((c) => c.id === conversationId)) {
      throw new Error(`Unauthorized: conversation ${conversationId} not accessible`)
    }
    const stamped: Message = { ...message, sentAt: message.sentAt ?? Date.now() }
    // Optimistic update — happens synchronously so the UI renders immediately.
    this.messages = [...this.messages, stamped]
    this.conversations = this.conversations.map((c) =>
      c.id === conversationId ? { ...c, ...conversationPatch } : c
    )
    this.notify()
    // Await the Supabase INSERT so failures can be surfaced to the caller.
    // Resolve the current user's ID to populate sender_user_id in the live DB row.
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const senderUserId = session?.user?.id ?? ''
    const { error: msgError } = await supabase
      .from('messages')
      .insert(messageToDbPayload(stamped, senderUserId))
    if (msgError) {
      this.messages = this.messages.filter((m) => m.id !== stamped.id)
      this.notify()
      logError('repository.messages.add_message_failed', msgError, { entityId: message.id, conversationId })
      recordPersistenceFailure({ domain: 'messages', operation: 'add', entityId: message.id, error: msgError, occurredAt: Date.now() })
      if (!isServerSideError(msgError)) {
        enqueuePendingMutation({
          operation: 'insert',
          table: 'messages',
          payload: messageToDbPayload(stamped, senderUserId) as unknown as Record<string, unknown>,
          domain: 'messages',
          entityId: message.id,
        })
      }
      throw msgError
    }
    // Update the conversation row in the background (not awaited — this is a
    // non-critical metadata sync and should not block or fail the send).
    const updatedConversation = this.conversations.find((c) => c.id === conversationId)
    if (updatedConversation) {
      supabase
        .from('conversations')
        .update(conversationToDbPayload(updatedConversation))
        .eq('id', conversationId)
        .then(({ error }) => {
          if (error) {
            logError('repository.messages.update_conversation_after_message_failed', error, { entityId: conversationId })
            // Non-critical post-send metadata sync: permanent server-side errors must not
            // escalate the SyncStatusBar — the message itself was already persisted.
            if (!isServerSideError(error)) {
              recordPersistenceFailure({ domain: 'messages', operation: 'update', entityId: conversationId, error, occurredAt: Date.now() })
            }
          }
        })
    }
  }

  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.currentUid) return
    // Pessimistic restart (force, Block 3): isRealtimeConnected is a lagging
    // flag — after a long background the socket can be dead while the flag
    // still reads true. force skips the check and does a clean teardown +
    // re-subscribe; the SUBSCRIBED callback (fromReconnection) then runs the
    // gap-refetch so messages missed while dead are recovered.
    if (!options?.force && this.isRealtimeConnected) return
    this.reconnectAttempts = 0
    this.startRealtimeSubscription(this.currentUid, true)
  }
}
