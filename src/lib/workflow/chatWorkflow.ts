import { logError, logWarning } from '../observability'
import { supabase } from '../supabase'
import { getChatRepository } from '../chat'
import type {
  ChatAttachment,
  ChatChannelType,
  ChatDeleteMode,
  ChatInquiryCriteria,
  ChatInquiryOrigin,
  ChatMessageViewModel,
  ChatRole,
  ChatThread,
  ChatThreadDisplayMetadata,
  SendMessageInput,
} from '../chat'
import { getOrCreateChatCustomerThread } from '../chat/service'
import {
  uploadChatAttachmentBlob,
  uploadVoiceNoteBlob,
  uploadVideoAttachmentBlob,
  cleanupOrphanAttachmentBlobs,
  bucketForChannel,
  assetTypeForMime,
  type ChatAttachmentBlob,
} from '../chat/repository/chatAttachmentUploader'
import { VOICE_MAX_DURATION_MS } from '../chat/voice/types'
import { getBlockedUserIdsSync } from '../moderation/moderationService'
import { checkContent } from '../moderation/contentFilter'
import {
  cacheAttachment,
  clearCachedAttachment,
  getCachedAttachment,
} from '../chat/attachmentPendingCache'
import {
  cacheVoiceRecording,
  readVoiceRecording,
  clearVoiceRecording,
} from '../chat/voice/recordingCache'
import { uploadWithRetry, OfflineError, ChatUploadError } from '../chat/uploadWithRetry'
import * as mediaOutbox from '../chat/mediaOutbox'
import type { MediaOutboxRecord, MediaOutboxKind } from '../chat/mediaOutbox'
import { CHAT_OUTBOX_DRAIN_EVENT } from '../chat/mediaOutbox'

export { OfflineError, ChatUploadError }

/**
 * Non-fatal signal: an optimistic media bubble was inserted AND persisted to
 * the media outbox, but the synchronous send did not complete (offline, or a
 * transient upload/RPC failure). The bubble STAYS pending (WhatsApp clock) and
 * the drain-worker retries on reconnect. The screen must NOT surface this as a
 * red error — it is a normal "queued" outcome.
 */
export class ChatSendQueuedError extends Error {
  readonly bubbleInserted = true
  readonly queued = true
  readonly kind: MediaOutboxKind
  constructor(kind: MediaOutboxKind) {
    super('Wird gesendet …')
    this.name = 'ChatSendQueuedError'
    this.kind = kind
  }
}

/**
 * Block D Slice 1 Phase 1a — chatWorkflow with RBAC-Guards.
 *
 * Architektur-Regel: Chat besitzt KEINE Business-Logik.
 * Workflow-Layer-RBAC-Guards Pflicht (Memory: feedback_workflow_layer_rbac_pflicht.md).
 * Worker darf NIE customer-Channel berühren — Hard-Exclusion an 3 Stellen:
 *   - RLS-Policy (Server-side Defense-in-Depth)
 *   - Storage-RLS (chat-customer Bucket)
 *   - chatWorkflow (UI-side First-Line)
 *
 * Phase 1a: Workflow ist fertig + getestet, aber UI nicht migriert (Phase 1b).
 */

// Error types live in lib/chat/errors so the repository can throw them
// without importing the workflow (avoids circular import).
export {
  ChatRBACError,
  ChatMigrationPendingError,
} from '../chat/errors'
export type {
  ChatRBACErrorCode,
  ChatMigrationPendingErrorCode,
} from '../chat/errors'

import { ChatRBACError, classifyChatSendError } from '../chat/errors'

/**
 * Resolve the thread a send targets. Every send workflow runs BEFORE
 * repo.sendMessage and historically read only the synchronous in-memory
 * cache (repo.getThread). A transient miss — a concurrent loadForUser
 * clear()→repopulate window, a TOKEN_REFRESHED resync, or a cross-device /
 * push-created thread the Realtime layer never seeded (there is no
 * chat_threads INSERT listener) — was therefore misclassified as a PERMANENT
 * thread_not_found that bricked every retry until app-kill.
 *
 * ensureThreadInCache is an authoritative server read (chat_threads +
 * participants under RLS), NOT a cheap optimistic shim: a genuinely
 * RLS-invisible or deleted thread still returns undefined and we still throw.
 * A recoverable eviction self-heals on the same tap.
 */
async function resolveThreadOrSeed(
  repo: ReturnType<typeof getChatRepository>,
  threadId: string,
): Promise<ChatThread> {
  const cached = repo.getThread(threadId)
  if (cached) return cached
  const seeded = await repo.ensureThreadInCache(threadId)
  if (seeded) return seeded
  throw new ChatRBACError(
    'thread_not_found',
    `Thread ${threadId} not visible (cache + server seed)`,
  )
}

/**
 * Send timeout for the media attachment RPC. Mirrors the text path's
 * SEND_MESSAGE_TIMEOUT_MS in SupabaseChatRepository: a hung WKWebView socket
 * (suspended app, half-open connection) must settle the RPC deterministically
 * so the optimistic bubble flips to 'failed' (red retry) and the orphan blob is
 * cleaned, instead of spinning 'pending' forever.
 */
const SEND_RPC_TIMEOUT_MS = 15_000

/**
 * Invoke rpc_send_chat_message_with_attachments with a deterministic timeout.
 * Normalises an aborted/throwing fetch to the same `{ data, error }` shape the
 * call sites already branch on, so every media path's existing failure branch
 * (failOptimisticMessage + cleanupOrphanAttachmentBlobs) runs on timeout.
 */
async function sendChatMessageWithAttachmentsRpc(
  args: Record<string, unknown>,
): Promise<{ data: unknown; error: (Error & { code?: string }) | null }> {
  try {
    const res = await supabase
      .rpc('rpc_send_chat_message_with_attachments', args)
      .abortSignal(AbortSignal.timeout(SEND_RPC_TIMEOUT_MS))
    return { data: res.data, error: (res.error as (Error & { code?: string }) | null) ?? null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Delete uploaded blobs ONLY when the send definitively failed pre-commit.
 *
 * On a transient error (timeout / abort / network) the RPC's commit state is
 * UNKNOWN — it may have committed (chat_attachments now reference these storage
 * paths) and only the ACK was lost. Deleting the blobs would orphan a committed
 * message's media permanently: the idempotent retry returns the existing row
 * WITHOUT re-uploading, so the message stays pointed at a deleted blob (broken
 * image/video/voice). Only a definitive authz/validation/schema reject means the
 * transaction certainly rolled back and the blobs are true orphans safe to drop.
 * A transient-error blob is left for the idempotent retry / a server-side sweep.
 */
function cleanupBlobsUnlessMaybeCommitted(error: unknown, blobs: ChatAttachmentBlob[]): void {
  if (classifyChatSendError(error).klass === 'transient') return
  void cleanupOrphanAttachmentBlobs(blobs)
}

// ── Media outbox: drain-worker + shared send engine ─────────────────────────
//
// Every media send (voice / photo / document / video) is persisted to the IDB
// media outbox BEFORE its first upload attempt (state 'queued'). The SAME
// engine (performMediaSendAttempt) runs the initial send AND every background
// retry, so there is exactly one upload+RPC code path. WhatsApp semantics:
//   - transient failure ⇒ bubble STAYS pending, record kept, capped backoff
//     retry (5s → 15s → 60s → 5min, unbounded).
//   - permanent failure ⇒ record 'failed' + red bubble (tap-retry / discard).
//   - reconnect / online / app-resume ⇒ drain the whole queue.
//   - a server row already present (idempotent RPC) ⇒ mark sent + remove.

/** Backoff schedule (ms) by attempt count. Caps at 5min, retries forever. */
export function mediaOutboxBackoffMs(attempts: number): number {
  const schedule = [5_000, 15_000, 60_000, 300_000]
  const idx = Math.min(Math.max(attempts - 1, 0), schedule.length - 1)
  return schedule[idx]
}

/** clientMessageIds with an upload in flight — the double-send guard. Keyed
 *  synchronously (no await between has/add) so two concurrent drains can never
 *  both pick the same record. */
const inFlightSends = new Set<string>()
/** Per-record pending backoff timers so a record is re-scheduled at most once. */
const backoffTimers = new Map<string, ReturnType<typeof setTimeout>>()
let autoDrainInstalled = false

/** Install the window-level auto-drain triggers exactly once (idempotent). */
export function startMediaOutboxAutoDrain(): void {
  if (autoDrainInstalled) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('online', () => { void drainMediaOutbox() })
  window.addEventListener(CHAT_OUTBOX_DRAIN_EVENT, () => { void drainMediaOutbox() })
  autoDrainInstalled = true
}

function scheduleBackoffDrain(clientMessageId: string, attempts: number): void {
  if (backoffTimers.has(clientMessageId)) return
  const timer = setTimeout(() => {
    backoffTimers.delete(clientMessageId)
    void drainMediaOutbox()
  }, mediaOutboxBackoffMs(attempts))
  backoffTimers.set(clientMessageId, timer)
}

type MediaSendOutcome = 'sent' | 'already-sent' | 'transient' | 'permanent' | 'dropped' | 'in-flight'

interface MediaAttemptResult {
  outcome: MediaSendOutcome
  messageId?: string
  attachmentIds?: string[]
  attachment?: ChatAttachmentBlob
  error?: unknown
}

interface MediaAttemptOptions {
  /** In-memory blob for the initial send. Drains read from the blob cache. */
  blob?: Blob
  /** Pre-extracted video poster (initial send only). */
  posterFile?: File | null
  onProgress?: (pct: number) => void
}

/** Read the persisted blob for a record from its kind-specific IDB cache. */
async function readBlobForRecord(record: MediaOutboxRecord): Promise<Blob | null> {
  if (record.kind === 'voice') {
    const cached = await readVoiceRecording(record.clientMessageId)
    return cached?.blob ?? null
  }
  const cached = await getCachedAttachment(record.clientMessageId)
  return cached?.blobData ?? null
}

async function clearBlobForRecord(record: MediaOutboxRecord): Promise<void> {
  if (record.kind === 'voice') {
    await clearVoiceRecording(record.clientMessageId)
    return
  }
  await clearCachedAttachment(record.clientMessageId)
}

/** Kind-dispatch to the right storage uploader. Signature per B1 contract:
 *  uploader fns accept `{ signal?, onProgress? }`. */
function uploadForRecord(
  record: MediaOutboxRecord,
  blob: Blob,
  posterFile: File | null,
  onProgress: ((pct: number) => void) | undefined,
  signal: AbortSignal,
): Promise<ChatAttachmentBlob> {
  const common = {
    threadId: record.threadId,
    channelType: record.channelType,
    providerId: record.providerId,
    clientMessageId: record.clientMessageId,
    signal,
  }
  if (record.kind === 'voice') {
    return uploadVoiceNoteBlob({
      ...common,
      blob,
      durationMs: record.metadata.durationMs ?? 0,
      mimeType: record.mimeType,
      fileExtension: record.metadata.fileExtension ?? undefined,
    })
  }
  if (record.kind === 'video') {
    return uploadVideoAttachmentBlob({
      ...common,
      blob,
      mimeType: record.mimeType,
      fileExtension: record.metadata.fileExtension ?? 'mp4',
      durationMs: record.metadata.durationMs ?? 0,
      width: record.metadata.width ?? null,
      height: record.metadata.height ?? null,
      preExtractedPosterFile: posterFile,
      onProgress,
    })
  }
  // image | document — the attachment uploader takes a File.
  const file =
    blob instanceof File ? blob : new File([blob], record.fileName, { type: record.mimeType })
  return uploadChatAttachmentBlob({ ...common, file })
}

function buildRpcAttachments(blob: ChatAttachmentBlob) {
  return [
    {
      asset_type: blob.assetType,
      mime_type: blob.mimeType,
      size_bytes: blob.sizeBytes,
      storage_bucket: blob.storageBucket,
      storage_path: blob.storagePath,
      width: blob.width,
      height: blob.height,
      duration_ms: blob.durationMs,
      poster_storage_path: blob.posterStoragePath,
    },
  ]
}

/**
 * The single upload+RPC engine. Idempotent + retry-safe; used by the initial
 * send AND the drain-worker. Never throws — returns a typed outcome. Marks the
 * outbox record / optimistic bubble according to the WhatsApp state machine.
 */
async function performMediaSendAttempt(
  record: MediaOutboxRecord,
  opts: MediaAttemptOptions,
): Promise<MediaAttemptResult> {
  const { clientMessageId } = record
  // Double-send guard lives IN the engine so it covers every entry path —
  // initial send, tap-retry AND drain — against each other. A drain triggered
  // mid-upload (Realtime SUBSCRIBED, 'online', app-resume, backoff timer)
  // would otherwise re-upload the same record and, worse, hit the
  // blob-missing branch after the winner's cleanup and discard a sent bubble.
  if (inFlightSends.has(clientMessageId)) return { outcome: 'in-flight' }
  inFlightSends.add(clientMessageId)
  try {
    return await performMediaSendAttemptLocked(record, opts)
  } finally {
    inFlightSends.delete(clientMessageId)
  }
}

async function performMediaSendAttemptLocked(
  record: MediaOutboxRecord,
  opts: MediaAttemptOptions,
): Promise<MediaAttemptResult> {
  const repo = getChatRepository()
  const { threadId, clientMessageId } = record

  // Idempotency: the server row already landed (Realtime echo) but our ACK /
  // remove was lost — mark sent + clean up instead of re-uploading.
  if (repo.hasSentServerRow(clientMessageId)) {
    repo.markOptimisticSent(threadId, clientMessageId)
    await mediaOutbox.remove(clientMessageId)
    await clearBlobForRecord(record)
    return { outcome: 'already-sent' }
  }

  const blob = opts.blob ?? (await readBlobForRecord(record))
  if (!blob) {
    // The blob is gone (cache swept / private mode / never persisted). We can
    // never complete this send — drop the record and remove the ghost bubble.
    logError('chat.workflow.outbox_blob_missing', null, {
      clientMessageId,
      kind: record.kind,
    })
    repo.discardOptimisticMessage(threadId, clientMessageId)
    await mediaOutbox.remove(clientMessageId)
    return { outcome: 'dropped' }
  }

  await mediaOutbox.markAttempt(clientMessageId)
  const attemptsAfter = record.attempts + 1

  let blobResult: ChatAttachmentBlob
  try {
    blobResult = await uploadWithRetry(
      (signal) => uploadForRecord(record, blob, opts.posterFile ?? null, opts.onProgress, signal),
      { maxAttempts: 3, delays: [1000, 2000, 4000] },
    )
  } catch (err) {
    return finishFailedAttempt(record, err, attemptsAfter, null)
  }

  // Persist the landed path so discard can clean the orphan blob even when
  // the RPC below fails permanently. Best-effort (IDB may be absent).
  await mediaOutbox.setUploadedPath(
    clientMessageId,
    blobResult.storagePath,
    blobResult.posterStoragePath ?? null,
  )

  // Patch the optimistic attachment so URL-resolution fires before the echo.
  repo.updateOptimisticAttachment(threadId, clientMessageId, {
    storagePath: blobResult.storagePath,
    storageBucket: blobResult.storageBucket,
    sizeBytes: blobResult.sizeBytes,
    mimeType: blobResult.mimeType,
    width: blobResult.width ?? undefined,
    height: blobResult.height ?? undefined,
    posterStoragePath: blobResult.posterStoragePath ?? undefined,
  })

  const { data, error } = await sendChatMessageWithAttachmentsRpc({
    p_thread_id: threadId,
    p_client_message_id: clientMessageId,
    p_body: record.metadata.caption ?? null,
    p_reply_to_message_id: null,
    p_attachments: buildRpcAttachments(blobResult),
  })

  if (error) {
    return finishFailedAttempt(record, error, attemptsAfter, blobResult)
  }

  repo.markOptimisticSent(threadId, clientMessageId)
  await mediaOutbox.remove(clientMessageId)
  await clearBlobForRecord(record)
  const result = data as { message_id: string; attachment_ids: string[]; message_type: string }
  return {
    outcome: 'sent',
    messageId: result.message_id,
    attachmentIds: result.attachment_ids,
    attachment: blobResult,
  }
}

/** Classify a failed attempt: transient keeps the bubble pending + schedules a
 *  backoff retry; permanent flips the bubble red + terminalises the record. */
function finishFailedAttempt(
  record: MediaOutboxRecord,
  error: unknown,
  attemptsAfter: number,
  uploadedBlob: ChatAttachmentBlob | null,
): MediaAttemptResult {
  const repo = getChatRepository()
  const { threadId, clientMessageId } = record
  const klass = classifyChatSendError(error).klass
  if (klass === 'transient') {
    // Bubble stays pending — retry via backoff. Record already 'queued'.
    logWarning('chat.workflow.media_send_transient', {
      clientMessageId,
      kind: record.kind,
      attempts: attemptsAfter,
    })
    scheduleBackoffDrain(clientMessageId, attemptsAfter)
    return { outcome: 'transient', error }
  }
  // Permanent: red bubble + failed record + best-effort orphan blob cleanup.
  repo.failOptimisticMessage(threadId, `temp_${clientMessageId}`)
  void mediaOutbox.markFailed(clientMessageId)
  if (uploadedBlob) cleanupBlobsUnlessMaybeCommitted(error, [uploadedBlob])
  logError('chat.workflow.media_send_permanent', error, {
    clientMessageId,
    kind: record.kind,
  })
  return { outcome: 'permanent', error }
}

/**
 * Drain-worker: attempt every queued (not 'failed') outbox record once.
 * Singleton via the in-flight set (double-send guard). Skips while offline —
 * the 'online' listener re-triggers. Idempotent + safe to call concurrently.
 */
export async function drainMediaOutbox(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  let records: MediaOutboxRecord[]
  try {
    records = await mediaOutbox.listAll()
  } catch {
    return
  }
  for (const record of records) {
    if (record.state === 'failed') continue
    const id = record.clientMessageId
    // Cheap skip; the engine holds the authoritative in-flight guard and
    // returns 'in-flight' if a concurrent send won the race after this check.
    if (inFlightSends.has(id)) continue
    try {
      await performMediaSendAttempt(record, {})
    } catch (err) {
      // performMediaSendAttempt never throws, but guard defensively so one bad
      // record can't abort the whole drain.
      logError('chat.workflow.drain_attempt_error', err, { clientMessageId: id })
    }
  }
}

/**
 * Persist a media send to the outbox + run the initial attempt. Offline ⇒
 * enqueue-only (bubble pending, drain on reconnect). Translates the engine
 * outcome into the caller's success value or a typed throw.
 */
async function enqueueAndSendMedia(
  record: MediaOutboxRecord,
  opts: MediaAttemptOptions,
): Promise<MediaAttemptResult> {
  startMediaOutboxAutoDrain()
  await mediaOutbox.enqueue(record)

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Offline send is a success from the user's POV: bubble stays pending, the
    // 'online' listener / app-resume drains the queue. No red bubble, no toast.
    throw new ChatSendQueuedError(record.kind)
  }

  const result = await performMediaSendAttempt(record, opts)
  if (result.outcome === 'sent' || result.outcome === 'already-sent') return result
  if (result.outcome === 'transient' || result.outcome === 'in-flight') {
    throw new ChatSendQueuedError(record.kind)
  }
  // permanent | dropped
  throw new ChatUploadError(result.error ?? new Error('media send failed'))
}

export interface SendMessageWorkflowInput {
  threadId: string
  body?: string
  clientMessageId: string
  artifactType?: string
  artifactId?: string
  replyToMessageId?: string
  callerRole: ChatRole
  /**
   * Passed by callers (screens) so the moderation block-check can resolve
   * the counterpart for customer-channel 1:1 threads. Workflow does NOT
   * read session itself — keeps the workflow module decoupled from the
   * session module's side-effects.
   */
  currentUserId?: string | null
}

/**
 * RBAC-guarded send. Use from UI/composer instead of repository.sendMessage().
 *
 * Guard order:
 *  1. Repository hydrated + thread exists
 *  2. callerRole vs. channel_type (Worker→Customer = REJECT, Customer→Internal = REJECT)
 *  3. Optimistic-Send via Repository (Idempotency by clientMessageId)
 *
 * Repository's RLS server-side enforces the same; this workflow guard is
 * UI-side first-line + clearer error messaging.
 */
export async function sendMessageWorkflow(
  input: SendMessageWorkflowInput,
): Promise<ChatMessageViewModel> {
  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)

  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    logError('chat.workflow.rbac.worker_in_customer_channel', null, {
      threadId: input.threadId,
      callerRole: input.callerRole,
    })
    throw new ChatRBACError(
      'worker_in_customer_channel',
      'Workers cannot send messages in customer channels',
    )
  }

  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    logError('chat.workflow.rbac.customer_in_internal_channel', null, {
      threadId: input.threadId,
      callerRole: input.callerRole,
    })
    throw new ChatRBACError(
      'customer_in_internal_channel',
      'Customers cannot send messages in internal channels',
    )
  }

  // Moderation guards (parity with legacy lib/messages/service.ts:77-106).
  // Enforced for the 1:1 person channels (customer↔craftsman + direct) — the
  // internal channels (office/team/assignment) are intra-organisation and have
  // no block/content concept. For direct, the block-check's counterpart
  // resolution (customer/craftsman columns) is null, so the outbound-block
  // toast is skipped there; blocking is enforced server-side by RLS
  // (is_blocked_by_me silent-drop) and the direct-thread RPC. The content
  // check (profanity/spam) applies to direct too.
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.body, input.currentUserId ?? null)
  }

  const repoInput: SendMessageInput = {
    threadId: input.threadId,
    body: input.body,
    clientMessageId: input.clientMessageId,
    artifactType: input.artifactType,
    artifactId: input.artifactId,
    replyToMessageId: input.replyToMessageId,
    messageType: input.artifactType ? 'artifact_card' : 'text',
  }
  return repo.sendMessage(repoInput)
}

/**
 * Parity with `lib/messages/service.ts:sendMessageToThread` moderation step.
 * Throws a plain Error (not ChatRBACError) so the UI surfaces the user-
 * facing reason as a toast — the existing Stage 3a/3b `handleChatSend`
 * catches and toasts the error message.
 */
async function enforceBlockAndContentChecks(
  thread: ChatThread,
  body: string | undefined,
  currentUserId: string | null,
): Promise<void> {
  // Customer-channel sends REQUIRE a resolved session. Without it, the
  // block-check cannot run and a blocked user could send during the
  // cold-start race window between component mount and the supabase
  // onAuthStateChange callback populating the session cache. The screen
  // is expected to read `getCurrentSession()` fresh at send-time — but
  // workflow-side enforcement is the canonical defense layer.
  if (!currentUserId) {
    throw new Error('Sitzung wird verbunden. Bitte einen Moment warten und erneut versuchen.')
  }

  if (thread.customerUserId && thread.craftsmanUserId) {
    const counterpartId =
      thread.customerUserId === currentUserId
        ? thread.craftsmanUserId
        : thread.customerUserId

    // Outbound: current user blocked the counterpart. UX-intentional throw —
    // sender sees toast "Nutzer ist blockiert" so they know why nothing
    // happened. The mirror direction (inbound: counterpart blocked me) is a
    // silent RLS drop — see migration 20260515000001_chat_block_check.sql.
    // RLS hides the row from the blocker on SELECT/Realtime; the sender's
    // INSERT succeeds with no indication. This is defense-in-depth at the DB
    // layer and the single source of truth for inbound silencing.
    const blockedIds = getBlockedUserIdsSync()
    if (blockedIds.has(counterpartId)) {
      throw new Error('Nachricht kann nicht gesendet werden — Nutzer ist blockiert.')
    }
  }

  if (body && body.trim()) {
    const contentCheck = checkContent(body.trim())
    if (!contentCheck.allowed) {
      throw new Error(contentCheck.reason ?? 'Nachricht kann nicht gesendet werden.')
    }
  }
}

export async function markThreadReadWorkflow(
  threadId: string,
  lastMessageId: string,
): Promise<void> {
  await getChatRepository().markThreadRead(threadId, lastMessageId)
}

// ── Chat-Cutover: Customer-Inquiry-Thread-Erstellung ─────────────────────────

export interface CreateCustomerInquiryThreadInput {
  craftsmanUserId: string
  title: string
  inquiryOrigin: ChatInquiryOrigin
  sourceProjectId?: string | null
  inquiryCriteria?: ChatInquiryCriteria | null
  displayMetadata: ChatThreadDisplayMetadata
}

/**
 * Chat-Cutover replacement for the legacy addConversation() inquiry write.
 *
 * Creates (or reuses — one open thread per customer↔craftsman pair, enforced
 * server-side by rpc_get_or_create_chat_customer_thread) the customer-channel
 * thread carrying the inquiry metadata + denormalised display metadata. The
 * service layer seeds the repository cache before returning, so callers can
 * navigate to the thread immediately (CHAT-1 contract).
 *
 * RBAC: caller must be the customer side — enforced upstream by
 * assertCustomerRole() in exploreInquiryWorkflow and server-side by the RPC
 * (auth.uid() becomes customer_user_id; self-threads rejected).
 */
export async function createCustomerInquiryThreadWorkflow(
  input: CreateCustomerInquiryThreadInput,
): Promise<string> {
  return getOrCreateChatCustomerThread(input.craftsmanUserId, input.title, {
    inquiryOrigin: input.inquiryOrigin,
    sourceProjectId: input.sourceProjectId ?? null,
    inquiryCriteria: input.inquiryCriteria ?? null,
    displayMetadata: input.displayMetadata,
  })
}

export async function enqueueThreadMigrationWorkflow(
  legacyThreadId: string,
  legacySource: 'conversations' | 'message_threads',
  callerRole: ChatRole,
): Promise<void> {
  // Migration-Enqueue ist Owner/Craftsman-only (Worker enqueued nicht ihre eigenen Threads;
  // Customer enqueued über Lazy-on-Open in customer-channel)
  if (callerRole === 'worker') {
    throw new ChatRBACError(
      'worker_in_customer_channel',
      'Workers cannot enqueue migrations',
    )
  }
  await getChatRepository().enqueueMigration(legacyThreadId, legacySource, 100)
}

function isInternalChannel(channelType: ChatChannelType): boolean {
  return channelType === 'office' || channelType === 'team' || channelType === 'assignment'
}

export interface SendAttachmentMessageWorkflowInput {
  threadId: string
  caption?: string
  clientMessageId: string
  callerRole: ChatRole
  files: File[]
  /** See SendMessageWorkflowInput.currentUserId — moderation block-check */
  currentUserId?: string | null
}

export interface SendAttachmentResult {
  messageId: string
  attachmentIds: string[]
  messageType: string
  attachments: ChatAttachmentBlob[]
}

/**
 * RBAC-guarded send with file attachments — atomic version (P0-3 fix).
 *
 * Steps:
 *  1. Same RBAC checks as text-send
 *  2. Upload all files to storage as blobs (NO chat_attachments rows yet)
 *  3. Call rpc_send_chat_message_with_attachments with all blob metadata —
 *     this single transaction inserts chat_messages + chat_attachments rows
 *     atomically. The per-attachment trigger fn_chat_set_message_type_on_attachment
 *     promotes message_type to 'image'/'document'/'voice'/'video' or 'mixed'
 *     based on the asset types in the same transaction.
 *  4. On RPC failure: best-effort storage cleanup of orphan blobs.
 *  5. Realtime broadcasts a single, fully-formed message row — no
 *     intermediate state where Empfänger sieht "leere" Bild-Message.
 */
export async function sendAttachmentMessageWorkflow(
  input: SendAttachmentMessageWorkflowInput,
): Promise<SendAttachmentResult> {
  if (input.files.length === 0) {
    throw new Error('chat.attachment.empty: at least one file required')
  }
  if (input.files.length > 20) {
    throw new Error('chat.attachment.too_many: maximum 20 files per message')
  }
  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError(
      'worker_in_customer_channel',
      'Workers cannot send messages in customer channels',
    )
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError(
      'customer_in_internal_channel',
      'Customers cannot send messages in internal channels',
    )
  }

  // Moderation parity (attachment path) — same scope rule as text send.
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.caption, input.currentUserId ?? null)
  }

  // Step 1: upload all blobs first. If any fails, clean up the rest before
  // throwing so we don't leak partial uploads.
  const blobs: ChatAttachmentBlob[] = []
  try {
    for (const [index, file] of input.files.entries()) {
      const blob = await uploadChatAttachmentBlob({
        threadId: input.threadId,
        channelType: thread.channelType,
        providerId: thread.providerId ?? null,
        // Multi-file sends share one clientMessageId — suffix per file so the
        // deterministic pending path stays unique (x-upsert would otherwise
        // overwrite same-extension siblings) while retries still upsert.
        clientMessageId: index > 0 ? `${input.clientMessageId}-${index}` : input.clientMessageId,
        file,
      })
      blobs.push(blob)
    }
  } catch (err) {
    logError('chat.workflow.attachment_blob_upload_failed', err, {
      threadId: input.threadId,
      filesAttempted: input.files.length,
      blobsUploaded: blobs.length,
    })
    void cleanupOrphanAttachmentBlobs(blobs)
    throw err
  }

  // Step 2: atomic RPC. chat_messages + chat_attachments inserted in one
  // transaction. The per-attachment trigger promotes message_type.
  const rpcArgs = {
    p_thread_id: input.threadId,
    p_client_message_id: input.clientMessageId,
    p_body: input.caption ?? null,
    p_reply_to_message_id: null,
    p_attachments: blobs.map((b) => ({
      asset_type: b.assetType,
      mime_type: b.mimeType,
      size_bytes: b.sizeBytes,
      storage_bucket: b.storageBucket,
      storage_path: b.storagePath,
      width: b.width,
      height: b.height,
      duration_ms: b.durationMs,
      poster_storage_path: b.posterStoragePath,
    })),
  }

  const { data, error } = await sendChatMessageWithAttachmentsRpc(rpcArgs)

  if (error) {
    logError('chat.workflow.atomic_send_rpc_failed', error, {
      threadId: input.threadId,
      blobsUploaded: blobs.length,
    })
    cleanupBlobsUnlessMaybeCommitted(error, blobs)
    throw error
  }

  const result = data as {
    message_id: string
    attachment_ids: string[]
    message_type: string
    idempotent: boolean
  }

  return {
    messageId: result.message_id,
    attachmentIds: result.attachment_ids,
    messageType: result.message_type,
    attachments: blobs,
  }
}

export interface SendVoiceNoteWorkflowInput {
  threadId: string
  clientMessageId: string
  callerRole: ChatRole
  /** Recorded audio blob produced by the native recorder plugin. */
  blob: Blob
  /** Plugin-reported duration in ms — authoritative for limit enforcement. */
  durationMs: number
  /** Plugin-reported mime type (audio/aac, audio/mp4, audio/webm). */
  mimeType: string
  /** Plugin-reported extension hint (m4a, aac, webm). */
  fileExtension?: string
  /** See SendMessageWorkflowInput.currentUserId — moderation block-check. */
  currentUserId?: string | null
}

export interface SendVoiceNoteResult {
  messageId: string
  attachmentId: string
  durationMs: number
  attachment: ChatAttachmentBlob
}

/**
 * RBAC-guarded voice-note send. Mirrors {@link sendAttachmentMessageWorkflow}
 * but consumes a Blob from the native recorder plugin instead of File[].
 *
 * Caller (composer) is responsible for the surrounding IndexedDB cache
 * lifecycle:
 *   1. Persist blob to `recordingCache` BEFORE invoking this workflow.
 *   2. On resolved success → clear the cache entry.
 *   3. On rejection → keep the entry so a retry-tap can reload the same blob.
 *
 * The RPC is idempotent by `clientMessageId`; retrying with the same id
 * after a transient upload failure will not produce a duplicate message.
 */
export async function sendVoiceNoteWorkflow(
  input: SendVoiceNoteWorkflowInput,
): Promise<SendVoiceNoteResult> {
  // A blob with no bytes is the only hard "empty" — a real recording always
  // carries audio data. Duration is NOT used as the empty signal here: the
  // caller (useVoiceRecorder.finalizeStop) already computes an authoritative
  // wall-clock duration, so the native iOS 0ms mis-report never reaches us.
  if (input.blob.size === 0) {
    throw new Error('chat.voice.empty: blob is empty')
  }
  if (input.durationMs > VOICE_MAX_DURATION_MS) {
    throw new Error(
      `chat.voice.too_long: maximum ${Math.round(VOICE_MAX_DURATION_MS / 1000)} seconds per voice note`,
    )
  }

  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError(
      'worker_in_customer_channel',
      'Workers cannot send messages in customer channels',
    )
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError(
      'customer_in_internal_channel',
      'Customers cannot send messages in internal channels',
    )
  }

  // Moderation parity (content filter does not apply to voice — block check only).
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, undefined, input.currentUserId ?? null)
  }

  // Optimistic insert — voice bubble visible immediately with pending state.
  // No pre-insert offline throw: offline is now a queued success (bubble stays
  // pending, drain-worker sends on reconnect).
  const durationMs = Math.max(0, Math.round(input.durationMs))
  const optimisticAttachment: ChatAttachment = {
    id: `temp_att_${input.clientMessageId}`,
    messageId: `temp_${input.clientMessageId}`,
    assetType: 'voice',
    mimeType: input.mimeType,
    sizeBytes: input.blob.size,
    storageBucket: bucketForChannel(thread.channelType),
    storagePath: '',
    width: null,
    height: null,
    durationMs,
    posterStoragePath: null,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: Date.now(),
    deletedAt: null,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
  }
  repo.insertOptimisticMessage({
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    messageType: 'voice',
    body: null,
    attachments: [optimisticAttachment],
  })

  const fileExtension = input.fileExtension ?? 'm4a'
  // Persist the blob so the drain-worker survives an app-kill mid-send. The
  // composer already caches it before invoking; this is idempotent insurance.
  void cacheVoiceRecording({
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    blob: input.blob,
    durationMs: input.durationMs,
    mimeType: input.mimeType,
    fileExtension,
    createdAt: Date.now(),
  })

  const record: MediaOutboxRecord = {
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    providerId: thread.providerId ?? null,
    kind: 'voice',
    fileName: `voice-${input.clientMessageId}.${fileExtension}`,
    mimeType: input.mimeType,
    storagePath: '',
    metadata: { durationMs: input.durationMs, fileExtension, caption: null },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }

  const result = await enqueueAndSendMedia(record, { blob: input.blob })
  return {
    messageId: result.messageId ?? '',
    attachmentId: result.attachmentIds?.[0] ?? '',
    durationMs: result.attachment?.durationMs ?? durationMs,
    attachment: result.attachment ?? {
      assetType: 'voice',
      mimeType: input.mimeType,
      sizeBytes: input.blob.size,
      storageBucket: bucketForChannel(thread.channelType),
      storagePath: '',
      width: null,
      height: null,
      durationMs,
      posterStoragePath: null,
    },
  }
}

// Re-export ChatAttachment type so callers can build full ViewModels later.
export type { ChatAttachment, ChatAttachmentBlob }

// ── Slice B: per-file optimistic attachment send ──────────────────────────

const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB

// Documents we support end-to-end (picker → magic-byte → bucket allowlist).
// Archives (zip/rar/7z) were removed: they were advertised here but had no
// magic-byte signature and no bucket allowance, so they could never complete —
// don't offer a format that always fails.
const ALLOWED_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
])

export class ChatFileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatFileValidationError'
  }
}

function validateAttachmentFile(file: File, kind: 'photo' | 'document'): void {
  if (file.size === 0) {
    throw new ChatFileValidationError('Datei ist leer — bitte eine andere Datei wählen.')
  }
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new ChatFileValidationError(
      `Datei zu groß (max. 50 MB). Diese Datei hat ${(file.size / 1024 / 1024).toFixed(1)} MB.`,
    )
  }
  const mime = file.type.toLowerCase()
  if (kind === 'photo' && !mime.startsWith('image/')) {
    throw new ChatFileValidationError(`Ungültiger Dateityp: ${file.type}`)
  }
  if (kind === 'document' && !ALLOWED_DOCUMENT_MIMES.has(mime) && !mime.startsWith('image/')) {
    throw new ChatFileValidationError(`Dateityp nicht unterstützt: ${file.type}`)
  }
}

export interface SendSingleAttachmentInput {
  threadId: string
  clientMessageId: string
  callerRole: ChatRole
  file: File
  kind: 'photo' | 'document'
  caption?: string | null
  currentUserId?: string | null
}

export interface SendSingleAttachmentResult {
  messageId: string
  attachmentId: string
}

/**
 * Per-file optimistic attachment send (Slice B).
 *
 * 1. File validation (size, MIME, 0-byte) — throws before any bubble appears.
 * 2. Offline check — throws before any bubble appears.
 * 3. RBAC + moderation guards.
 * 4. Optimistic insert → bubble visible immediately with pending state.
 * 5. IDB cache → blob survives app-kill for retry.
 * 6. Upload with 3× auto-retry (1s/2s/4s backoff, silent).
 * 7. Atomic RPC — inserts chat_messages + chat_attachments.
 * 8. Success → IDB cleared. Realtime echo replaces optimistic row.
 * 9. Failure → failOptimisticMessage (red bubble), IDB kept for retry.
 */
export async function sendSingleAttachmentOptimisticWorkflow(
  input: SendSingleAttachmentInput,
): Promise<SendSingleAttachmentResult> {
  // 1. File validation — before optimistic insert so no bubble for bad files.
  validateAttachmentFile(input.file, input.kind)

  // No pre-insert offline throw: offline is a queued success (bubble stays
  // pending, drain-worker sends on reconnect).
  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError('worker_in_customer_channel', 'Workers cannot send in customer channels')
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError('customer_in_internal_channel', 'Customers cannot send in internal channels')
  }
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.caption ?? undefined, input.currentUserId ?? null)
  }

  // 3. Build optimistic attachment metadata from local File.
  const assetType = assetTypeForMime(input.file.type) === 'voice' ? 'document' : assetTypeForMime(input.file.type)
  const localBlobUrl = assetType === 'image' ? URL.createObjectURL(input.file) : undefined
  const optimisticAttachment: ChatAttachment = {
    id: `temp_att_${input.clientMessageId}`,
    messageId: `temp_${input.clientMessageId}`,
    assetType,
    mimeType: input.file.type,
    sizeBytes: input.file.size,
    storageBucket: bucketForChannel(thread.channelType),
    storagePath: '',
    width: null,
    height: null,
    durationMs: null,
    posterStoragePath: null,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: Date.now(),
    deletedAt: null,
    localBlobUrl,
    fileName: input.file.name,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
  }

  const messageType = assetType === 'image' ? 'image' : 'document'

  // 4. Optimistic insert — bubble appears immediately.
  repo.insertOptimisticMessage({
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    messageType,
    body: input.caption ?? null,
    attachments: [optimisticAttachment],
  })

  // 5. IDB cache — best-effort, survives app-kill. The drain-worker reads it.
  void cacheAttachment({
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    blobData: input.file,
    fileName: input.file.name,
    mimeType: input.file.type,
    sizeBytes: input.file.size,
    kind: input.kind === 'photo' ? 'image' : 'document',
    caption: input.caption ?? null,
    createdAt: Date.now(),
  })

  // 6. Persist to the media outbox + run the initial send via the shared
  //    engine (upload → RPC → outcome). Offline / transient ⇒ ChatSendQueuedError.
  const record: MediaOutboxRecord = {
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    providerId: thread.providerId ?? null,
    kind: input.kind === 'photo' ? 'image' : 'document',
    fileName: input.file.name,
    mimeType: input.file.type,
    storagePath: '',
    metadata: { caption: input.caption ?? null },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }

  const result = await enqueueAndSendMedia(record, { blob: input.file })
  return {
    messageId: result.messageId ?? '',
    attachmentId: result.attachmentIds?.[0] ?? '',
  }
}

/**
 * Retry a previously failed attachment send.
 * Resets the failed bubble to pending, re-uploads from IDB blob, re-runs RPC.
 */
export async function retryFailedAttachmentWorkflow(input: {
  threadId: string
  clientMessageId: string
  callerRole: ChatRole
  file: File
  kind: 'photo' | 'document'
  caption?: string | null
  currentUserId?: string | null
}): Promise<SendSingleAttachmentResult> {
  // Offline check before retry.
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new OfflineError()
  }

  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)

  // Same channel-RBAC + block/content checks as the initial send — a retry
  // must not bypass guards that may have become relevant since the first
  // attempt (expired subscription, new block, etc.).
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError('worker_in_customer_channel', 'Workers cannot send in customer channels')
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError('customer_in_internal_channel', 'Customers cannot send in internal channels')
  }
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.caption ?? undefined, input.currentUserId ?? null)
  }

  // Reset failed bubble back to pending + requeue the (possibly 'failed')
  // outbox record, then run the shared engine with the in-memory blob.
  repo.resetOptimisticToPending(input.threadId, input.clientMessageId)
  await mediaOutbox.requeue(input.clientMessageId)

  const existing = await mediaOutbox.get(input.clientMessageId)
  const record: MediaOutboxRecord = existing ?? {
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    providerId: thread.providerId ?? null,
    kind: input.kind === 'photo' ? 'image' : 'document',
    fileName: input.file.name,
    mimeType: input.file.type,
    storagePath: '',
    metadata: { caption: input.caption ?? null },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }
  if (!existing) await mediaOutbox.enqueue(record)

  const result = await performMediaSendAttempt(record, { blob: input.file })
  if (result.outcome === 'sent' || result.outcome === 'already-sent') {
    return {
      messageId: result.messageId ?? '',
      attachmentId: result.attachmentIds?.[0] ?? '',
    }
  }
  if (result.outcome === 'transient' || result.outcome === 'in-flight') {
    throw new ChatSendQueuedError(record.kind)
  }
  throw new ChatUploadError(result.error ?? new Error('attachment retry failed'))
}

// ── Slice 4: Video message send ───────────────────────────────────────────

const VIDEO_MAX_DURATION_MS = 60_000
const VIDEO_MAX_SIZE_BYTES = 100 * 1024 * 1024 // 100 MB

export interface SendVideoMessageInput {
  threadId: string
  clientMessageId: string
  callerRole: ChatRole
  videoBlob: Blob
  mimeType: string
  fileExtension: string
  /** From probe before the workflow — enforces the 60-second limit. */
  durationMs: number
  /** Intrinsic video dimensions from the probe — drive the bubble aspect ratio. */
  width?: number | null
  height?: number | null
  /** Pre-extracted poster from VideoComposerSheet — used as localBlobUrl in pending bubble
   *  and passed to the uploader to avoid double-extraction. */
  posterFile: File | null
  caption?: string | null
  currentUserId?: string | null
  /** Called with 0–100 during the storage upload. Drives the progress ring in the bubble. */
  onProgress?: (pct: number) => void
}

export interface SendVideoMessageResult {
  messageId: string
  attachmentId: string
}

/**
 * RBAC-guarded video send with optimistic bubble and upload-progress.
 *
 * 1. Validation: size (100 MB max), duration (60 s max), MIME (video/*).
 * 2. Offline check.
 * 3. RBAC + moderation guards.
 * 4. Optimistic insert — video bubble visible immediately with pending state
 *    showing the pre-extracted poster as localBlobUrl.
 * 5. IDB cache — blob survives app-kill for retry.
 * 6. Upload with 3× auto-retry + real XHR progress (fires onProgress).
 * 7. Atomic RPC.
 * 8. Success → IDB cleared. Realtime echo replaces optimistic row.
 * 9. Failure → failOptimisticMessage (red bubble), IDB kept for retry.
 */
export async function sendVideoMessageWorkflow(
  input: SendVideoMessageInput,
): Promise<SendVideoMessageResult> {
  // 1. Validation — before optimistic insert so no bubble for bad files.
  if (input.videoBlob.size === 0) {
    throw new ChatFileValidationError('Video ist leer — bitte ein anderes Video wählen.')
  }
  if (input.videoBlob.size > VIDEO_MAX_SIZE_BYTES) {
    throw new ChatFileValidationError(
      `Video zu groß (max. 100 MB). Dieses Video hat ${(input.videoBlob.size / 1024 / 1024).toFixed(1)} MB.`,
    )
  }
  if (!input.mimeType.startsWith('video/')) {
    throw new ChatFileValidationError(`Ungültiger Dateityp: ${input.mimeType}`)
  }
  // Enforce the 60s limit only when the duration is actually known. A probe
  // that could not read the length (durationMs <= 0) must NOT block a legit
  // clip — the 100 MB size cap is the real bound; wrongly rejecting an
  // un-probeable-but-valid video is a false fallback.
  if (input.durationMs > VIDEO_MAX_DURATION_MS) {
    throw new ChatFileValidationError(
      `Video zu lang (max. 60 Sekunden). Dieses Video ist ${Math.round(input.durationMs / 1000)} Sekunden.`,
    )
  }

  // No pre-insert offline throw: offline is a queued success (bubble pending).
  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError('worker_in_customer_channel', 'Workers cannot send in customer channels')
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError('customer_in_internal_channel', 'Customers cannot send in internal channels')
  }
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.caption ?? undefined, input.currentUserId ?? null)
  }

  // 3. Build optimistic attachment. `localBlobUrl` = poster object URL so
  // the pending bubble shows a thumbnail immediately.
  const posterObjectUrl = input.posterFile ? URL.createObjectURL(input.posterFile) : null
  const optimisticAttachment: ChatAttachment = {
    id: `temp_att_${input.clientMessageId}`,
    messageId: `temp_${input.clientMessageId}`,
    assetType: 'video',
    mimeType: input.mimeType,
    sizeBytes: input.videoBlob.size,
    storageBucket: bucketForChannel(thread.channelType),
    storagePath: '',
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    posterStoragePath: null,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: Date.now(),
    deletedAt: null,
    localBlobUrl: posterObjectUrl ?? undefined,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
  }

  repo.insertOptimisticMessage({
    threadId: input.threadId,
    clientMessageId: input.clientMessageId,
    messageType: 'video',
    body: input.caption ?? null,
    attachments: [optimisticAttachment],
  })

  // 4. IDB cache — best-effort, survives app-kill. The drain-worker reads it.
  void cacheAttachment({
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    blobData: input.videoBlob,
    fileName: `video-${input.clientMessageId}.${input.fileExtension}`,
    mimeType: input.mimeType,
    sizeBytes: input.videoBlob.size,
    kind: 'video',
    durationMs: input.durationMs,
    caption: input.caption ?? null,
    createdAt: Date.now(),
  })

  const record: MediaOutboxRecord = {
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    providerId: thread.providerId ?? null,
    kind: 'video',
    fileName: `video-${input.clientMessageId}.${input.fileExtension}`,
    mimeType: input.mimeType,
    storagePath: '',
    metadata: {
      caption: input.caption ?? null,
      durationMs: input.durationMs,
      width: input.width ?? null,
      height: input.height ?? null,
      fileExtension: input.fileExtension,
    },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }

  const result = await enqueueAndSendMedia(record, {
    blob: input.videoBlob,
    posterFile: input.posterFile,
    onProgress: input.onProgress,
  })
  return {
    messageId: result.messageId ?? '',
    attachmentId: result.attachmentIds?.[0] ?? '',
  }
}

/**
 * Retry a previously failed video send.
 * Resets the failed bubble to pending, re-uploads from IDB blob, re-runs RPC.
 */
export async function retryFailedVideoWorkflow(input: {
  threadId: string
  clientMessageId: string
  callerRole: ChatRole
  videoBlob: Blob
  mimeType: string
  fileExtension: string
  durationMs: number
  caption?: string | null
  currentUserId?: string | null
  onProgress?: (pct: number) => void
}): Promise<SendVideoMessageResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new OfflineError()
  }

  const repo = getChatRepository()
  const thread = await resolveThreadOrSeed(repo, input.threadId)
  if (input.callerRole === 'worker' && thread.channelType === 'customer') {
    throw new ChatRBACError('worker_in_customer_channel', 'Workers cannot send in customer channels')
  }
  if (input.callerRole === 'customer' && isInternalChannel(thread.channelType)) {
    throw new ChatRBACError('customer_in_internal_channel', 'Customers cannot send in internal channels')
  }
  if (thread.channelType === 'customer' || thread.channelType === 'direct') {
    await enforceBlockAndContentChecks(thread, input.caption ?? undefined, input.currentUserId ?? null)
  }

  repo.resetOptimisticToPending(input.threadId, input.clientMessageId)
  await mediaOutbox.requeue(input.clientMessageId)

  const existing = await mediaOutbox.get(input.clientMessageId)
  const record: MediaOutboxRecord = existing ?? {
    clientMessageId: input.clientMessageId,
    threadId: input.threadId,
    channelType: thread.channelType,
    providerId: thread.providerId ?? null,
    kind: 'video',
    fileName: `video-${input.clientMessageId}.${input.fileExtension}`,
    mimeType: input.mimeType,
    storagePath: '',
    metadata: {
      caption: input.caption ?? null,
      durationMs: input.durationMs,
      fileExtension: input.fileExtension,
    },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }
  if (!existing) await mediaOutbox.enqueue(record)

  const result = await performMediaSendAttempt(record, {
    blob: input.videoBlob,
    onProgress: input.onProgress,
  })
  if (result.outcome === 'sent' || result.outcome === 'already-sent') {
    return {
      messageId: result.messageId ?? '',
      attachmentId: result.attachmentIds?.[0] ?? '',
    }
  }
  if (result.outcome === 'transient' || result.outcome === 'in-flight') {
    throw new ChatSendQueuedError('video')
  }
  throw new ChatUploadError(result.error ?? new Error('video retry failed'))
}

/**
 * Retry a previously failed text send. Uses the same clientMessageId so the
 * repository resets the existing failed optimistic row to 'pending' instead
 * of appending a duplicate bubble.
 */
export async function retryFailedTextWorkflow(input: {
  threadId: string
  body: string
  clientMessageId: string
  callerRole: ChatRole
  currentUserId?: string | null
}): Promise<ChatMessageViewModel> {
  return sendMessageWorkflow({
    threadId: input.threadId,
    body: input.body,
    clientMessageId: input.clientMessageId,
    callerRole: input.callerRole,
    currentUserId: input.currentUserId,
  })
}

/**
 * Discard a failed text send. Removes the failed optimistic bubble and frees
 * tracking state. No-op if the row is no longer in cache.
 */
export function discardFailedTextWorkflow(threadId: string, clientMessageId: string): void {
  getChatRepository().discardOptimisticMessage(threadId, clientMessageId)
}

/**
 * Discard a failed attachment send (image / document). Mirror of
 * discardFailedTextWorkflow — screens never call the repository directly
 * (layer rule); the IDB-cache purge stays in the screen because the cache
 * is a UI-surface concern (retry affordance), not repository state.
 */
export function discardFailedAttachmentWorkflow(threadId: string, clientMessageId: string): void {
  getChatRepository().discardOptimisticMessage(threadId, clientMessageId)
}

/**
 * Discard a failed video send. Mirror of discardFailedTextWorkflow for the
 * video bubble surface.
 */
export function discardFailedVideoWorkflow(threadId: string, clientMessageId: string): void {
  getChatRepository().discardOptimisticMessage(threadId, clientMessageId)
}

/**
 * Unified discard for a failed MEDIA send (voice / photo / document / video):
 * removes the optimistic bubble, purges the outbox record + both blob caches,
 * and best-effort removes any already-uploaded orphan blob from storage. Use
 * this from every failed-media surface — it is the durable-state-aware discard
 * (the older discardFailedAttachment/Video workflows only touch the bubble).
 */
export async function discardFailedMediaMessage(
  threadId: string,
  clientMessageId: string,
): Promise<void> {
  getChatRepository().discardOptimisticMessage(threadId, clientMessageId)
  const record = await mediaOutbox.get(clientMessageId)
  // Cancel any scheduled backoff retry for this record.
  const timer = backoffTimers.get(clientMessageId)
  if (timer) {
    clearTimeout(timer)
    backoffTimers.delete(clientMessageId)
  }
  await mediaOutbox.remove(clientMessageId)
  await Promise.all([
    clearVoiceRecording(clientMessageId),
    clearCachedAttachment(clientMessageId),
  ])
  if (record?.storagePath) {
    void cleanupOrphanAttachmentBlobs([
      {
        assetType: record.kind,
        mimeType: record.mimeType,
        sizeBytes: 0,
        storageBucket: bucketForChannel(record.channelType),
        storagePath: record.storagePath,
        width: record.metadata.width ?? null,
        height: record.metadata.height ?? null,
        durationMs: record.metadata.durationMs ?? null,
        posterStoragePath: record.metadata.posterStoragePath ?? null,
      },
    ])
  }
}

export type DeleteChatMessageResult =
  | { ok: true }
  | { ok: false; reason: 'window_expired' | 'not_allowed' | 'failed' }

/**
 * Delete a chat message (Block 3).
 *  - 'self' hides it for the current user only.
 *  - 'all'  is a sender-only 15-minute unsend: the row is redacted (tombstone)
 *           for everyone and its attachment blobs are cleaned from storage.
 *
 * Authorization (sender + window + participant) is enforced authoritatively by
 * the SECDEF rpc_delete_chat_message — the UI only offers 'all' when allowed,
 * and this workflow maps the RPC's errcodes to a user-facing reason. Storage
 * cleanup is best-effort: it runs only after the redact already committed.
 */
export async function deleteChatMessageWorkflow(
  message: ChatMessageViewModel,
  mode: ChatDeleteMode,
): Promise<DeleteChatMessageResult> {
  // Snapshot the blobs BEFORE the redact (mode 'all' drops attachments).
  const blobs: ChatAttachmentBlob[] =
    mode === 'all'
      ? (message.attachments ?? [])
          .filter((a) => a.storagePath)
          .map((a) => ({
            assetType: a.assetType,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            storageBucket: a.storageBucket,
            storagePath: a.storagePath,
            width: a.width ?? null,
            height: a.height ?? null,
            durationMs: a.durationMs ?? null,
            posterStoragePath: a.posterStoragePath ?? null,
          }))
      : []

  try {
    await getChatRepository().deleteMessage(message.id, mode)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logError('chat.workflow.delete_message_failed', err, { messageId: message.id, mode })
    if (detail.includes('unsend_window_expired')) return { ok: false, reason: 'window_expired' }
    if (
      detail.includes('not_sender') ||
      detail.includes('not_a_participant') ||
      detail.includes('not_authenticated')
    ) {
      return { ok: false, reason: 'not_allowed' }
    }
    return { ok: false, reason: 'failed' }
  }

  if (mode === 'all' && blobs.length > 0) {
    void cleanupOrphanAttachmentBlobs(blobs)
  }
  return { ok: true }
}
