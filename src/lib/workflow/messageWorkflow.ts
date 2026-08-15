import { getJobById, getJobs } from '../jobs/service'
import { isJobRepositoryHydrated } from '../jobs/service'
import type { Job, JobConversation, JobMessage, JobMessageSender } from '../jobs/types'
import type { JobStatus, PaymentState } from '../shared/coreTypes'
import {
  getActionablePaymentState,
  getJobStatusLabel,
  getPaymentStateLabel,
} from '../jobs/helpers'
import {
  getConversationById,
  getConversationByProjectId,
  getConversations,
  getMessagesByConversationId,
  sendMessageToThread,
  sendProjectAttachmentToThread,
  setActiveThreadProject,
  resolveCanonicalThreadId,
  getRelationshipGroup,
  deduplicateConversationsByPair,
  resolveCanonicalConversation,
  isMessageRepositoryHydrated,
  type MessageItem,
  type MessageSender,
} from '../messages'
import { getPaymentForJob } from '../payments'
import { getDisputeByJobId } from '../disputes'
import { getScheduleForJob } from '../operations'
import { getArtifactsByJobId } from '../media'
import { getTimelineSignalsForJob } from '../timeline'
import {
  deriveJobOperationalSummary,
  type OperationalPhase,
  type OperationalBlocker,
} from '../jobs/operationalSummarySelectors'
import type { NextActionViewModel } from '../jobs/nextActionSelectors'
import type { ScheduleReadiness } from '../operations/schedulingSelectors'
import { getProjectById, getProjectByJobId } from '../projects'
import { recordWriteResult } from '../messages/threadArtifactTruthTrace'
import { findCanonicalJobForConversation } from '../messages/threadArtifactSelectors'
import { getThreadArtifactRecords } from '../messages/threadArtifactService'
import { logWarning, logError } from '../observability'
import { normalizeErrorMessage } from '../diagnostics'
import { isFundingConfirmedForJob, getFundingRequestByJobId } from '../payments/fundingRequest'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'

export type ThreadJobContext = {
  jobId: string
  jobTitle: string
  status: JobStatus
  statusLabel: string
  paymentState?: PaymentState
  paymentStateLabel?: string
  amount: string
  location: string
  dateLabel: string
  /** Coarse operational phase of the job */
  phase: OperationalPhase
  /** Human-readable label for the operational phase */
  phaseLabel: string
  /** The most important next action from the craftsman's perspective */
  nextAction: NextActionViewModel
  /** Current blocker preventing the next workflow step */
  blocker: OperationalBlocker
  /** Schedule readiness derived from the job's schedule timing. Null when no schedule. */
  scheduleReadiness: ScheduleReadiness | null
  /** Human-readable label for schedule readiness. Empty string when null. */
  scheduleReadinessLabel: string
  /** True when the job has no schedule and one should be created */
  needsScheduling: boolean
  /** True when the customer must take an action to unblock progress */
  requiresCustomerAction: boolean
  /** True when the craftsman must take an action to move forward */
  requiresCraftsmanAction: boolean
  /** The customer's builder-project ID linked to this job, if one exists */
  customerProjectId: string | null
}

export function getJobContextForThread(threadId: string): ThreadJobContext | null {
  const conversation = getConversationById(threadId)
  if (!conversation) return null

  // Use the canonical job resolver shared with threadArtifactSelectors.
  // This eliminates the old parallel split-brain scan that used a separate
  // three-way OR lookup, decoupled from the artifact resolution logic.
  const jobResult = findCanonicalJobForConversation(conversation, getJobs())
  if (!jobResult) return null
  const job = jobResult.job

  const payment = getPaymentForJob(job.id)
  let effectivePaymentState = getActionablePaymentState(job, payment)

  // Funded truth dominates: if funding is confirmed but the Payment entity
  // still shows deposit_required (stale denormalized state), override to
  // deposit_paid so downstream surfaces (context bar, next-action) see
  // the canonical funded truth.
  if (effectivePaymentState === 'deposit_required' && isFundingConfirmedForJob(job.id)) {
    effectivePaymentState = 'deposit_paid'
  }
  const dispute = getDisputeByJobId(job.id)
  const schedule = getScheduleForJob(job.id)
  const artifacts = getArtifactsByJobId(job.id)
  const timelineSignals = getTimelineSignalsForJob(job.id)

  const summary = deriveJobOperationalSummary({
    jobId: job.id,
    jobStatus: job.status,
    paymentState: effectivePaymentState,
    disputeStatus: dispute?.status,
    schedulingStatus: schedule?.schedulingStatus,
    schedule,
    artifactCount: artifacts.length,
    timelineSignals,
    proposalSentAt: job.proposalSentAt,
    proposalAcceptedAt: job.proposalAcceptedAt,
    fundingStatus: getFundingRequestByJobId(job.id)?.status,
  })

  const customerProject = getProjectByJobId(job.id) ?? getProjectById(job.projectId) ?? null

  return {
    jobId: job.id,
    jobTitle: job.title,
    status: job.status,
    statusLabel: getJobStatusLabel(job.status),
    paymentState: effectivePaymentState,
    paymentStateLabel: effectivePaymentState ? getPaymentStateLabel(effectivePaymentState) : undefined,
    amount: resolveCanonicalAmount(job.id).formatted || job.amount,
    location: job.location,
    dateLabel: job.dateLabel,
    phase: summary.phase,
    phaseLabel: summary.phaseLabel,
    nextAction: summary.nextAction,
    blocker: summary.blocker,
    scheduleReadiness: summary.scheduleReadiness,
    scheduleReadinessLabel: summary.scheduleReadinessLabel,
    needsScheduling: summary.needsScheduling,
    requiresCustomerAction: summary.requiresCustomerAction,
    requiresCraftsmanAction: summary.requiresCraftsmanAction,
    customerProjectId: customerProject?.id ?? null,
  }
}

function mapJobMessageSenderToConversationSender(
  sender: JobMessageSender
): MessageSender {
  return sender === 'business' ? 'counterparty' : 'user'
}

function mapConversationSenderToJobMessageSender(
  sender: MessageSender
): JobMessageSender {
  return sender === 'user' ? 'customer' : 'business'
}

function mapMessageItemToJobMessage(message: MessageItem): JobMessage {
  return {
    id: message.id,
    sender: mapConversationSenderToJobMessageSender(message.sender),
    text: message.text,
    createdAtLabel: message.createdAtLabel,
  }
}

/**
 * Resolves the conversation associated with a job.
 *
 * Resolution priority:
 *  1. Direct back-link: `job.sourceConversationId` (set at inquiry conversion
 *     time by `convertInquiryToProjectWorkflow`).  O(1) lookup via conversation
 *     ID.
 *  2. Synthetic projectId scan: `getConversationByProjectId(job.projectId)`.
 *     Reliable for legacy jobs that predate `sourceConversationId` because
 *     `job.projectId === conversation.projectId` by construction.
 */
function getConversationForJob(job: Job) {
  return job.sourceConversationId
    ? getConversationById(job.sourceConversationId)
    : getConversationByProjectId(job.projectId)
}

export function getConversationMessagesForJob(jobId: string): MessageItem[] {
  const job = getJobById(jobId)
  if (!job) return []

  const conversation = getConversationForJob(job)
  if (!conversation) return []

  // Consolidate messages across the full relationship group so that
  // messages on duplicate conversations are included in the job context.
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)
  const seen = new Set<string>()
  const items: MessageItem[] = []

  for (const cid of groupIds) {
    for (const message of getMessagesByConversationId(cid)) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      items.push({
        id: message.id,
        sender: message.sender,
        text: message.text,
        createdAtLabel: message.createdAtLabel,
        sentAt: message.sentAt,
      })
    }
  }

  // Sort chronologically
  items.sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
  return items
}

/**
 * Deterministic conversation linkage status for a job.
 *
 * Returns a 3-state result so screens can distinguish between:
 *   - 'linked'       — a real conversation exists for this job
 *   - 'not_hydrated' — repositories haven't loaded yet; can't determine
 *   - 'not_linked'   — repos are hydrated and no conversation found
 *
 * Screens should show a loading placeholder for 'not_hydrated' and the
 * "no messages" empty state only for 'not_linked'.  This prevents the
 * false "no messages" contradiction when a real conversation exists but
 * the message repository hasn't hydrated yet.
 */
export type ConversationLinkageStatus = 'linked' | 'not_hydrated' | 'not_linked'

export function getConversationLinkageStatus(jobId: string): ConversationLinkageStatus {
  const job = getJobById(jobId)
  if (!job) {
    return isJobRepositoryHydrated() ? 'not_linked' : 'not_hydrated'
  }

  const conversation = getConversationForJob(job)
  if (conversation) return 'linked'

  return isMessageRepositoryHydrated() ? 'not_linked' : 'not_hydrated'
}

export async function sendJobConversationMessage(params: {
  jobId: string
  sender: JobMessageSender
  text: string
}): Promise<void> {
  const job = getJobById(params.jobId)
  if (!job) {
    logWarning('workflow.messages.send_job_message.job_not_found', { jobId: params.jobId })
    return
  }

  const conversation = getConversationForJob(job)
  if (!conversation) {
    logWarning('workflow.messages.send_job_message.conversation_not_found', { jobId: params.jobId })
    return
  }

  // Resolve to canonical conversation so messages always target the
  // master thread, not a stale duplicate linked via legacy job data.
  const allConversations = getConversations()
  const canonical = resolveCanonicalConversation(conversation, allConversations)

  await sendMessageToThread(
    canonical.id,
    params.text,
    mapJobMessageSenderToConversationSender(params.sender)
  )
}

/**
 * Returns the live message count for a project's conversation.
 *
 * Resolution priority:
 *   1. sourceConversationId — canonical link via job.sourceConversationId
 *   2. getConversationByProjectId(projectId) — legacy projectId-based lookup
 *   3. fallbackCount — denormalized project.messageCount for offline / unlinked
 *
 * The sourceConversationId path ensures correct counts even when
 * linkJobToProject has changed job.projectId away from the synthetic
 * conversation projectId (e.g. after offer acceptance).
 *
 * Consolidates message counts across the full relationship group so
 * messages on duplicate conversations are included.
 */
export function getProjectConversationMessageCount(
  projectId: string,
  fallbackCount = 0,
  sourceConversationId?: string
): number {
  // Canonical path: direct conversation lookup by sourceConversationId.
  // When provided, this is authoritative — return the count (even if 0)
  // without falling through to the legacy path, which could find a
  // different conversation and return a misleading count.
  if (sourceConversationId) {
    const conversation = getConversationById(sourceConversationId)
    if (conversation) {
      // Consolidate across relationship group
      const allConversations = getConversations()
      const groupIds = getRelationshipGroup(conversation, allConversations)
      const seen = new Set<string>()
      for (const cid of groupIds) {
        for (const m of getMessagesByConversationId(cid)) {
          seen.add(m.id)
        }
      }
      return seen.size
    }
    return getMessagesByConversationId(sourceConversationId).length
  }

  // Legacy path: lookup by projectId or sourceProjectId
  const conversation = getConversationByProjectId(projectId)
  if (!conversation) return fallbackCount

  // Consolidate across relationship group
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)
  const seen = new Set<string>()
  for (const cid of groupIds) {
    for (const m of getMessagesByConversationId(cid)) {
      seen.add(m.id)
    }
  }
  return seen.size
}

export function getJobConversations(): JobConversation[] {
  const jobs = getJobs()
  const conversations = getConversations()

  // Deduplicate conversations by pair to prevent the same job from
  // appearing multiple times when historical duplicate conversation rows
  // exist for the same customer ↔ craftsman relationship.
  const dedupedConversations = deduplicateConversationsByPair(conversations)

  const result: JobConversation[] = []

  for (const conversation of dedupedConversations) {
    // Collect all conversation IDs in the relationship group for job matching
    const groupIds = getRelationshipGroup(conversation, conversations)
    const groupIdSet = new Set(groupIds)

    const job =
      jobs.find((entry) => entry.sourceConversationId && groupIdSet.has(entry.sourceConversationId)) ??
      jobs.find((entry) => entry.projectId === conversation.projectId) ??
      (conversation.sourceProjectId
        ? jobs.find((entry) => entry.projectId === conversation.sourceProjectId)
        : undefined)
    if (!job) continue

    // Consolidate messages across all conversations in the relationship group
    const seen = new Set<string>()
    const messages: JobMessage[] = []
    for (const cid of groupIds) {
      for (const message of getMessagesByConversationId(cid)) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        messages.push(
          mapMessageItemToJobMessage({
            id: message.id,
            sender: message.sender,
            text: message.text,
            createdAtLabel: message.createdAtLabel,
          })
        )
      }
    }

    const lastMessage: JobMessage | null =
      messages.length > 0 ? messages[messages.length - 1] : null

    result.push({
      jobId: job.id,
      jobTitle: job.title,
      customer: job.customer,
      status: job.status,
      messages,
      lastMessage,
    })
  }

  return result.sort((a, b) => {
    if (!a.lastMessage && !b.lastMessage) return 0
    if (!a.lastMessage) return 1
    if (!b.lastMessage) return -1
    return b.messages.length - a.messages.length
  })
}

export async function appendJobMessageViaWorkflow(params: {
  jobId: string
  sender: JobMessageSender
  text: string
}): Promise<void> {
  await sendJobConversationMessage(params)
}

export async function sendDirectMessageWorkflow(
  threadId: string,
  text: string,
  sender: MessageSender = 'user'
): Promise<void> {
  // Resolve to the canonical conversation for the pair so messages always
  // target the visible thread, even if the caller holds a stale reference.
  const canonicalId = resolveCanonicalThreadId(threadId)
  await sendMessageToThread(canonicalId, text, sender)
}

export async function sendProjectAttachmentWorkflow(
  threadId: string,
  projectId: string,
  sender: MessageSender = 'user'
): Promise<boolean> {
  // Resolve to the canonical conversation for the pair so project sends
  // always target the visible thread, not a hidden duplicate.
  const canonicalId = resolveCanonicalThreadId(threadId)
  const conversation = getConversationById(canonicalId)
  if (!conversation) {
    throw new Error(
      `sendProjectAttachmentWorkflow: conversation not found (threadId=${threadId}, canonicalId=${canonicalId})`
    )
  }

  // Snapshot the artifact count BEFORE the send.  We aggregate across
  // the full relationship group so verification succeeds even if the
  // defense-in-depth canonical re-resolution inside
  // sendProjectAttachmentToThread targets a different conversation in
  // the same customer↔craftsman pair.
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)

  const countProjectArtifactsInGroup = (): number =>
    groupIds.reduce(
      (sum, cid) =>
        sum +
        getThreadArtifactRecords(cid).filter(
          (r) => r.artifactType === 'project' && r.projectId === projectId
        ).length,
      0
    )

  const beforeCount = countProjectArtifactsInGroup()

  try {
    await sendProjectAttachmentToThread(canonicalId, projectId, sender)

    // Post-write verification: confirm the project artifact record was
    // appended.  Previous versions checked only `sourceProjectId` which
    // is set on the FIRST send but unchanged on resends.  This now
    // compares the before/after artifact count across the full
    // relationship group so that every send (including resends) is
    // individually confirmed — even when the write landed on a
    // non-canonical conversation in the group.
    const afterCount = countProjectArtifactsInGroup()
    const persisted = afterCount > beforeCount

    recordWriteResult({
      operation: 'sendProjectAttachmentToThread',
      timestamp: Date.now(),
      success: persisted,
      ...(!persisted && { error: 'project artifact record not confirmed after write' }),
      detail: {
        threadId: canonicalId,
        projectId,
        groupIds,
        artifactCountBefore: beforeCount,
        artifactCountAfter: afterCount,
        persistedConfirmed: persisted,
      },
    })

    if (!persisted) {
      logWarning('workflow.truthTrace.project_attach_not_persisted', {
        threadId: canonicalId,
        projectId,
        groupIds,
        artifactCountBefore: beforeCount,
        artifactCountAfter: afterCount,
      })
      // Throw instead of returning false so callers always see the
      // failure — no silent false-success path remains.
      throw new Error(
        'Project send verification failed: artifact record was not confirmed after write'
      )
    }

    return true
  } catch (err) {
    const errorMessage = normalizeErrorMessage(err)
    recordWriteResult({
      operation: 'sendProjectAttachmentToThread',
      timestamp: Date.now(),
      success: false,
      error: errorMessage,
      detail: { threadId: canonicalId, projectId },
    })
    logError('workflow.truthTrace.project_attach_failed', err, { threadId: canonicalId, projectId })
    throw err instanceof Error ? err : new Error(errorMessage)
  }
}

/**
 * Explicitly switches the active operational project for a conversation.
 *
 * The project must already exist in the thread's artifact history — only
 * projects that have been sent as cards can become the active project.
 * Returns true on success, false if the project was not found in thread
 * history or the conversation doesn't exist.
 */
export function setActiveThreadProjectWorkflow(
  threadId: string,
  projectId: string
): boolean {
  return setActiveThreadProject(threadId, projectId)
}
