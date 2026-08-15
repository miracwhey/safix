import { logError } from '../observability'
import { supabase } from '../supabase'
import { getChatRepository } from './repository'
import type {
  ChatInquiryCriteria,
  ChatInquiryOrigin,
  ChatMessageViewModel,
  ChatThreadDisplayMetadata,
  SendMessageInput,
} from './types'

/**
 * Block D Slice 1 Phase 1a — chat service (write-side).
 *
 * Workflow-Layer (chatWorkflow.ts) ruft hier rein für RBAC-gechecktes Senden.
 * Service-Layer ist dünn: delegated an Repository, fügt Logging hinzu.
 *
 * Attachments-Upload (chat-customer/-internal Bucket) reused
 * `mediaUploadService.ts` + `preUploadPipeline.ts` (Block A Pattern).
 * Reuse-Wiring kommt in Phase 1b zusammen mit UI-Cutover; Phase 1a stellt
 * das API hier bereit damit chatWorkflow.ts darauf zeigen kann.
 */

export async function sendTextMessage(
  threadId: string,
  body: string,
  clientMessageId: string,
): Promise<ChatMessageViewModel> {
  return sendMessageInternal({
    threadId,
    body,
    messageType: 'text',
    clientMessageId,
  })
}

export async function sendArtifactReferenceMessage(
  threadId: string,
  artifactType: string,
  artifactId: string,
  clientMessageId: string,
  body?: string,
): Promise<ChatMessageViewModel> {
  return sendMessageInternal({
    threadId,
    body,
    messageType: 'artifact_card',
    artifactType,
    artifactId,
    clientMessageId,
  })
}

async function sendMessageInternal(input: SendMessageInput): Promise<ChatMessageViewModel> {
  try {
    return await getChatRepository().sendMessage(input)
  } catch (err) {
    logError('chat.service.send_failed', err, {
      threadId: input.threadId,
      messageType: input.messageType,
    })
    throw err
  }
}

export async function markRead(threadId: string, lastMessageId: string): Promise<void> {
  return getChatRepository().markThreadRead(threadId, lastMessageId)
}

export async function enqueueLazyMigration(
  legacyThreadId: string,
  legacySource: 'conversations' | 'message_threads',
): Promise<void> {
  await getChatRepository().enqueueMigration(legacyThreadId, legacySource, 100)
}

/**
 * Reconcile gap on App-Resume / Network-Reconnect.
 * Ruft Cursor-Reconcile via getMessagesSince() auf.
 * Wird von session.ts handleAppResume() für aktive Threads getriggert.
 */
export async function reconcileMessagesSince(
  threadId: string,
  sinceMessageId: string,
): Promise<ChatMessageViewModel[]> {
  return getChatRepository().getMessagesSince(threadId, sinceMessageId)
}

// ── Thread-Create RPCs (Phase 1b) ────────────────────────────────────────────
// These call the SECURITY DEFINER RPCs added in migration 20260514000001.
// They write directly to chat_threads (not legacy message_threads).

/**
 * CHAT-1: Seed the repository cache with the RPC-created thread BEFORE the
 * caller receives the id. The repo fills `threads` only in loadForUser
 * (full hydrate) and Realtime has no chat_threads INSERT listener — without
 * this seed every first send into a freshly created thread fails with
 * thread_not_found (workflow guard) while the screen has already enabled
 * the composer. Awaiting here also closes the screen-side race: when
 * setChatThreadId fires, the thread is guaranteed in cache.
 */
async function seedThreadCacheOrThrow(threadId: string): Promise<string> {
  const cached = await getChatRepository().ensureThreadInCache(threadId)
  if (!cached) {
    logError('chat.service.thread_cache_seed_failed', null, { threadId })
    throw new Error('Thread konnte nicht geladen werden.')
  }
  return threadId
}

export async function getOrCreateChatOfficeThread(): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_office_thread')
  if (error) {
    logError('chat.service.office_thread_failed', error)
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}

export async function getOrCreateChatTeamThread(): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_team_thread')
  if (error) {
    logError('chat.service.team_thread_failed', error)
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}

export async function getOrCreateChatAssignmentThread(calendarEntryId: string): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_assignment_thread', {
    p_calendar_entry_id: calendarEntryId,
  })
  if (error) {
    logError('chat.service.assignment_thread_failed', error, { calendarEntryId })
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}

/**
 * Get-or-create a 1:1 direct (person-to-person) thread with another user by
 * their profile id. Server-side (rpc_get_or_create_chat_direct_thread) enforces
 * discoverability, dm_privacy, block (both directions) and a per-day rate limit;
 * it is idempotent per user-pair. Throws with the RPC error on any gate
 * (e.g. `not_available`, `rate_limited`) so the caller can surface a message.
 */
export async function getOrCreateChatDirectThread(targetProfileId: string): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_direct_thread', {
    p_target_profile_id: targetProfileId,
  })
  if (error) {
    logError('chat.service.direct_thread_failed', error, { targetProfileId })
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}

/**
 * Chat-Cutover: optional inquiry payload for customer-thread creation.
 * Forwarded to the extended rpc_get_or_create_chat_customer_thread
 * (migration 20260611000000). When omitted, the rpc payload stays
 * byte-identical to the pre-cutover call (defaults apply server-side).
 */
export interface CustomerThreadInquiryInput {
  inquiryOrigin: ChatInquiryOrigin
  sourceProjectId?: string | null
  inquiryCriteria?: ChatInquiryCriteria | null
  displayMetadata?: ChatThreadDisplayMetadata | null
}

export async function getOrCreateChatCustomerThread(
  craftsmanUserId: string,
  title?: string,
  inquiry?: CustomerThreadInquiryInput,
): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_customer_thread', {
    p_craftsman_user_id: craftsmanUserId,
    p_title: title ?? null,
    ...(inquiry != null && {
      p_inquiry_origin: inquiry.inquiryOrigin,
      p_source_project_id: inquiry.sourceProjectId ?? null,
      p_inquiry_criteria: inquiry.inquiryCriteria ?? null,
      p_display_metadata: inquiry.displayMetadata ?? null,
    }),
  })
  if (error) {
    logError('chat.service.customer_thread_failed', error, { craftsmanUserId })
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}

export async function getOrCreateChatDisputeThread(disputeId: string): Promise<string> {
  const { data, error } = await supabase.rpc('rpc_get_or_create_chat_dispute_thread', {
    p_dispute_id: disputeId,
  })
  if (error) {
    logError('chat.service.dispute_thread_failed', error, { disputeId })
    throw error
  }
  return seedThreadCacheOrThrow(data as string)
}
