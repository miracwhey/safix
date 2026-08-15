export type {
  Conversation,
  Message,
  MessageItem,
  MessageRole,
  MessageSender,
  MessageThread,
  MessageAttachmentType,
  MessageProjectAttachment,
  ProjectContext,
  ThreadHeader,
  ThreadListRow,
} from './types'

export {
  getConversationById,
  getConversationByProjectId,
  getConversations,
  getMessages,
  getMessagesByConversationId,
  sendMessageToThread,
  sendProjectAttachmentToThread,
  setActiveThreadProject,
  getProjectHauptprojektStatus,
  subscribeMessages,
  addConversation,
  updateConversation,
  isMessageRepositoryHydrated,
  getMessageRepositoryError,
} from './store'

export {
  getMessageThreadById,
  getMessageThreads,
  getThreadHeader,
  getThreadListRow,
  getThreadConversionState,
  getOutboundProjectRequests,
  searchMessageThreads,
  sortMessageThreadsByUnread,
  deriveThreadActivityStatus,
  resolveCanonicalThreadId,
} from './selectors'

export type {
  ThreadConversionState,
  ThreadActivityStatus,
  OutboundRequestStatus,
  OutboundProjectRequest,
} from './selectors'

export {
  getIncomingProjectRequests,
  getIncomingRequestCounts,
  getIncomingRequestForThread,
  getRequestQualityForConversation,
  hasProjectAttachmentForConversation,
  sortIncomingRequests,
} from './requestInboxSelectors'

export type {
  IncomingRequestItem,
  IncomingRequestStatus,
  IncomingRequestCounts,
  IncomingRequestSort,
} from './requestInboxSelectors'

export type {
  ThreadArtifact,
  ThreadArtifacts,
  ProjectArtifact,
  OfferPaymentArtifact,
  OfferPaymentPhase,
  FundingStepArtifact,
  FundingStepPhase,
  ProjectSnapshot,
  OfferSnapshot,
  ChangeOrderArtifact,
  ChangeOrderSnapshot,
  InvoiceArtifact,
  InvoiceSnapshot,
} from './threadArtifactTypes'

export { getThreadArtifacts, findCanonicalJobForConversation } from './threadArtifactSelectors'

export type {
  WriteOperation,
  WriteResult,
  PersistenceStatus,
  TruthTraceSnapshot,
} from './threadArtifactTruthTrace'

export {
  recordWriteResult,
  getWriteResults,
  getLastWriteResult,
  clearWriteResults,
  checkProjectArtifactPersistence,
  checkOfferArtifactPersistence,
  buildTruthTraceSnapshot,
} from './threadArtifactTruthTrace'

export type {
  ArtifactType,
  ThreadArtifactRecord,
  ThreadArtifactRepository,
} from './threadArtifactRecord'

export {
  getThreadArtifactRecords,
  getThreadArtifactRecord,
  findArtifactRecordsByProjectId,
  persistProjectArtifact,
  persistOfferArtifact,
  persistPaymentPhaseArtifact,
  persistChangeOrderArtifact,
  persistInvoiceArtifact,
  updateOfferArtifactPhase,
  updateFundingArtifactPhase,
  updateChangeOrderArtifactPhase,
  updateInvoiceArtifactPhase,
  backfillThreadArtifacts,
} from './threadArtifactService'

export {
  isConversationParticipant,
  filterConversationsByParticipant,
  filterConversationsByCraftsman,
  deduplicateConversationsByPair,
  resolveCanonicalConversation,
  getPairKey,
  getRelationshipGroup,
} from './participantScope'

export type { MessageRepository } from './repository'
export {
  getMessageRepository,
  setMessageRepository,
  initializeMessageRepository,
  SupabaseMessageRepository,
  getThreadArtifactRepository,
  setThreadArtifactRepository,
  initializeThreadArtifactRepository,
  subscribeThreadArtifacts,
  SupabaseThreadArtifactRepository,
} from './repository'
