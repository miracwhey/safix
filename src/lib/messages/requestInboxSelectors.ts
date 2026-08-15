import { getConversations, getConversationById, getMessagesByConversationId } from './store'
import { getJobs } from '../jobs'
import type { Job } from '../jobs'
import { getSession } from '../session'
import { getProjectById } from '../projects'
import {
  computeRequestQualityScore,
  deriveRequestQualitySignals,
  type RequestQualityScore,
  type RequestQualityTier,
} from '../requestQuality'
import { filterConversationsByCraftsman, deduplicateConversationsByPair, getRelationshipGroup, resolveCanonicalConversation } from './participantScope'
import { formatMessageTimeLabel } from './dateUtils'
import type { InquiryOrigin, Conversation } from './types'

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * From the craftsman's perspective, the triage status of an incoming request.
 *
 * - `new_unread`       – Customer has sent messages the craftsman hasn't seen yet
 *                        and the craftsman has not replied at all.
 * - `needs_response`   – Craftsman has seen the messages but hasn't replied yet.
 * - `in_conversation`  – Craftsman has replied at least once (active exchange).
 */
export type IncomingRequestStatus =
  | 'new_unread'
  | 'needs_response'
  | 'in_conversation'

/**
 * A single incoming project request as surfaced in the craftsman request inbox.
 */
export type IncomingRequestItem = {
  threadId: string
  customerName: string
  customerAvatarUrl: string
  projectTitle: string
  projectSubtitle: string
  projectLocation?: string
  projectCostRange?: string
  projectDuration?: string
  /** How the customer reached out — reel, profile, or structured project. */
  inquiryOrigin: InquiryOrigin | null
  /** Present when the inquiry came from a structured builder project. */
  sourceProjectId?: string
  status: IncomingRequestStatus
  timeLabel?: string
  unreadCount: number
  lastMessagePreview: string
  /** True if the customer attached a structured project card to the thread. */
  hasProjectAttachment: boolean
  /** Intrinsic quality score (0–100), craftsman-agnostic. */
  qualityScore: number
  /** Quality tier derived from the score (top | solide | pruefen). */
  qualityTier: RequestQualityTier
  /** Unix ms of the most recent activity, used for newest-first sorting. */
  lastActivityAt: number
}

/**
 * Counts returned by `getIncomingRequestCounts`.
 */
export type IncomingRequestCounts = {
  total: number
  unread: number
  needsResponse: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * True if any message across the conversation's relationship group carries a
 * structured project attachment. This is the proof of a structured project —
 * `sourceProjectId` alone only marks project-origin intent.
 */
export function hasProjectAttachmentForConversation(conversation: Conversation): boolean {
  const groupIds = getRelationshipGroup(conversation, getConversations())
  for (const cid of groupIds) {
    for (const message of getMessagesByConversationId(cid)) {
      if (message.attachmentType === 'project') return true
    }
  }
  return false
}

/**
 * Computes the intrinsic quality score for a single conversation.
 *
 * Single source of truth shared by the inbox list and the request detail
 * screen, so both surfaces always agree on a request's score. To guarantee
 * that agreement it first resolves the dedup-canonical conversation for the
 * customer↔craftsman pair: the inbox already passes that canonical row, while
 * the detail screen resolves by projectId and may hit a non-canonical first
 * match when the pair has more than one conversation. Scoring the canonical
 * row in both cases keeps the inbox tier badge and the detail score identical.
 *
 * Inbox callers pass their already-computed `hasProjectAttachment` and `jobs`
 * to avoid redundant store reads; the detail screen calls it bare.
 */
export function getRequestQualityForConversation(
  conversation: Conversation,
  options?: { hasProjectAttachment?: boolean; jobs?: Job[] },
): RequestQualityScore {
  const canonical = resolveCanonicalConversation(conversation, getConversations())
  const jobs = options?.jobs ?? getJobs()
  const hasProjectAttachment =
    options?.hasProjectAttachment ?? hasProjectAttachmentForConversation(canonical)
  const linkedProject = canonical.sourceProjectId
    ? getProjectById(canonical.sourceProjectId)
    : undefined
  const isReturningCustomer = canonical.customerUserId
    ? jobs.some(
        (job) =>
          job.customerUserId === canonical.customerUserId &&
          job.status === 'completed',
      )
    : false

  const signals = deriveRequestQualitySignals({
    inquiryOrigin: canonical.inquiryOrigin ?? null,
    inquiryCriteria: canonical.inquiryCriteria,
    projectDescription: canonical.projectDescription,
    projectLocation: canonical.projectLocation,
    projectCostRange: canonical.projectCostRange,
    projectDuration: canonical.projectDuration,
    linkedProjectCategory: linkedProject?.category,
    linkedProjectDescription: linkedProject?.description,
    hasProjectAttachment,
    isReturningCustomer,
  })

  return computeRequestQualityScore(signals)
}

/** Sort key for the incoming request inbox. */
export type IncomingRequestSort = 'newest' | 'quality'

/**
 * Sorts incoming requests by the chosen key without mutating the input.
 * `newest` orders by most-recent activity; `quality` by descending score
 * (newest as tie-breaker). Pure — it never filters or hides: the inbox flags
 * quality, it does not suppress low-scoring requests.
 */
export function sortIncomingRequests(
  items: IncomingRequestItem[],
  sortBy: IncomingRequestSort,
): IncomingRequestItem[] {
  const sorted = [...items]
  if (sortBy === 'quality') {
    sorted.sort(
      (a, b) => b.qualityScore - a.qualityScore || b.lastActivityAt - a.lastActivityAt,
    )
  } else {
    sorted.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }
  return sorted
}

// ── Public selectors ───────────────────────────────────────────────────────

/**
 * Returns all incoming project requests visible to the craftsman — that is,
 * conversations that arrived through an inquiry flow (`inquiryOrigin` is set)
 * and have NOT yet been converted to a structured job/project.
 *
 * Results are sorted by triage urgency:
 *   1. new_unread   (needs immediate attention)
 *   2. needs_response
 *   3. in_conversation
 *
 * This is a pure read function — it performs no state mutations.
 */
export function getIncomingProjectRequests(): IncomingRequestItem[] {
  const allConversations = getConversations()
  const jobs = getJobs()

  // Defense-in-depth: only return conversations where the current user is
  // the craftsman-side participant.  The Supabase repository already loads
  // only the current user's conversations, but this explicit filter prevents
  // cross-account leakage if the cache ever contains stale data from a
  // previous session or if the InMemoryMessageRepository is used without
  // user-scoped data.
  const currentUserId = getSession().user?.id ?? undefined
  const scoped = filterConversationsByCraftsman(allConversations, currentUserId)

  // Deduplicate: show only one canonical thread per customer ↔ craftsman
  // pair.  Multiple historical records for the same pair can exist from
  // legacy data or race conditions; only the most recent is surfaced.
  const conversations = deduplicateConversationsByPair(scoped)

  // Build lookup sets for both resolution paths to catch all linked jobs
  const jobsBySourceConversation = new Set(
    jobs.map((j) => j.sourceConversationId).filter(Boolean)
  )
  const jobProjectIds = new Set(jobs.map((j) => j.projectId))

  const statusOrder: Record<IncomingRequestStatus, number> = {
    new_unread: 0,
    needs_response: 1,
    in_conversation: 2,
  }

  return conversations
    .filter((c) => {
      // Only conversations that arrived through an inquiry flow
      if (!c.inquiryOrigin) return false

      // Collect all conversation IDs in the relationship group to check
      // job linkage comprehensively across duplicate conversations.
      const groupIds = getRelationshipGroup(c, allConversations)

      // Exclude threads that have already been converted to a job
      // Check BOTH sourceConversationId (primary, new) AND projectId (fallback, legacy).
      // Also check sourceProjectId: after a customer attaches a real builder project
      // the conversation's sourceProjectId carries the canonical project UUID, and a
      // job created via offer acceptance will reference that same UUID as its projectId.
      for (const cid of groupIds) {
        if (jobsBySourceConversation.has(cid)) return false
        const gc = getConversationById(cid)
        if (gc) {
          if (jobProjectIds.has(gc.projectId)) return false
          if (gc.sourceProjectId && jobProjectIds.has(gc.sourceProjectId)) return false
        }
      }

      // Exclude explicitly declined requests
      if (c.declinedAt) return false
      return true
    })
    .map((c) => {
      // Consolidate messages across all conversations in the relationship group
      const groupIds = getRelationshipGroup(c, allConversations)
      const allMessages: { sender: string; text: string; attachmentType?: string; sentAt?: number }[] = []
      const seen = new Set<string>()
      for (const cid of groupIds) {
        for (const m of getMessagesByConversationId(cid)) {
          if (seen.has(m.id)) continue
          seen.add(m.id)
          allMessages.push(m)
        }
      }
      // Sort chronologically for correct last-message preview
      allMessages.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))

      const hasCraftsmanReply = allMessages.some((m) => m.sender === 'counterparty')
      const hasCustomerMessage = allMessages.some((m) => m.sender === 'user')
      const hasProjectAttachment = allMessages.some(
        (m) => m.attachmentType === 'project'
      )

      const lastMessage = allMessages[allMessages.length - 1]
      const lastMessagePreview =
        lastMessage?.attachmentType === 'project'
          ? '📋 Projekt angehängt'
          : (lastMessage?.text ?? '')

      // Consolidated unread count across the group
      let unreadCount = 0
      for (const cid of groupIds) {
        const gc = getConversationById(cid)
        if (gc) unreadCount += gc.unreadCount ?? 0
      }

      let status: IncomingRequestStatus
      if (unreadCount > 0 && !hasCraftsmanReply && !c.reviewedAt) {
        // Unread messages that the craftsman has never opened
        status = 'new_unread'
      } else if (hasCustomerMessage && !hasCraftsmanReply) {
        // Craftsman has seen the request (opened or unread cleared) but not replied
        status = 'needs_response'
      } else {
        status = 'in_conversation'
      }

      // Derive timeLabel from consolidated messages, consistent with how
      // buildThread derives inbox timeLabel.  This ensures the request inbox
      // shows the time of the most recent activity across all conversations
      // in the relationship group, not a stale per-conversation label.
      let timeLabel = c.timeLabel
      let lastActivityAt = 0
      const lastSentAt = lastMessage?.sentAt
      if (lastSentAt && lastSentAt > 0) {
        lastActivityAt = lastSentAt
        timeLabel = formatMessageTimeLabel(lastSentAt)
      } else {
        // Fall back to most recent createdAt across the group
        let latestCreatedAt = 0
        for (const cid of groupIds) {
          const gc = getConversationById(cid)
          if (gc?.createdAt && gc.createdAt > latestCreatedAt) {
            latestCreatedAt = gc.createdAt
          }
        }
        if (latestCreatedAt > 0) {
          lastActivityAt = latestCreatedAt
          timeLabel = formatMessageTimeLabel(latestCreatedAt)
        }
      }

      const quality = getRequestQualityForConversation(c, { hasProjectAttachment, jobs })

      return {
        threadId: c.id,
        customerName: c.customerName,
        customerAvatarUrl: c.customerAvatarUrl,
        projectTitle: c.projectTitle,
        projectSubtitle: c.projectSubtitle,
        projectLocation: c.projectLocation,
        projectCostRange: c.projectCostRange,
        projectDuration: c.projectDuration,
        inquiryOrigin: c.inquiryOrigin ?? null,
        sourceProjectId: c.sourceProjectId,
        status,
        timeLabel,
        unreadCount,
        lastMessagePreview,
        hasProjectAttachment,
        qualityScore: quality.score,
        qualityTier: quality.tier,
        lastActivityAt,
      } satisfies IncomingRequestItem
    })
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
}

/**
 * Returns badge-ready counts for the craftsman request inbox.
 * Use this to populate navigation badges without building the full item list.
 */
export function getIncomingRequestCounts(): IncomingRequestCounts {
  const requests = getIncomingProjectRequests()
  return {
    total: requests.length,
    unread: requests.filter((r) => r.status === 'new_unread').length,
    needsResponse: requests.filter((r) => r.status === 'needs_response').length,
  }
}

/**
 * Returns the `IncomingRequestItem` for a specific thread, or null when the
 * thread is not an active incoming request (already converted, declined, or
 * not originating from an inquiry flow).
 *
 * Reuses `getIncomingProjectRequests` so all filtering and derivation logic
 * is applied consistently.
 */
export function getIncomingRequestForThread(
  threadId: string
): IncomingRequestItem | null {
  return getIncomingProjectRequests().find((r) => r.threadId === threadId) ?? null
}
