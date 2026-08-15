import { getMessageRepository } from './repository'
import {
  getConversations,
  getConversationById,
  getConversationByProjectId,
  getMessages,
  getMessagesByConversationId,
  subscribeMessages,
} from './messagesStore'
import type { Conversation, MessageSender, MessageProjectAttachment } from './types'
import { getProjectById } from '../projects'
import { formatMessageTimeLabel } from './dateUtils'
import { persistProjectArtifact } from './threadArtifactService'
import { getThreadArtifactRepository } from './repository/threadArtifactRegistry'
import { resolveCanonicalConversation, getRelationshipGroup } from './participantScope'
import { logWarning } from '../observability'
import { normalizeErrorMessage } from '../diagnostics'
import { getBlockedUserIdsSync, isBlockedByCounterpart } from '../moderation/moderationService'
import { checkContent } from '../moderation/contentFilter'
import { getSession } from '../session'
export { formatMessageTimeLabel } from './dateUtils'

/**
 * Generates a collision-resistant message ID using the current timestamp
 * plus a short random suffix.
 */
function generateMessageId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export {
  subscribeMessages,
  getConversations,
  getConversationById,
  getConversationByProjectId,
  getMessages,
  getMessagesByConversationId,
}

/**
 * Returns `true` once the message repository has completed its initial data
 * load.  Used by screens to distinguish "not loaded yet" from "genuinely
 * does not exist" without resorting to a timeout.
 */
export function isMessageRepositoryHydrated(): boolean {
  return getMessageRepository().isHydrated()
}

export function getMessageRepositoryError(): string | null {
  return getMessageRepository().getLastError()
}

export function addConversation(conversation: Conversation): Promise<void> {
  return getMessageRepository().addConversation(conversation)
}

export function updateConversation(
  id: string,
  patch: Partial<Omit<Conversation, 'id'>>
): void {
  getMessageRepository().updateConversation(id, patch)
}

export async function sendMessageToThread(
  threadId: string,
  text: string,
  sender: MessageSender = 'user'
): Promise<void> {
  const rawConversation = getConversationById(threadId)
  if (!rawConversation) return

  // Defense-in-depth: resolve to canonical conversation for the pair so
  // messages always target the same thread shown in the inbox, even if
  // the caller holds a reference to a non-canonical duplicate.
  const conversation = resolveCanonicalConversation(rawConversation, getConversations())

  // Block enforcement: prevent sending messages to blocked users.
  const blockedIds = getBlockedUserIdsSync()
  if (blockedIds.size > 0) {
    const currentUserId = getSession().user?.id
    if (currentUserId) {
      const counterpartId = conversation.customerUserId === currentUserId
        ? conversation.craftsmanUserId
        : conversation.customerUserId
      if (counterpartId && blockedIds.has(counterpartId)) {
        throw new Error('Nachricht kann nicht gesendet werden — Nutzer ist blockiert.')
      }

      // Reverse check: prevent sending if the recipient has blocked the sender.
      if (counterpartId) {
        const blockedByRecipient = await isBlockedByCounterpart(counterpartId)
        if (blockedByRecipient) {
          throw new Error('Nachricht kann nicht gesendet werden.')
        }
      }
    }
  }

  const trimmed = text.trim()
  if (!trimmed) return

  // Content filter: block obviously abusive messages before persistence.
  const contentCheck = checkContent(trimmed)
  if (!contentCheck.allowed) {
    throw new Error(contentCheck.reason ?? 'Nachricht kann nicht gesendet werden.')
  }

  const sentAt = Date.now()
  const label = formatMessageTimeLabel(sentAt)

  await getMessageRepository().addMessageAndUpdateConversation(
    {
      id: generateMessageId(),
      conversationId: conversation.id,
      sender,
      text: trimmed,
      createdAtLabel: label,
      sentAt,
    },
    conversation.id,
    { timeLabel: label, unreadCount: 0 }
  )
}

export async function sendProjectAttachmentToThread(
  threadId: string,
  projectId: string,
  sender: MessageSender = 'user'
): Promise<void> {
  const rawConversation = getConversationById(threadId)
  if (!rawConversation) {
    throw new Error(
      `sendProjectAttachmentToThread: conversation not found (threadId=${threadId})`
    )
  }

  // Defense-in-depth: resolve to canonical conversation for the pair so
  // project sends always target the same thread shown in the inbox, even
  // if the caller holds a reference to a non-canonical duplicate.
  const conversation = resolveCanonicalConversation(rawConversation, getConversations())

  const project = getProjectById(projectId)
  if (!project) {
    throw new Error(
      `sendProjectAttachmentToThread: project not found (projectId=${projectId})`
    )
  }

  // Resolve participant UIDs defensively.  The conversation metadata
  // usually carries both, but conversations created during a cold-start
  // (auth session not yet available) may lack customerUserId.  Without
  // it, the thread_artifacts RLS policy (INSERT WITH CHECK
  // auth.uid() = customer_user_id OR auth.uid() = craftsman_user_id)
  // rejects the INSERT because null never equals auth.uid().
  const resolvedCustomerUserId =
    conversation.customerUserId ?? getSession().user?.id ?? undefined
  const resolvedCraftsmanUserId = conversation.craftsmanUserId

  // Persist a new append-only project artifact record.  Each send creates
  // a new record — multiple project cards coexist in the same thread.
  // Snapshot fields are written so the card renders immediately without
  // waiting for the project repository to hydrate.
  //
  // ATOMICITY: sourceProjectId is set AFTER persistProjectArtifact
  // succeeds — not before.  This guarantees that top context is never
  // updated without a corresponding visible history event.  If the
  // persist fails, sourceProjectId remains unchanged and the caller
  // sees the failure.
  await persistProjectArtifact({
    conversationId: conversation.id,
    projectId: project.id,
    customerUserId: resolvedCustomerUserId,
    craftsmanUserId: resolvedCraftsmanUserId,
    snapshotTitle: project.title,
    snapshotStatus: project.status,
    snapshotSummary: project.category ?? project.description,
    snapshotCategory: project.category,
    snapshotLocation: project.location,
    snapshotBudget: project.requestedBudget,
    snapshotTiming: project.requestedTiming,
  })

  // Stamp sourceProjectId ONLY when the conversation has no active project
  // yet.  The first project sent becomes the active operational project.
  // Later sends extend thread history (append-only artifacts) but do NOT
  // overwrite the active project pointer — that requires an explicit user
  // action via setActiveThreadProject.
  //
  // Placed AFTER persistProjectArtifact so the top context pointer is
  // consistent with the persisted artifact record.
  if (!conversation.sourceProjectId) {
    updateConversation(conversation.id, { sourceProjectId: project.id })
  }

  // ── Partial-failure contract ────────────────────────────────────────
  // The artifact record above IS the canonical truth — the thread has
  // a project card once `persistProjectArtifact` succeeds.  The message
  // below is a secondary notification ("Projekt angehängt").  If the
  // message write fails, the project card remains visible; the chat just
  // won't contain the notification bubble.  We log the failure but do
  // NOT re-throw, because the canonical state is consistent.

  const attachment: MessageProjectAttachment = {
    projectId: project.id,
    title: project.title,
    category: project.category,
    description: project.description,
    location: project.location,
    requestedBudget: project.requestedBudget,
    requestedTiming: project.requestedTiming,
    status: project.status,
  }

  const sentAt = Date.now()
  const label = formatMessageTimeLabel(sentAt)

  try {
    await getMessageRepository().addMessageAndUpdateConversation(
      {
        id: generateMessageId(),
        conversationId: conversation.id,
        sender,
        text: '',
        createdAtLabel: label,
        sentAt,
        attachmentType: 'project',
        projectAttachment: attachment,
      },
      conversation.id,
      { timeLabel: label, unreadCount: 0 }
    )
  } catch (messageError) {
    // Artifact is persisted — thread has a project card.
    // The notification message failed but that is a cosmetic gap, not a
    // data integrity issue.  Log and continue instead of re-throwing.
    logWarning('messages.service.project_attachment_message_failed', {
      threadId: conversation.id,
      projectId: project.id,
      error: normalizeErrorMessage(messageError),
    })
  }
}

/**
 * Explicitly sets the active operational project for a conversation.
 *
 * This is the ONLY path that can change the active project pointer
 * (`sourceProjectId`) after the first project has been set.  The project
 * must already exist as an artifact in the thread history — arbitrary
 * project IDs are rejected.
 *
 * Returns true if the active project was changed, false if the project
 * was not found in thread history or the conversation doesn't exist.
 */
export function setActiveThreadProject(
  threadId: string,
  projectId: string
): boolean {
  const rawConversation = getConversationById(threadId)
  if (!rawConversation) return false

  // Resolve to canonical conversation so the active-project pointer is
  // always written to the master thread, not a stale duplicate.
  const conversation = resolveCanonicalConversation(rawConversation, getConversations())

  // Verify the project exists as an artifact in this thread's history.
  // Check across the full relationship group so artifacts persisted on
  // any duplicate conversation are found.
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)
  let hasArtifact = false
  for (const cid of groupIds) {
    const artifactRecords = getThreadArtifactRepository().getByConversationId(cid)
    if (artifactRecords.some((r) => r.artifactType === 'project' && r.projectId === projectId)) {
      hasArtifact = true
      break
    }
  }
  if (!hasArtifact) return false

  updateConversation(conversation.id, { sourceProjectId: projectId })
  return true
}

/**
 * Resolves the Hauptprojekt status for a project across all conversations.
 *
 * Returns:
 * - `{ isActive: true, threadId }` when the project is the active Hauptprojekt
 * - `{ isActive: false, threadId }` when the project exists in a thread's
 *   artifact history but is NOT the active project (can be promoted)
 * - `null` when the project is not associated with any thread
 */
export function getProjectHauptprojektStatus(
  projectId: string
): { isActive: boolean; threadId: string } | null {
  const conversations = getConversations()

  // Check if any conversation has this project as the active one
  for (const c of conversations) {
    if (c.sourceProjectId === projectId) {
      return { isActive: true, threadId: c.id }
    }
  }

  // Check if any thread has this project as an artifact (but not active)
  const records = getThreadArtifactRepository()
    .getAll()
    .filter((r) => r.artifactType === 'project' && r.projectId === projectId)

  if (records.length > 0) {
    return { isActive: false, threadId: records[0].conversationId }
  }

  return null
}
