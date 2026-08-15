import { getChatRepository } from './repository'
import type { ChatMessageViewModel, ChatThreadViewModel } from './types'
import { getJobs } from '../jobs'
import type { Job } from '../jobs'
import { getSession } from '../session'
import { getProjectById } from '../projects'
import {
  computeRequestQualityScore,
  deriveRequestQualitySignals,
  type RequestQualityScore,
} from '../requestQuality'
import { formatMessageTimeLabel } from '../messages/dateUtils'
import type {
  IncomingRequestCounts,
  IncomingRequestItem,
  IncomingRequestSort,
  IncomingRequestStatus,
} from '../messages/requestInboxSelectors'

/**
 * Chat-Cutover port of `lib/messages/requestInboxSelectors.ts` onto the
 * chat_threads domain. Same item shape (`IncomingRequestItem`, type-only
 * import — no runtime dependency on the legacy module) so screens can swap
 * sources behind the cutover flag without remapping.
 *
 * Differences vs. the legacy selector, by design:
 * - No relationship-group consolidation: the chat domain guarantees one open
 *   thread per customer↔craftsman pair (server-side reuse in
 *   rpc_get_or_create_chat_customer_thread). A pair-dedup remains as
 *   defense-in-depth for backfilled legacy duplicates.
 * - Message-derived flags (craftsman reply, project attachment, preview)
 *   degrade gracefully to thread-level fields (`lastMessageBody`,
 *   `lastMessageAt`) when a thread's messages are not yet in the cache —
 *   messages hydrate lazily per thread.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function visibleMessages(threadId: string): ChatMessageViewModel[] {
  return getChatRepository()
    .getMessages(threadId)
    .filter((m) => !m.deletedAt && !m.redacted)
}

/**
 * True if any cached message carries a structured project artifact.
 * Case-insensitive: the chat-domain producer writes the canonical capital
 * 'Project' (ChatArtifactType), while legacy-mapped rows may carry lowercase
 * 'project' — both must count.
 */
export function hasProjectAttachmentForThread(threadId: string): boolean {
  return visibleMessages(threadId).some((m) => m.artifactType?.toLowerCase() === 'project')
}

/**
 * Intrinsic quality score for an inquiry thread — chat-domain twin of
 * `getRequestQualityForConversation`. Signals come from the thread's inquiry
 * columns + display metadata; linked-project and returning-customer signals
 * are resolved exactly like the legacy path so both sources score identically
 * for the same request.
 */
export function getRequestQualityForThread(
  thread: ChatThreadViewModel,
  options?: { hasProjectAttachment?: boolean; jobs?: Job[] },
): RequestQualityScore {
  const jobs = options?.jobs ?? getJobs()
  const hasProjectAttachment =
    options?.hasProjectAttachment ?? hasProjectAttachmentForThread(thread.id)
  const md = thread.displayMetadata
  const linkedProject = thread.sourceProjectId
    ? getProjectById(thread.sourceProjectId)
    : undefined
  const isReturningCustomer = thread.customerUserId
    ? jobs.some(
        (job) =>
          job.customerUserId === thread.customerUserId &&
          job.status === 'completed',
      )
    : false

  const signals = deriveRequestQualitySignals({
    inquiryOrigin: thread.inquiryOrigin ?? null,
    inquiryCriteria: thread.inquiryCriteria ?? undefined,
    projectDescription: md?.projectDescription ?? undefined,
    projectLocation: md?.projectLocation ?? undefined,
    projectCostRange: md?.projectCostRange ?? undefined,
    projectDuration: md?.projectDuration ?? undefined,
    linkedProjectCategory: linkedProject?.category,
    linkedProjectDescription: linkedProject?.description,
    hasProjectAttachment,
    isReturningCustomer,
  })

  return computeRequestQualityScore(signals)
}

/**
 * Sorts incoming requests without mutating the input — same contract as the
 * legacy `sortIncomingRequests` (re-implemented here so the chat selector has
 * no runtime import of the legacy module).
 */
export function sortIncomingRequestsFromChat(
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

/** Defense-in-depth pair-dedup: keep the most recently created thread per pair. */
function deduplicateThreadsByPair(threads: ChatThreadViewModel[]): ChatThreadViewModel[] {
  const byPair = new Map<string, ChatThreadViewModel>()
  for (const t of threads) {
    const key = `${t.customerUserId ?? ''}|${t.craftsmanUserId ?? ''}`
    const existing = byPair.get(key)
    if (!existing || (t.createdAt ?? 0) > (existing.createdAt ?? 0)) {
      byPair.set(key, t)
    }
  }
  return [...byPair.values()]
}

// ── Public selectors ───────────────────────────────────────────────────────

/**
 * All incoming project requests visible to the craftsman, read from the chat
 * domain: customer-channel threads with `inquiryOrigin` set that are neither
 * declined nor already converted to a job.
 *
 * Sorted by triage urgency (new_unread → needs_response → in_conversation),
 * matching the legacy selector. Pure read — no state mutations.
 */
export function getIncomingProjectRequestsFromChat(): IncomingRequestItem[] {
  const currentUserId = getSession().user?.id
  if (!currentUserId) return []

  const jobs = getJobs()
  const repo = getChatRepository()

  const threads = deduplicateThreadsByPair(
    repo
      .getThreads('customer')
      // Inquiry threads only, scoped to the craftsman side of the current user
      // (defense-in-depth — hydration is RLS-scoped already).
      .filter((t) => t.inquiryOrigin != null && t.craftsmanUserId === currentUserId),
  )

  const jobsBySourceConversation = new Set(
    jobs.map((j) => j.sourceConversationId).filter(Boolean),
  )
  const jobProjectIds = new Set(jobs.map((j) => j.projectId))

  const statusOrder: Record<IncomingRequestStatus, number> = {
    new_unread: 0,
    needs_response: 1,
    in_conversation: 2,
  }

  return threads
    .filter((t) => {
      // Converted to a job? sourceConversationId carries the chat-thread id
      // for cutover-era jobs; syntheticProjectId / sourceProjectId cover the
      // legacy projectId fallback matching.
      if (jobsBySourceConversation.has(t.id)) return false
      const syntheticProjectId = t.displayMetadata?.syntheticProjectId
      if (syntheticProjectId && jobProjectIds.has(syntheticProjectId)) return false
      if (t.sourceProjectId && jobProjectIds.has(t.sourceProjectId)) return false
      if (t.declinedAt) return false
      return true
    })
    .map((t) => {
      const md = t.displayMetadata
      const messages = visibleMessages(t.id)

      const hasCraftsmanReply = messages.some(
        (m) => m.messageType !== 'system' && m.senderUserId === t.craftsmanUserId,
      )
      const hasCustomerMessage = messages.some(
        (m) => m.messageType !== 'system' && m.senderUserId === t.customerUserId,
      )
      const hasProjectAttachment = messages.some(
        (m) => m.artifactType?.toLowerCase() === 'project',
      )

      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
      const lastMessagePreview =
        lastMessage?.artifactType?.toLowerCase() === 'project'
          ? '📋 Projekt angehängt'
          : (lastMessage?.body ?? t.lastMessageBody ?? '')

      const unreadCount = t.unreadCount

      let status: IncomingRequestStatus
      if (unreadCount > 0 && !hasCraftsmanReply && !t.reviewedAt) {
        status = 'new_unread'
      } else if (hasCustomerMessage && !hasCraftsmanReply) {
        status = 'needs_response'
      } else {
        status = 'in_conversation'
      }

      const lastActivityAt =
        lastMessage?.createdAt ?? t.lastMessageAt ?? t.createdAt
      const timeLabel =
        lastActivityAt > 0 ? formatMessageTimeLabel(lastActivityAt) : undefined

      const quality = getRequestQualityForThread(t, { hasProjectAttachment, jobs })

      return {
        threadId: t.id,
        customerName: md?.customerName ?? 'Kunde',
        customerAvatarUrl: md?.customerAvatarUrl ?? '',
        projectTitle: md?.projectTitle ?? t.title ?? 'Anfrage',
        projectSubtitle: md?.projectSubtitle ?? 'Neue Anfrage',
        projectLocation: md?.projectLocation ?? undefined,
        projectCostRange: md?.projectCostRange ?? undefined,
        projectDuration: md?.projectDuration ?? undefined,
        inquiryOrigin: t.inquiryOrigin ?? null,
        sourceProjectId: t.sourceProjectId ?? undefined,
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

/** Badge-ready counts for the craftsman request inbox (chat source). */
export function getIncomingRequestCountsFromChat(): IncomingRequestCounts {
  const requests = getIncomingProjectRequestsFromChat()
  return {
    total: requests.length,
    unread: requests.filter((r) => r.status === 'new_unread').length,
    needsResponse: requests.filter((r) => r.status === 'needs_response').length,
  }
}

/**
 * The `IncomingRequestItem` for a specific chat thread, or null when the
 * thread is not an active incoming request.
 */
export function getIncomingRequestForThreadFromChat(
  threadId: string,
): IncomingRequestItem | null {
  return (
    getIncomingProjectRequestsFromChat().find((r) => r.threadId === threadId) ?? null
  )
}
