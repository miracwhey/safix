/**
 * Block D Slice 1 Phase 1a — Public API der Unified-Chat-Domain.
 *
 * UI/Workflow konsumiert NUR aus diesem Barrel.
 * Business-Logik (Offers/Disputes/Funding) bleibt in eigenen Domains.
 */

export type {
  ChatChannelType,
  ChatMessageType,
  ChatDeleteMode,
  ChatRole,
  ChatMigrationStatus,
  ChatLegacySource,
  ChatMessageStatus,
  ChatAssetType,
  ChatStorageBucket,
  ChatThread,
  ChatThreadDisplayMetadata,
  ChatInquiryOrigin,
  ChatInquiryCriteria,
  ChatMessage,
  ChatParticipant,
  ChatAttachment,
  ChatMessageViewModel,
  ChatThreadViewModel,
  SendMessageInput,
  ChatAttachmentInput,
  ChatSearchQuery,
  ChatSearchResult,
  ChatThreadMigrationStatusRow,
  UserNotificationPreference,
} from './types'

export type { ChatRepository, ChatConnectionState } from './repository'
export {
  getChatRepository,
  setChatRepository,
  initializeChatRepository,
  resetChatRepository,
  restartChatRealtimeIfDead,
  InMemoryChatRepository,
  SupabaseChatRepository,
} from './repository'

export {
  sendTextMessage,
  sendArtifactReferenceMessage,
  markRead,
  enqueueLazyMigration,
  reconcileMessagesSince,
  getOrCreateChatOfficeThread,
  getOrCreateChatTeamThread,
  getOrCreateChatAssignmentThread,
  getOrCreateChatCustomerThread,
  getOrCreateChatDirectThread,
} from './service'

export {
  useChatThreads,
  useChatThread,
  useChatMessages,
  useChatHydrated,
  useChatConnectionState,
  useChatNotificationPreference,
  useChatBadgeCount,
  computeBadgeUnreadCount,
} from './chatStore'
export type { ChatBadgeRole } from './chatStore'

export {
  getThreadsForRole,
  getThreadsByChannel,
  getActiveThreadById,
  getChatConnectionState,
  getThreadByLegacyConversationId,
  getThreadMessages,
  getUnreadCountByChannel,
  getBadgeUnreadCount,
  getLastMessageBodyPreview,
  getChatThreadListRow,
  sortChatThreadsByUnread,
} from './selectors'
export type { ChatThreadListRow } from './selectors'

export {
  uploadChatAttachment,
  bucketForChannel,
  assetTypeForMime,
} from './repository/chatAttachmentUploader'
export type {
  ChatAttachmentUploadInput,
  ChatAttachmentUploadResult,
} from './repository/chatAttachmentUploader'

export {
  isChatCutoverEnabled,
  setChatCutoverOverride,
  applyChatCutoverUrlOverride,
} from './featureFlags'
export type { ChatUiPersona } from './featureFlags'
