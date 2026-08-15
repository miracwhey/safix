export type MessageRole = 'customer' | 'craftsman'
export type MessageSender = 'user' | 'counterparty' | 'system'

export type InquiryOrigin = 'reel' | 'profile' | 'project' | 'category'

export type Conversation = {
  id: string
  projectId: string

  customerName: string
  customerAvatarUrl: string

  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl: string
  /**
   * Supabase user_id of the craftsman associated with this conversation.
   * Populated at conversation creation time from the explore reel or profile.
   * Used to attribute completed jobs to the correct craftsman profile.
   */
  craftsmanUserId?: string
  /**
   * Supabase user_id of the customer who initiated this conversation.
   * Stamped at conversation creation time via the active session
   * (getSession().user?.id).  Used as the canonical customer owner link for
   * RLS policies on conversations, messages, and ultimately jobs converted
   * from this conversation via convertInquiryToProjectWorkflow.
   */
  customerUserId?: string

  projectTitle: string
  projectSubtitle: string
  projectLocation?: string
  projectCostRange?: string
  projectDuration?: string
  projectStatusLabel?: string

  timeLabel?: string
  unreadCount?: number

  /** Set when the conversation was started from an explore inquiry flow. */
  inquiryOrigin?: InquiryOrigin
  /** Set when the conversation was started from a structured builder project. */
  sourceProjectId?: string

  /**
   * Free-text description of the work the customer is requesting.
   * Populated by `startCategoryInquiryWorkflow` and forwarded to the job's
   * `intakeContext.requestDescription` during inquiry conversion.
   */
  projectDescription?: string

  /**
   * Structured search criteria derived from a reel inquiry.
   * Populated by `startReelInquiryWorkflow` when the reel carries enough context.
   */
  inquiryCriteria?: {
    category: string
    description: string
    location: string
    budget?: string
    timing?: string
  }

  /**
   * Unix timestamp (ms) set when a craftsman first opens and reviews this
   * inquiry thread. Used to transition the triage status from `new_unread`
   * to `needs_response` without requiring an explicit reply.
   */
  reviewedAt?: number

  /**
   * Unix timestamp (ms) set when a craftsman explicitly declines this request.
   * Declined threads are removed from the incoming-request inbox.
   */
  declinedAt?: number

  /**
   * Unix timestamp (ms) when this conversation was first created.
   * Added by migration 20241200000000 as the canonical sort key for
   * repository-level ORDER BY (newest threads first on load).
   */
  createdAt?: number
}

export type MessageAttachmentType = 'project'

export type MessageProjectAttachment = {
  projectId: string
  title: string
  category?: string
  description?: string
  location: string
  requestedBudget?: string
  requestedTiming?: string
  status: string
}

export type Message = {
  id: string
  conversationId: string
  sender: MessageSender
  text: string
  createdAtLabel: string
  /**
   * Unix timestamp (ms) when this message was sent.
   * Added by migration 20241200000000 as the canonical sort key for
   * repository-level ORDER BY (chronological order within a thread).
   */
  sentAt?: number
  attachmentType?: MessageAttachmentType
  projectAttachment?: MessageProjectAttachment
}

export type ProjectContext = {
  title: string
  subtitle: string
  location?: string
  costRange?: string
  duration?: string
  statusLabel?: string
}

export type MessageItem = {
  id: string
  sender: MessageSender
  text: string
  createdAtLabel: string
  sentAt?: number
  attachmentType?: MessageAttachmentType
  projectAttachment?: MessageProjectAttachment
}

export type MessageThread = {
  id: string

  customerName: string
  customerAvatarUrl: string
  customerUserId?: string

  craftsmanName: string
  craftsmanHandle: string
  craftsmanAvatarUrl: string
  craftsmanUserId?: string

  project: ProjectContext

  lastMessagePreview: string
  timeLabel?: string
  unreadCount?: number

  messages: MessageItem[]

  /** True when the counterpart is blocked — thread is read-only. */
  isBlocked?: boolean
}

export type ThreadListRow = {
  avatarUrl: string
  primaryName: string
  secondaryLine: string
  timeLabel?: string
  unreadCount: number
  preview: string
}

export type ThreadHeader = {
  avatarUrl: string
  primaryName: string
  secondaryLine: string
  helperLine: string
  /** Craftsman user ID for profile navigation (customer view only) */
  craftsmanUserId?: string
  /** Customer user ID for potential future navigation (craftsman view only) */
  customerUserId?: string
}
