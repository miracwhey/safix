/**
 * Block D Slice 1 Phase 1a — Unified Chat Domain types.
 *
 * Architektur-Regel: Chat besitzt KEINE Business-Logik.
 * Offers/ChangeOrders/Funding/CostEstimates/Disputes bleiben eigene Domains.
 * Chat referenziert per artifact_type+artifact_id und rendert nur.
 */

export type ChatChannelType = 'customer' | 'office' | 'team' | 'assignment' | 'dispute' | 'direct'

export type ChatMessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'voice'
  | 'video'
  | 'mixed'
  | 'artifact_card'
  | 'system'

/** Message-delete intent (Block 3). 'self' hides for the current user only;
 *  'all' is a sender-only 15-min unsend that redacts the row (tombstone). */
export type ChatDeleteMode = 'self' | 'all'

export type ChatRole = 'owner' | 'craftsman' | 'worker' | 'customer' | 'admin'

export type ChatMigrationStatus =
  | 'not_migrated'
  | 'migration_queued'
  | 'migrating'
  | 'migration_complete'
  | 'migration_verified'
  | 'migration_failed'

export type ChatLegacySource = 'conversations' | 'message_threads' | 'messages' | 'internal_messages' | 'thread_artifacts'

export type ChatMessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export type ChatAssetType = 'image' | 'document' | 'voice' | 'video'

export type ChatStorageBucket = 'chat-customer' | 'chat-internal' | 'chat-dispute'

/**
 * How a customer-channel thread was initiated (Chat-Cutover: mirrors the
 * legacy conversations.inquiry_origin domain). Identical value-set to the
 * messages-domain `InquiryOrigin` — kept as an own type so the chat domain
 * has no runtime or type dependency on the legacy messages module.
 */
export type ChatInquiryOrigin = 'reel' | 'profile' | 'category' | 'project'

/** Structured reel search criteria attached to reel-origin inquiries. */
export interface ChatInquiryCriteria {
  category?: string
  description?: string
  location?: string
  budget?: string
  timing?: string
}

export type TranscodeStatus = 'none' | 'pending' | 'processing' | 'ready' | 'failed'

/**
 * Display metadata denormalised onto the thread view-model so screens can
 * render thread-list rows without a second cross-domain lookup. Populated by
 * the repository when it synthesises legacy threads or hydrates native
 * threads. All fields optional — UI must apply safe-fallback labels.
 */
export interface ChatThreadDisplayMetadata {
  customerName?: string | null
  customerAvatarUrl?: string | null
  craftsmanName?: string | null
  craftsmanHandle?: string | null
  craftsmanAvatarUrl?: string | null
  projectTitle?: string | null
  projectSubtitle?: string | null
  projectDescription?: string | null
  projectLocation?: string | null
  projectCostRange?: string | null
  projectDuration?: string | null
  projectStatusLabel?: string | null
  /**
   * Synthetic project id stamped at inquiry-creation time (legacy parity:
   * conversations.project_id patterns like `project_profile_<id>_<thread>`).
   * convertInquiryToProjectWorkflow uses it for legacy job-idempotency
   * matching; it never references a real projects row.
   */
  syntheticProjectId?: string | null
  /**
   * For assignment-channel threads: the calendar entry the thread is bound
   * to. Lets worker-side projections key threads by calendar entry without a
   * legacy lookup.
   */
  calendarEntryId?: string | null
  /**
   * For direct-channel (person-to-person) threads: each participant keyed by
   * user id → their handle + display name. Populated by
   * rpc_get_or_create_chat_direct_thread. The thread-list row renders the peer
   * whose key ≠ the current user (see getChatThreadListRow).
   */
  peers?: Record<string, { handle?: string | null; displayName?: string | null }> | null
}

export interface ChatThread {
  id: string
  channelType: ChatChannelType
  customerUserId?: string | null
  craftsmanUserId?: string | null
  providerId?: string | null
  disputeId?: string | null
  legacyThreadId?: string | null
  legacySource?: ChatLegacySource | null
  title?: string | null
  lastMessageId?: string | null
  lastMessageAt?: number | null
  lastMessageBody?: string | null
  createdAt: number
  updatedAt: number
  closedAt?: number | null
  displayMetadata?: ChatThreadDisplayMetadata | null
  // ── Inquiry metadata (Chat-Cutover; only set on customer-channel threads
  //    that originated from an inquiry flow) ─────────────────────────────────
  inquiryOrigin?: ChatInquiryOrigin | null
  declinedAt?: number | null
  reviewedAt?: number | null
  sourceProjectId?: string | null
  inquiryCriteria?: ChatInquiryCriteria | null
}

export interface ChatMessage {
  id: string
  threadId: string
  senderUserId: string
  clientMessageId: string
  body?: string | null
  messageType: ChatMessageType
  artifactType?: string | null
  artifactId?: string | null
  replyToMessageId?: string | null
  createdAt: number
  serverReceivedAt: number
  deliveredAt?: number | null
  legacyMessageId?: string | null
  legacySource?: ChatLegacySource | null
  deletedAt?: number | null
  redacted: boolean
  redactedAt?: number | null
  redactedReason?: string | null
  attachments?: ChatAttachment[]
}

export interface ChatParticipant {
  threadId: string
  userId: string
  role: ChatRole
  joinedAt: number
  leftAt?: number | null
  lastReadMessageId?: string | null
  lastReadAt?: number | null
  mutedUntil?: number | null
  pinned: boolean
  notificationPreference?: Record<string, unknown> | null
  // Per-participant denormalized last visible message (post-M3-hotfix).
  // Filled by trigger fn_chat_update_thread_last_message — skips rows whose
  // sender is in user_blocks for this participant. Source of truth for inbox
  // preview, sort order, and unread count for THIS user.
  lastVisibleMessageId?: string | null
  lastVisibleMessageAt?: number | null
  lastVisibleMessageBody?: string | null
  lastVisibleMessageType?: string | null
}

export interface ChatAttachment {
  id: string
  messageId: string
  assetType: ChatAssetType
  mimeType: string
  sizeBytes: number
  storageBucket: ChatStorageBucket
  storagePath: string
  width?: number | null
  height?: number | null
  durationMs?: number | null
  posterStoragePath?: string | null
  transcript?: string | null
  transcriptLanguage?: string | null
  uploadedAt: number
  deletedAt?: number | null
  /**
   * Client-only: object URL created from the local File before upload.
   * Used to show image thumbnails immediately in pending state.
   * Revoked when the server row replaces the optimistic row.
   * Never persisted or sent to the server.
   */
  localBlobUrl?: string
  /** Original filename — used for document labels when storagePath is not yet set. */
  fileName?: string
  // ── V1 Media Architecture — transcode readiness ──────────────────────────
  // V1: transcodeStatus = 'none', all URLs null (raw storage used for playback).
  // V2: provider webhook → Edge Function sets h264Url + posterUrl +
  //     transcodeStatus = 'ready'; Realtime UPDATE delivers to clients.
  transcodeStatus: TranscodeStatus
  h264Url: string | null
  posterUrl: string | null
  transcodeProvider: string | null
  transcodeError: string | null
}

export interface ChatMessageViewModel extends ChatMessage {
  status: ChatMessageStatus
  sender: {
    userId: string
    role: ChatRole
    displayName?: string | null
    avatarUrl?: string | null
  }
}

export interface ChatThreadViewModel extends ChatThread {
  participants: ChatParticipant[]
  unreadCount: number
  migrationStatus: ChatMigrationStatus
}

export interface SendMessageInput {
  threadId: string
  body?: string
  messageType?: ChatMessageType
  clientMessageId: string
  attachments?: ChatAttachmentInput[]
  artifactType?: string
  artifactId?: string
  replyToMessageId?: string
}

export interface ChatAttachmentInput {
  assetType: ChatAssetType
  mimeType: string
  sizeBytes: number
  storageBucket: ChatStorageBucket
  storagePath: string
  width?: number
  height?: number
  durationMs?: number
  posterStoragePath?: string
}

export interface ChatSearchQuery {
  query: string
  threadId?: string
  channelType?: ChatChannelType
  since?: number
  until?: number
  limit?: number
}

export interface ChatSearchResult {
  threadId: string
  messageId: string
  channelType: ChatChannelType
  snippet: string
  senderUserId: string
  createdAt: number
  routeTo: { type: 'thread' | 'message'; id: string; focus?: string }
}

export interface ChatThreadMigrationStatusRow {
  threadId: string
  legacyThreadId: string
  legacySource: ChatLegacySource
  status: ChatMigrationStatus
  priority: number
  startedAt?: number | null
  completedAt?: number | null
  verifiedAt?: number | null
  failedAt?: number | null
  failureReason?: string | null
  failedStep?: string | null
  attempts: number
  createdAt: number
  updatedAt: number
}

/**
 * Notification-Preference per User (Quiet-Hours, per-channel-type-Toggles).
 * Schema gespiegelt von public.user_notification_preferences.
 */
export interface UserNotificationPreference {
  userId: string
  quietHoursStart?: number | null
  quietHoursEnd?: number | null
  isAlwaysReachable: boolean
  countCustomerChatUnread: boolean
  countOfficeChatUnread: boolean
  countTeamChatUnread: boolean
  countAssignmentChatUnread: boolean
  countDisputeChatUnread: boolean
  createdAt: number
  updatedAt: number
}
