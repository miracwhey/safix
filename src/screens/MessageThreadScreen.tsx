/**
 * MessageThreadScreen — RUN 2 CLEAN REBUILD + PROJECT ATTACH RESTORE
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Business-card rendering has been rebuilt on top of the canonical
 * thread_artifacts model.  Cards render ONLY from persisted artifact
 * records — no legacy conversation metadata inference, no message
 * attachment scanning, no old mixed selector logic.
 *
 * RENDERS:
 *   - Thread identity (conversation header)
 *   - Artifact cards (project, offer/payment, funding, change-order) inline in
 *     the stream via ChatArtifactCardCompact (persistent top-cards removed 2026-06-23)
 *   - Plain text messages
 *   - Text message input
 *   - Project attach entry (customer only) via ProjectPickerSheet
 *   - Craftsman action entry (craftsman only) via CraftsmanActionSheet
 *   - Quote/Kostenvoranschlag creation (craftsman only) via QuoteCreationSheet
 *   - Inline quote-send event cards (both roles) via QuoteSendEventCard
 *   - Participant scoping (via message repository)
 *   - markRequestReviewedWorkflow (inbox management, not rendering)
 *
 * DATA SOURCES:
 *   - getMessageThreadById / subscribeMessages  → thread + messages
 *   - getThreadArtifacts / subscribeThreadArtifacts → canonical artifact cards
 *   - getProjects / subscribeProjects → customer project list for attach entry
 *
 * The project attach entry uses ONLY the canonical write path
 * (sendProjectAttachmentWorkflow → persistProjectArtifact → thread_artifacts).
 * No old business-card selectors, components, or subscriptions are used.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import Avatar from '../components/messages/Avatar'
import ProjectPickerSheet from '../components/messages/ProjectPickerSheet'
import ProjectSendEventCard from '../components/messages/ProjectSendEventCard'
import QuoteCreationSheet, { type QuoteComposerContext } from '../components/messages/QuoteCreationSheet'
import type { OfferDocumentType } from '../lib/offers/types'
import QuoteSendEventCard from '../components/messages/QuoteSendEventCard'
import ThreadArtifactFundingCard from '../components/messages/ThreadArtifactFundingCard'
import ThreadPaymentStatusCard from '../components/messages/ThreadPaymentStatusCard'
import ChatModerationMenu from '../components/moderation/ChatModerationMenu'
import { useProActionGate } from '../components/subscription/useProActionGate'
import { resolveAllActiveWorkContexts } from '../lib/subscription/activeWorkContext'
import InlineFeedback from '../components/system/InlineFeedback'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import CorridorNotFound from '../components/system/CorridorNotFound'
import { useSubscription } from '../hooks/useSubscription'
import { useToast } from '../hooks/useToast'
import {
  getMessageThreadById,
  getThreadHeader,
  getThreadArtifacts,
  getConversationById,
  subscribeMessages,
  subscribeThreadArtifacts,
  resolveCanonicalThreadId,
  isMessageRepositoryHydrated,
  type MessageRole,
  type MessageThread,
  type ThreadArtifacts,
  type ProjectArtifact,
  type OfferPaymentArtifact,
  type FundingStepArtifact,
} from '../lib/messages'
import { subscribeJobs } from '../lib/jobs'
import { getEscrowPlanRepository } from '../lib/payments/escrow'
import { resolveMoneyFlowProjection } from '../lib/payments/moneyFlowProjection'
import { subscribeTimeline } from '../lib/timeline'
import { getOfferById } from '../lib/offers'
import { formatMessageTimeLabel } from '../lib/messages/dateUtils'
import { getProjects, subscribeProjects, type Project } from '../lib/projects'
import {
  sendProjectAttachmentWorkflow,
  setActiveThreadProjectWorkflow,
  markRequestReviewedWorkflow,
} from '../lib/workflow'
import {
  useChatHydrated,
  useChatMessages,
  useChatThread,
  useChatConnectionState,
  getChatRepository,
  type ChatRole,
  type ChatThreadViewModel,
  type ChatMessageViewModel,
} from '../lib/chat'
import { ChannelBadge } from '../components/chat'
import { getOrCreateChatCustomerThread } from '../lib/chat/service'
import { classifyChatSendError } from '../lib/chat/errors'
import {
  sendMessageWorkflow,
  retryFailedTextWorkflow,
  discardFailedTextWorkflow,
  discardFailedMediaMessage,
  markThreadReadWorkflow,
  sendVoiceNoteWorkflow,
  sendSingleAttachmentOptimisticWorkflow,
  retryFailedAttachmentWorkflow,
  sendVideoMessageWorkflow,
  retryFailedVideoWorkflow,
  deleteChatMessageWorkflow,
  ChatFileValidationError,
  ChatSendQueuedError,
  OfflineError,
  ChatUploadError,
} from '../lib/workflow/chatWorkflow'
import { subscribeSession, getSession as getCurrentSession } from '../lib/session'
import { ChatArtifactCardCompact, ChatBubble, ChatComposer } from '../components/chat'
import { ChatConnectionBanner } from '../components/chat'
import { V5ChatBackdrop } from '../components/chat/V5ChatBackdrop'
import { VoiceMessageBubble } from '../components/chat/VoiceMessageBubble'
import { BubbleTail } from '../components/chat/BubbleTail'
import {
  MessageActionSheet,
  MessageTombstone,
  LongPressBubble,
  UNSEND_WINDOW_MS,
} from '../components/chat/MessageActionSheet'
import { ImageMessageBubble } from '../components/chat/ImageMessageBubble'
import { DocumentMessageBubble } from '../components/chat/DocumentMessageBubble'
import { VideoMessageBubble } from '../components/chat/VideoMessageBubble'
import { VideoComposerSheet } from '../components/chat/VideoComposerSheet'
import type { VideoReadyPayload } from '../components/chat/VideoComposerSheet'
import {
  cacheVoiceRecording,
  clearVoiceRecording,
  readVoiceRecording,
  sweepStaleVoiceRecordings,
} from '../lib/chat/voice/recordingCache'
import { getCachedAttachment } from '../lib/chat/attachmentPendingCache'
import { releaseVoicePlayer } from '../hooks/useVoicePlayer'
import { useThreadAutoScroll } from '../hooks/useThreadAutoScroll'
import { useKeyboardInset } from '../hooks/useKeyboardInset'
import { useImmersiveStatusBar } from '../hooks/useImmersiveStatusBar'
import type { VoiceRecording } from '../lib/chat/voice/types'
import type { ComposerTileKind } from '../components/chat/composerTiles'

type Props = {
  role?: MessageRole
  backPath?: string
}

/**
 * Build a ThreadHeader-shaped object from a chat-domain thread when the
 * legacy thread is absent (chat-only-future-case, e.g. push-deeplink to a
 * chat_threads.id with no legacy mapping). Mirrors the role-aware mapping
 * `getThreadHeader` applies, but sources the fields from
 * `ChatThreadDisplayMetadata` (denormalised by the repo).
 */
function buildHeaderFromChatThread(
  chatThread: ChatThreadViewModel,
  role: MessageRole,
  currentUserId: string | null,
) {
  const meta = chatThread.displayMetadata ?? {}
  // Direct 1:1 chat: the header is the OTHER peer (from display_metadata.peers),
  // with no job/project context.
  if (chatThread.channelType === 'direct') {
    const peers = meta.peers ?? {}
    const otherId = Object.keys(peers).find((id) => id !== currentUserId)
    const peer = otherId ? peers[otherId] : undefined
    const name = peer?.displayName || (peer?.handle ? `@${peer.handle}` : 'Direktnachricht')
    return {
      avatarUrl: '',
      primaryName: name,
      secondaryLine: peer?.handle ? `@${peer.handle}` : '',
      helperLine: '',
      craftsmanUserId: undefined,
      customerUserId: undefined,
    }
  }
  if (role === 'craftsman') {
    return {
      avatarUrl: meta.customerAvatarUrl ?? '',
      primaryName: meta.customerName ?? 'Kunde',
      secondaryLine: meta.projectTitle ?? meta.projectSubtitle ?? '',
      helperLine: meta.projectLocation ?? '',
      craftsmanUserId: chatThread.craftsmanUserId ?? undefined,
      customerUserId: chatThread.customerUserId ?? undefined,
    }
  }
  return {
    avatarUrl: meta.craftsmanAvatarUrl ?? '',
    primaryName: meta.craftsmanName ?? 'Handwerker',
    secondaryLine: meta.projectTitle ?? meta.projectSubtitle ?? '',
    helperLine: meta.projectLocation ?? '',
    craftsmanUserId: chatThread.craftsmanUserId ?? undefined,
    customerUserId: chatThread.customerUserId ?? undefined,
  }
}

/**
 * Resolve the thread-neutral composer context for the commercial document
 * composer (Cutover Slice-2). Dual-path lookup mirroring
 * `convertInquiryToProjectWorkflow`: try the legacy conversation first, then
 * fall back to the chat-domain thread. Returns undefined only when neither
 * domain knows the thread — the composer guard treats that as "not available".
 *
 * `conversationId` is the canonical thread id the offer is keyed to: a legacy
 * `conversations.id` for migrated threads, or a `chat_threads.id` for cutover
 * inquiry threads (which have no legacy conversation row).
 */
function buildQuoteContext(
  threadId: string,
  chatThread: ChatThreadViewModel | undefined,
): QuoteComposerContext | undefined {
  const legacy = getConversationById(threadId)
  if (legacy) {
    return {
      conversationId: legacy.id,
      craftsmanUserId: legacy.craftsmanUserId,
      customerUserId: legacy.customerUserId,
      projectTitle: legacy.projectTitle,
      projectLocation: legacy.projectLocation,
      projectDescription: legacy.projectDescription,
      craftsmanName: legacy.craftsmanName,
    }
  }
  if (chatThread) {
    const meta = chatThread.displayMetadata ?? {}
    return {
      conversationId: chatThread.id,
      craftsmanUserId: chatThread.craftsmanUserId ?? undefined,
      customerUserId: chatThread.customerUserId ?? undefined,
      projectTitle: meta.projectTitle ?? chatThread.title ?? undefined,
      projectLocation: meta.projectLocation ?? undefined,
      projectDescription: meta.projectDescription ?? undefined,
      craftsmanName: meta.craftsmanName ?? undefined,
    }
  }
  return undefined
}

/**
 * Workflow progression order for timeline entries.  When entries share
 * the same timestamp, this tiebreaker ensures the more advanced workflow
 * step appears after the earlier one (e.g., funding_step after quote_send).
 */
const TIMELINE_WORKFLOW_ORDER: Record<string, number> = {
  project_send: 0,
  message: 1,
  chat_message: 1,
  // chat_artifact_card carries the workflow rank in the chat-domain replacement
  // for project_send/quote_send/funding_step. Land it after message bubbles on
  // tie so the action surface (compact card) sits below a co-timestamped text.
  chat_artifact_card: 2,
  quote_send: 2,
  funding_step: 3,
}

/**
 * Resume robustness (P1): maximum age of the synchronous send-lock before
 * it is treated as free again. If a send-fetch never settles (iOS WebKit
 * can drop in-flight requests on app suspension without ever rejecting),
 * the finally-release never runs and a boolean lock would block ALL further
 * text/voice sends until remount. Chosen ABOVE the repository-side 15s send
 * timeout so that timeout (which settles the promise and releases the lock
 * via finally) wins in the normal case — this is only the screen-side
 * backstop. Mirrors the same constant in ChatComposer.
 */
const SEND_LOCK_MAX_MS = 20_000

// Non-text message types that carry attachments (no text body). They must be
// projected into the timeline so their media render branches are reachable.
const MEDIA_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'voice',
  'image',
  'document',
  'video',
  'mixed',
])

/**
 * Cheap render-relevant signature of the legacy message thread. Used by the
 * global-notify refresh to skip setThread when nothing this surface renders has
 * actually changed. Covers thread presence plus every field that getThreadHeader,
 * the blocked banner, and the payment-strip gate read, plus a last-message
 * summary. `project` is a small nested object so stringifying it is cheap and
 * catches title/status/location changes.
 */
function threadSignature(thread: MessageThread | undefined): string {
  if (!thread) return 'none'
  const last = thread.messages[thread.messages.length - 1]
  return JSON.stringify({
    id: thread.id,
    customerName: thread.customerName,
    customerAvatarUrl: thread.customerAvatarUrl,
    customerUserId: thread.customerUserId,
    craftsmanName: thread.craftsmanName,
    craftsmanHandle: thread.craftsmanHandle,
    craftsmanAvatarUrl: thread.craftsmanAvatarUrl,
    craftsmanUserId: thread.craftsmanUserId,
    project: thread.project,
    lastMessagePreview: thread.lastMessagePreview,
    timeLabel: thread.timeLabel,
    unreadCount: thread.unreadCount,
    isBlocked: thread.isBlocked ?? false,
    messageCount: thread.messages.length,
    lastMessageId: last?.id ?? '',
    lastMessageText: last?.text ?? '',
    lastMessageLabel: last?.createdAtLabel ?? '',
  })
}

/**
 * Cheap render-relevant signature of the thread artifacts. Used by the
 * global-notify refresh to skip setArtifacts when nothing this surface renders
 * has actually changed. Per artifact it captures: id, lifecycle phase/status,
 * persistence status (so a null→loaded entity upgrade is caught), the backing
 * entity-id presence, createdAt, and the snapshot fields the cards render — plus
 * the reconciliation/pending booleans. Errs toward over-capture so a real add,
 * status-change, or entity upgrade always re-renders the timeline.
 */
function artifactSignature(a: ThreadArtifacts): string {
  const proj = a.projectArtifacts
    .map(
      (p) =>
        `${p.artifactId}:${p.createdAt}:${p.isActiveProject ? 1 : 0}:${p.persistenceStatus}:${p.project?.id ?? ''}:${p.snapshot?.status ?? ''}:${p.snapshot?.title ?? ''}:${p.snapshot?.category ?? ''}:${p.snapshot?.location ?? ''}`
    )
    .join(',')
  const offer = a.offerPaymentArtifact
    ? `${a.offerPaymentArtifact.phase}:${a.offerPaymentArtifact.jobId ?? ''}:${a.offerPaymentArtifact.paymentState ?? ''}:${a.offerPaymentArtifact.persistenceStatus}:${a.offerPaymentArtifact.offer?.id ?? ''}:${a.offerPaymentArtifact.offer?.status ?? ''}:${a.offerPaymentArtifact.createdAt}:${a.offerPaymentArtifact.documentType}:${a.offerPaymentArtifact.snapshot?.phaseLabel ?? ''}`
    : ''
  const funding = a.fundingStepArtifact
    ? `${a.fundingStepArtifact.phase}:${a.fundingStepArtifact.fundingRequestId}:${a.fundingStepArtifact.jobId}:${a.fundingStepArtifact.persistenceStatus}:${a.fundingStepArtifact.createdAt}:${a.fundingStepArtifact.amount}`
    : ''
  const co = a.changeOrderArtifacts
    .map(
      (c) =>
        `${c.artifactId}:${c.status}:${c.persistenceStatus}:${c.changeOrder?.id ?? ''}:${c.createdAt}`
    )
    .join(',')
  const inv = a.invoiceArtifacts
    .map(
      (i) =>
        `${i.artifactId}:${i.status}:${i.persistenceStatus}:${i.invoice?.id ?? ''}:${i.createdAt}`
    )
    .join(',')
  return `${proj}|${offer}|${funding}|${co}|${inv}|${a.offerFundingSuperseded ? 1 : 0}|${a.pendingProjectArtifact ? 1 : 0}|${a.pendingOfferArtifact ? 1 : 0}|${a.pendingFundingArtifact ? 1 : 0}`
}

export default function MessageThreadScreen({
  role = 'customer',
  backPath = '/messages',
}: Props) {
  const { threadId } = useParams<{ threadId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const backPathParam = searchParams.get('backPath')
  const effectiveBackPath = backPathParam ?? backPath
  const goBack = useSmartBack(effectiveBackPath)
  const toast = useToast()
  const subscription = useSubscription()
  const [thread, setThread] = useState<MessageThread | undefined>(
    threadId ? getMessageThreadById(threadId) : undefined
  )
  const [artifacts, setArtifacts] = useState<ThreadArtifacts>(
    threadId
      ? getThreadArtifacts(threadId)
      : {
          projectArtifacts: [],
          projectArtifact: null,
          offerPaymentArtifact: null,
          fundingStepArtifact: null,
          changeOrderArtifacts: [],
          invoiceArtifacts: [],
          offerFundingSuperseded: false,
          pendingProjectArtifact: false,
          pendingOfferArtifact: false,
          pendingFundingArtifact: false,
        }
  )
  // Deterministic loaded decision (same pattern as other corridor screens):
  //   - thread found → loaded
  //   - thread not found AND repo hydrated → loaded (will show not-found)
  //   - thread not found AND repo NOT hydrated → stay loading
  const [loaded, setLoaded] = useState(() => {
    if (thread) return true
    return isMessageRepositoryHydrated()
  })

  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  // Block 3 — message-delete sheet target + in-flight/error state.
  const [deleteTarget, setDeleteTarget] = useState<{
    message: ChatMessageViewModel
    canDeleteForAll: boolean
  } | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleDeletePick = async (mode: 'self' | 'all') => {
    if (!deleteTarget || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    const res = await deleteChatMessageWorkflow(deleteTarget.message, mode)
    setDeleteBusy(false)
    if (res.ok) {
      setDeleteTarget(null)
      return
    }
    if (res.reason === 'window_expired') {
      // Window lapsed between long-press and tap: drop the "Für alle" option so
      // it can't be re-tapped into the same error; "Für mich" stays available.
      setDeleteTarget((t) => (t ? { ...t, canDeleteForAll: false } : t))
    }
    setDeleteError(
      res.reason === 'window_expired'
        ? 'Das 15-Minuten-Fenster zum Löschen für alle ist abgelaufen.'
        : res.reason === 'not_allowed'
          ? 'Diese Nachricht kann nicht gelöscht werden.'
          : 'Löschen fehlgeschlagen. Bitte erneut versuchen.',
    )
  }
  // documentType drives which composer variant opens — set by CraftsmanActionSheet
  const [composerDocumentType, setComposerDocumentType] = useState<OfferDocumentType>('binding_offer')
  // Paket 4d: pre-fill state for follow-up offers created from a diagnosis
  const [composerSourceDiagnosisId, setComposerSourceDiagnosisId] = useState<string | undefined>()
  const [composerSourceDiagnosisRef, setComposerSourceDiagnosisRef] = useState<string | undefined>()
  const [composerInitialScopeSummary, setComposerInitialScopeSummary] = useState<string | undefined>()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectSendError, setProjectSendError] = useState<string | null>(null)
  const isAttachingProjectRef = useRef(false)

  // Reactivity counter: bumped when job or escrow data changes so that
  // sendMessageJobContext (below) re-evaluates the AWE gate decision.
  const [workContextVersion, setWorkContextVersion] = useState(0)

  useEffect(() => {
    const bump = () => setWorkContextVersion((v) => v + 1)
    // Timeline: payout-outcome signals drive ThreadPaymentStatusCard's
    // payoutStatus (both roles). Subscribed unconditionally so a realtime
    // `payout_completed` / `payout_failed` insert rerenders the thread
    // strip without a manual refresh.
    const unsubTimeline = subscribeTimeline(bump)
    if (role !== 'craftsman') {
      return () => { unsubTimeline() }
    }
    const unsubJobs = subscribeJobs(bump)
    const unsubEscrow = getEscrowPlanRepository().subscribe(bump)
    return () => { unsubJobs(); unsubEscrow(); unsubTimeline() }
  }, [role])

  // Last render-relevant signatures pushed to thread/artifacts state. The
  // refresh below is wired to subscribeMessages / subscribeThreadArtifacts,
  // which fire on ANY thread mutation app-wide; this ref lets it skip the
  // setState (and the re-render it triggers) when THIS thread's signature is
  // unchanged. Updated only when state is actually committed, so manual
  // refreshes elsewhere can never cause a stale skip — they only ever cost one
  // harmless redundant commit on the next notify.
  const prevSyncSigRef = useRef<{ thread: string; artifacts: string }>({
    thread: '',
    artifacts: '',
  })

  useEffect(() => {
    if (!threadId) return

    // Mark the request as reviewed when the craftsman opens the thread
    if (role === 'craftsman') {
      markRequestReviewedWorkflow(threadId)
    }

    const refresh = () => {
      const found = getMessageThreadById(threadId)
      const nextArtifacts = getThreadArtifacts(threadId)
      // Ref-stability guard: getMessageThreadById / getThreadArtifacts return
      // FRESH objects every call, so an unguarded setThread/setArtifacts churned
      // the refs on every global-store notify → re-render → the memoized timeline
      // rebuilt for the open thread on every chat message anywhere. Only commit
      // when THIS thread's render-relevant signature actually changed.
      const nextThreadSig = threadSignature(found)
      const nextArtifactsSig = artifactSignature(nextArtifacts)
      if (nextThreadSig !== prevSyncSigRef.current.thread) {
        setThread(found)
        prevSyncSigRef.current.thread = nextThreadSig
      }
      if (nextArtifactsSig !== prevSyncSigRef.current.artifacts) {
        setArtifacts(nextArtifacts)
        prevSyncSigRef.current.artifacts = nextArtifactsSig
      }
      if (found || isMessageRepositoryHydrated()) {
        setLoaded(true)
      }
    }

    refresh()

    const unsubMessages = subscribeMessages(refresh)
    const unsubArtifacts = subscribeThreadArtifacts(refresh)

    return () => {
      unsubMessages()
      unsubArtifacts()
    }
  }, [threadId, role])

  // Paket 4d: auto-open binding_offer composer when navigated from a diagnosis job.
  // The CTA in CraftsmanJobOperationsCard navigates here with
  // ?followUpDiagnosis={diagnosisOfferId}. We read the offer for pre-fill,
  // open the composer, then clear the param so a page refresh doesn't re-open it.
  // getOfferById is read synchronously at mount; if the offer repo is not yet
  // hydrated, pre-fill fields are undefined (acceptable — sourceDiagnosisId is
  // always set, preserving functional correctness).
  useEffect(() => {
    const diagnosisOfferId = searchParams.get('followUpDiagnosis')
    if (!diagnosisOfferId || role !== 'craftsman') return

    // Clear param immediately — prevents re-opening on back-navigation or refresh
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('followUpDiagnosis')
      return next
    }, { replace: true })

    setComposerDocumentType('binding_offer')
    setComposerSourceDiagnosisId(diagnosisOfferId)
    setShowQuoteForm(true)

    const diagnosisOffer = getOfferById(diagnosisOfferId)
    setComposerSourceDiagnosisRef(diagnosisOffer?.offerRef ?? undefined)
    setComposerInitialScopeSummary(diagnosisOffer?.scopeSummary ?? undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // run once on mount — searchParams and role are stable at mount time

  // Load customer projects for the attach entry.
  // Also re-resolve artifacts when the project repo hydrates so artifact
  // cards upgrade from snapshot-only to entity-enriched rendering.
  useEffect(() => {
    if (role !== 'customer') return

    const refreshProjects = () => {
      setProjects(getProjects())
      if (threadId) {
        setArtifacts(getThreadArtifacts(threadId))
      }
    }
    refreshProjects()
    const unsub = subscribeProjects(refreshProjects)
    return unsub
  }, [role, threadId])

  const headerData = useMemo(() => {
    return thread ? getThreadHeader(thread, role) : undefined
  }, [thread, role])

  const chatHydrated = useChatHydrated()
  const chatRole: ChatRole = role === 'craftsman' ? 'craftsman' : 'customer'

  const [chatThreadId, setChatThreadId] = useState<string | null>(null)
  const [chatThreadError, setChatThreadError] = useState<string | null>(null)
  const lastMarkedReadIdRef = useRef<string | null>(null)
  // Send-lock shared by the text + voice paths. Stores the acquisition
  // timestamp (0 = free) instead of a boolean so a never-settling send
  // cannot brick sending permanently — see SEND_LOCK_MAX_MS.
  const sendingRef = useRef(0)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  // Tracks failed-retry count per clientMessageId for Image + Document bubbles.
  // Screen-local by design — resets on remount (accepted, audit 2026-06-10);
  // same applies to videoRetryCount below.
  const [attachmentRetryCount, setAttachmentRetryCount] = useState<Record<string, number>>({})
  // Failed text sends keyed by clientMessageId — body + retry count for the affordance.
  const [failedTextSends, setFailedTextSends] = useState<Record<string, { body: string; retryCount: number }>>({})
  // Video composer sheet visibility.
  const [showVideoComposer, setShowVideoComposer] = useState(false)
  // Upload progress (0–100) per clientMessageId for video pending bubbles.
  const [videoProgressMap, setVideoProgressMap] = useState<Record<string, number>>({})
  // Failed-retry count per clientMessageId for video bubbles.
  const [videoRetryCount, setVideoRetryCount] = useState<Record<string, number>>({})
  // Failed-retry count per clientMessageId for voice bubbles (3+ → discard CTA).
  const [voiceRetryCount, setVoiceRetryCount] = useState<Record<string, number>>({})

  // Connection state (offline | connecting | connected) from the chat repo —
  // drives the ChatConnectionBanner under the header.
  const connectionState = useChatConnectionState()

  // Reactive current-user-id (P1 mitigation): the session can resolve after
  // this component mounts (cold start, push deep-link before bootstrap).
  // A non-reactive snapshot would render every bubble as peer until reload.
  const [currentUserId, setCurrentUserId] = useState<string | null>(
    () => getCurrentSession().user?.id ?? null,
  )
  useEffect(() => {
    return subscribeSession(() => {
      setCurrentUserId(getCurrentSession().user?.id ?? null)
    })
  }, [])

  // Voice-note housekeeping: sweep stale IDB entries once per mount; release
  // the shared audio element when the user navigates away.
  useEffect(() => {
    void sweepStaleVoiceRecordings()
    return () => {
      releaseVoicePlayer()
    }
  }, [])

  // Read chat-thread by URL id (works when URL is a chat-only chat_threads.id
  // — fallback path for chat-only threads with no legacy mapping). For
  // migrated threads (URL = legacyThreadId), this returns null and we fall
  // through to the craftsmanUserId-based resolution below.
  const chatThreadFromUrl = useChatThread(threadId)

  // Effective header — legacy thread first, chat-domain displayMetadata
  // fallback for chat-only threads (push-deeplink to chat_threads.id with
  // no legacy mapping). 5/5 production customer threads are migrated today,
  // so the fallback path is exercised only by future chat-only threads.
  const effectiveHeaderData = useMemo(() => {
    if (headerData) return headerData
    if (chatThreadFromUrl) return buildHeaderFromChatThread(chatThreadFromUrl, role, currentUserId)
    return undefined
  }, [headerData, chatThreadFromUrl, role, currentUserId])

  const chatMessages = useChatMessages(chatThreadId ?? undefined)

  // ── Memoized chat timeline ────────────────────────────────────────────────
  // The timeline (entries[] union → chronological sort → day-separator chips →
  // renderList) is rebuilt ONLY when its ref-stable inputs change: chatMessages
  // (ref-guarded by useChatMessages) and artifacts (ref-guarded by the refresh
  // signature guard above). Previously this ran inside a JSX IIFE on EVERY
  // render, and a global-store notify for any thread app-wide forced a re-render
  // here. The produced renderList is byte-identical to the inline build — only
  // the recompute frequency changed. The JSX below maps over renderList and
  // reads role/handlers/local state fresh on every render (unchanged behavior).
  type TimelineEntry =
    | { kind: 'message'; message: NonNullable<typeof thread>['messages'][number] }
    | { kind: 'chat_message'; message: typeof chatMessages[number] }
    | { kind: 'chat_artifact_card'; message: typeof chatMessages[number] }
    | { kind: 'project_send'; artifact: ProjectArtifact }
    | { kind: 'quote_send'; artifact: OfferPaymentArtifact }
    | { kind: 'funding_step'; artifact: FundingStepArtifact }
    | { kind: 'date'; label: string }
  type TimelineRenderEntry = TimelineEntry & { sortKey: number }
  type TimelineResult =
    | { mode: 'hydrating' }
    | { mode: 'empty'; inquiryHint: string | null }
    | { mode: 'list'; renderList: TimelineRenderEntry[] }
  const timeline = useMemo<TimelineResult>(() => {
    const entries: TimelineRenderEntry[] = []
    // Slice 2 M1: track WHICH artifactTypes arrived as chat-domain artifact_card
    // messages — the legacy interleave below is suppressed PER type, not global.
    const chatArtifactCardTypes = new Set<string>()

    for (const msg of chatMessages) {
      if (msg.messageType === 'artifact_card') {
        if (!msg.artifactType || !msg.artifactId) continue
        // A failed optimistic send keeps its row (status='failed') but was never
        // persisted server-side — skip it so the timeline does not render a
        // delivered-looking ghost card.
        if (msg.status === 'failed') continue
        entries.push({ kind: 'chat_artifact_card', message: msg, sortKey: msg.createdAt })
        chatArtifactCardTypes.add(msg.artifactType)
        continue
      }
      // Text needs a non-empty body. Media messages (voice / image / document /
      // video / mixed) carry attachments, not a body — they must NOT be dropped
      // here or their render branches below stay unreachable.
      if (msg.messageType === 'text') {
        if (!msg.body || !msg.body.trim()) continue
      } else if (!MEDIA_MESSAGE_TYPES.has(msg.messageType)) {
        continue
      }
      entries.push({ kind: 'chat_message', message: msg, sortKey: msg.createdAt })
    }

    // Legacy artifact-event interleave — fallback for events that have no
    // chat-domain artifact_card producer yet. Suppressed PER type once its own
    // artifact_card producer exists for this thread.
    if (!chatArtifactCardTypes.has('Project')) {
      for (const artifact of artifacts.projectArtifacts) {
        entries.push({ kind: 'project_send', artifact, sortKey: artifact.createdAt })
      }
    }
    if (!chatArtifactCardTypes.has('OfferPayment') && artifacts.offerPaymentArtifact) {
      entries.push({
        kind: 'quote_send',
        artifact: artifacts.offerPaymentArtifact,
        sortKey: artifacts.offerPaymentArtifact.createdAt,
      })
    }
    if (!chatArtifactCardTypes.has('FundingStep') && artifacts.fundingStepArtifact) {
      entries.push({
        kind: 'funding_step',
        artifact: artifacts.fundingStepArtifact,
        sortKey: artifacts.fundingStepArtifact.createdAt,
      })
    }

    // Workflow-aware ordering: primary chronological, tiebreaker = workflow
    // progression order so co-timestamped entries land in the right sequence.
    entries.sort((a, b) => {
      const timeDiff = a.sortKey - b.sortKey
      if (timeDiff !== 0) return timeDiff
      return (TIMELINE_WORKFLOW_ORDER[a.kind] ?? 1) - (TIMELINE_WORKFLOW_ORDER[b.kind] ?? 1)
    })

    // Cold-start hydration gate: suppress the empty-state while chat-domain
    // hydration is in flight (legacy repo can hydrate before chat-domain).
    if (entries.length === 0 && !chatHydrated) {
      return { mode: 'hydrating' }
    }
    if (entries.length === 0) {
      const inquiryConversation = threadId ? getConversationById(threadId) : null
      const origin = inquiryConversation?.inquiryOrigin
      const inquiryHint =
        origin === 'profile' || origin === 'reel'
          ? 'Was, wo, ungefährer Zeitrahmen. Bilder hilfreich.'
          : null
      return { mode: 'empty', inquiryHint }
    }

    // Interleave V5 day separators — one glass date-chip per calendar day,
    // inserted before the first entry of each day (entries already sorted).
    const dayLabel = (ts: number): string => {
      const d = new Date(ts)
      const today = new Date()
      const yesterday = new Date()
      yesterday.setDate(today.getDate() - 1)
      const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
      if (sameDay(d, today)) return 'Heute'
      if (sameDay(d, yesterday)) return 'Gestern'
      return d.toLocaleDateString('de-DE', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      })
    }
    const renderList: TimelineRenderEntry[] = []
    let lastDayKey = ''
    for (const e of entries) {
      const dk = new Date(e.sortKey).toDateString()
      if (dk !== lastDayKey) {
        renderList.push({ kind: 'date', label: dayLabel(e.sortKey), sortKey: e.sortKey })
        lastDayKey = dk
      }
      renderList.push(e)
    }
    return { mode: 'list', renderList }
  }, [chatMessages, artifacts, chatHydrated, threadId])

  // Chat-thread resolution. Three paths:
  //   A) URL is chat_threads.id → useChatThread populates chatThreadFromUrl.
  //   B) URL is legacyThreadId with a migrated thread in cache → match on
  //      legacyThreadId (no RPC roundtrip, works for BOTH roles).
  //   C) URL is legacyThreadId without cache match → customer-only
  //      get-or-create RPC (idempotent). The prod RPC raises
  //      'cannot start customer-thread with self' when the caller IS the
  //      craftsman — the craftsman side resolves exclusively via A/B.
  useEffect(() => {
    if (!chatHydrated) return
    if (chatThreadId) return
    if (chatThreadFromUrl) {
      setChatThreadId(chatThreadFromUrl.id)
      return
    }
    const legacyMatch = threadId
      ? getChatRepository().getThreads().find((t) => t.legacyThreadId === threadId)
      : undefined
    if (legacyMatch) {
      setChatThreadId(legacyMatch.id)
      return
    }

    // No cache match. Resolve authoritatively server-side. This path is async;
    // `cancelled` guards every setState against a thread-switch / unmount.
    let cancelled = false
    setChatThreadError(null)
    void (async () => {
      // (B′) The URL id may be a chat_threads.id that simply isn't cached yet
      //      (deep-link / push-tap / cold-start / cross-device). An authoritative
      //      server seed resolves it for BOTH customer and craftsman — no
      //      get-or-create, no duplicate. ensureThreadInCache never throws and
      //      no-ops (returns undefined) when `threadId` is not a real thread id.
      if (threadId) {
        const seeded = await getChatRepository().ensureThreadInCache(threadId)
        if (cancelled) return
        if (seeded) {
          setChatThreadId(seeded.id)
          return
        }
      }
      // (C) Genuinely new inquiry → customer-only get-or-create. The prod RPC
      //     rejects a craftsman starting a thread with themselves, so there is
      //     no craftsman create path.
      const craftsmanUserId = headerData?.craftsmanUserId
      if (chatRole === 'customer' && craftsmanUserId) {
        try {
          // Pass an inquiry_origin so the RPC takes the reuse-newest-OPEN-thread
          // branch instead of the 60s-cooldown CREATE branch — without it a
          // cache-miss resolution >60s after the last open would mint a DUPLICATE
          // empty thread and orphan the prior history. 'profile' is the neutral
          // default for a fallback resolution (the explicit inquiry flow stamps
          // its own real origin via createCustomerInquiryThreadWorkflow).
          const id = await getOrCreateChatCustomerThread(craftsmanUserId, undefined, {
            inquiryOrigin: 'profile',
          })
          if (cancelled) return
          setChatThreadId(id)
        } catch (err) {
          if (cancelled) return
          console.error('[MessageThreadScreen] chat thread resolution failed:', err)
          setChatThreadError('Unterhaltung konnte nicht verbunden werden. Bitte erneut versuchen.')
        }
        return
      }
      // Terminal vs transient: a craftsman has no create path → always terminal.
      // A customer is terminal only once the legacy message repo is hydrated
      // (craftsmanUserId will not materialise later — e.g. a deep-link to an
      // RLS-invisible / deleted thread); before that, stay in the transient
      // "Wird verbunden …" state so the header effect can still re-run. Either
      // way surface a recoverable error instead of a silently frozen composer.
      if (cancelled) return
      if (chatRole !== 'customer' || isMessageRepositoryHydrated()) {
        setChatThreadError('Unterhaltung konnte nicht verbunden werden. Bitte erneut versuchen.')
      }
    })()
    return () => { cancelled = true }
  }, [chatHydrated, chatThreadId, chatThreadFromUrl, threadId, chatRole, headerData?.craftsmanUserId])

  // markRead dedupe: only call workflow when last-message-id actually changes.
  // A realtime echo of an existing row triggers an array-reference change
  // without a new last-id; without dedupe we'd fire one RPC per realtime tick.
  useEffect(() => {
    if (!chatThreadId || chatMessages.length === 0) return
    const last = chatMessages[chatMessages.length - 1]
    if (!last) return
    // Optimistic own send: temp_-ids don't exist server-side — marking read
    // against them is a guaranteed-failing UPDATE on every send. Skip WITHOUT
    // touching the dedupe ref so the server echo (real id) marks afterwards.
    if (last.id.startsWith('temp_')) return
    if (lastMarkedReadIdRef.current === last.id) return
    lastMarkedReadIdRef.current = last.id
    void markThreadReadWorkflow(chatThreadId, last.id)
  }, [chatThreadId, chatMessages])

  // Reset markRead-dedupe key when chatThreadId changes so the next arrival
  // in the new thread is acknowledged.
  useEffect(() => {
    lastMarkedReadIdRef.current = null
  }, [chatThreadId])

  // Scroll management (Block 3 scroll-twofer): open the thread at the latest
  // message (instant, once per thread) and follow new arrivals only when the
  // user is near the bottom or the trailing message is their own send. The
  // scroll container is the AppShell root ([data-app-scroll], resolved via
  // closest() from the anchor below the timeline).
  const messagesEndRef = useRef<HTMLDivElement>(null)
  useThreadAutoScroll({
    endRef: messagesEndRef,
    messages: chatMessages,
    currentUserId,
    threadKey: chatThreadId,
  })

  // Edge-to-edge steel header: extend the WebView under the iOS status bar
  // (overlay:true + light glyphs) so the navy gradient fills the notch instead
  // of leaving the app-default white strip. Restores the default on unmount.
  useImmersiveStatusBar()

  // Pin the composer to the top of the keyboard (WhatsApp-style). Keeps the
  // latest message visible above the lifted bar by scrolling to the end when
  // the keyboard opens.
  useKeyboardInset(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ block: 'end' })
    })
  })

  // Resolve job context for send_message AWE — bumped to declaration order
  // so the useProActionGate hook below can consume it. Only set when this
  // thread is the bound thread of an active escrow job (enforces the
  // thread-binding check BEFORE the entitlement resolver sees the context).
  const sendMessageJobContext = useMemo(() => {
    if (role !== 'craftsman' || !threadId) return undefined
    const contexts = resolveAllActiveWorkContexts()
    return contexts.find((ctx) => ctx.boundThreadId === threadId) ?? undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, threadId, workContextVersion])

  // Pro-action gates (parity with legacy CraftsmanActionSheet + send_message
  // ProActionGuard on line ~1124). Cutover path bypasses both legacy gate
  // sites — without the hooks below, expired-trial craftsmen could send +
  // open offer/nachtrag flows without trial-start / upgrade prompts.
  const sendMessageGate = useProActionGate({
    action: 'send_message',
    effectiveState: subscription.effectiveState,
    scope: subscription.scope,
    jobContext: sendMessageJobContext,
    onTrialStarted: subscription.refetch,
  })
  const openQuoteComposerGate = useProActionGate({
    action: 'open_quote_composer',
    effectiveState: subscription.effectiveState,
    scope: subscription.scope,
    onTrialStarted: subscription.refetch,
  })

  // Cutover-aware retry handler (P0 mitigation): without this, a transient
  // resolution failure leaves chatThreadId null permanently — composer
  // disabled with no path to recover.
  const handleChatThreadRetry = useCallback(() => {
    setChatThreadError(null)
    if (chatThreadFromUrl) {
      setChatThreadId(chatThreadFromUrl.id)
      return
    }
    // Same resolution order as the effect above: legacy-mapping cache match,
    // then authoritative server seed (both roles), then customer-only create.
    const legacyMatch = threadId
      ? getChatRepository().getThreads().find((t) => t.legacyThreadId === threadId)
      : undefined
    if (legacyMatch) {
      setChatThreadId(legacyMatch.id)
      return
    }
    void (async () => {
      if (threadId) {
        const seeded = await getChatRepository().ensureThreadInCache(threadId)
        if (seeded) {
          setChatThreadId(seeded.id)
          return
        }
      }
      const craftsmanUserId = headerData?.craftsmanUserId
      if (chatRole === 'customer' && craftsmanUserId) {
        try {
          // inquiry_origin forces the reuse-open-thread branch (no duplicate) —
          // see the resolution effect above.
          setChatThreadId(
            await getOrCreateChatCustomerThread(craftsmanUserId, undefined, {
              inquiryOrigin: 'profile',
            }),
          )
        } catch (err) {
          console.error('[MessageThreadScreen] chat thread retry failed:', err)
          setChatThreadError('Unterhaltung konnte nicht verbunden werden. Bitte erneut versuchen.')
        }
        return
      }
      // User-initiated retry that cannot resolve → keep the recoverable error
      // visible (never a silently frozen composer).
      setChatThreadError('Unterhaltung konnte nicht verbunden werden. Bitte erneut versuchen.')
    })()
  }, [chatThreadFromUrl, threadId, chatRole, headerData?.craftsmanUserId])

  const navigate = useNavigate()
  const activeJobId = artifacts.offerPaymentArtifact?.jobId ?? ''

  // Chat-domain send (P1 mitigation: synchronous double-tap guard via
  // sendingRef — `isSending` is queued by React, two touches in the same
  // tick can both pass the gate before state lands and create two
  // distinct messages with different client_message_ids).
  const handleChatSend = useCallback(
    async (body: string) => {
      if (!chatThreadId) return
      const now = Date.now()
      if (sendingRef.current !== 0 && now - sendingRef.current < SEND_LOCK_MAX_MS) return
      const lockToken = now
      sendingRef.current = lockToken
      // clientMessageId extracted here so the catch block can register the
      // failed send — the failed optimistic bubble retains the text, so the
      // composer input clears and the bubble becomes the retry surface.
      const clientMessageId = crypto.randomUUID()
      try {
        // Read currentUserId fresh from the session module at send-time —
        // not from the reactive `currentUserId` state. On cold-start, the
        // useState seed may be null while supabase has already populated
        // the in-memory session cache via onAuthStateChange. Without this
        // fresh read, the moderation block-check is skipped in the race
        // window between mount and the subscribeSession callback firing.
        const sessionUserId = getCurrentSession().user?.id ?? null
        await sendMessageWorkflow({
          threadId: chatThreadId,
          body,
          clientMessageId,
          callerRole: chatRole,
          currentUserId: sessionUserId,
        })
      } catch (err) {
        console.error('[MessageThreadScreen] chat send failed:', err)
        const classified = classifyChatSendError(err)
        toast.error(classified.userMessage)
        const bubbleExists = getChatRepository()
          .getMessages(chatThreadId)
          .some((m) => m.clientMessageId === clientMessageId)
        if (!classified.retryable) {
          // Structural reject (authz / moderation / unknown server reject): a
          // retry re-issues the IDENTICAL doomed insert — never offer one. Drop
          // the failed optimistic bubble (if any) and re-throw so ChatComposer
          // keeps the text for editing instead of leaving a red retry bubble
          // that can only loop. This kills the live "kann keine Nachricht
          // senden" retry-loop.
          if (bubbleExists) discardFailedTextWorkflow(chatThreadId, clientMessageId)
          throw err
        }
        // Transient (network / abort / timeout / migration-pending): the failed
        // optimistic bubble IS the retry surface, so register it and let the
        // composer clear. A pre-insert transient throw (no bubble) re-throws so
        // the composer keeps the text.
        if (!bubbleExists) throw err
        setFailedTextSends((prev) => ({
          ...prev,
          [clientMessageId]: { body, retryCount: 0 },
        }))
      } finally {
        // Token-guarded release: a hung send whose lock already expired (and
        // was re-acquired by a newer send) must not free the newer lock.
        if (sendingRef.current === lockToken) sendingRef.current = 0
      }
    },
    [chatThreadId, chatRole, toast],
  )

  const handleTextRetry = useCallback(
    async (clientMessageId: string) => {
      const entry = failedTextSends[clientMessageId]
      if (!entry || !chatThreadId) return
      setFailedTextSends((prev) => ({
        ...prev,
        [clientMessageId]: { ...prev[clientMessageId], retryCount: prev[clientMessageId].retryCount + 1 },
      }))
      try {
        const sessionUserId = getCurrentSession().user?.id ?? null
        await retryFailedTextWorkflow({
          threadId: chatThreadId,
          body: entry.body,
          clientMessageId,
          callerRole: chatRole,
          currentUserId: sessionUserId,
        })
        setFailedTextSends((prev) => {
          const next = { ...prev }
          delete next[clientMessageId]
          return next
        })
      } catch (err) {
        console.error('[MessageThreadScreen] chat retry failed:', err)
        const classified = classifyChatSendError(err)
        toast.error(classified.userMessage)
        if (!classified.retryable && chatThreadId) {
          // Retrying a structural reject can only loop the same doomed write —
          // drop the bubble and the retry affordance instead of leaving a red
          // button that never resolves.
          discardFailedTextWorkflow(chatThreadId, clientMessageId)
          setFailedTextSends((prev) => {
            const next = { ...prev }
            delete next[clientMessageId]
            return next
          })
        }
      }
    },
    [chatThreadId, chatRole, toast, failedTextSends],
  )

  const handleTextDiscard = useCallback(
    (clientMessageId: string) => {
      if (!chatThreadId) return
      discardFailedTextWorkflow(chatThreadId, clientMessageId)
      setFailedTextSends((prev) => {
        const next = { ...prev }
        delete next[clientMessageId]
        return next
      })
    },
    [chatThreadId],
  )

  // Programmatic file picker for photo / document tiles.  Each file gets its
  // own optimistic bubble and its own IDB cache entry — failures per-file.
  // Validation and offline errors throw before the optimistic insert (no
  // bubble), so we surface those via toast. Post-insert ChatUploadError means
  // the bubble shows the failed state itself — no toast needed.
  const handleAttachmentFiles = useCallback(
    async (files: FileList | null, kind: 'photo' | 'document') => {
      if (!files || files.length === 0 || !chatThreadId) return
      const sessionUserId = getCurrentSession().user?.id ?? null
      // All files started in parallel: each workflow hits insertOptimisticMessage
      // without waiting for the previous file's upload, so every file gets its
      // own immediate pending bubble rather than appearing one-by-one.
      await Promise.allSettled(
        Array.from(files).map(async (file) => {
          const clientMessageId = crypto.randomUUID()
          try {
            await sendSingleAttachmentOptimisticWorkflow({
              threadId: chatThreadId,
              clientMessageId,
              callerRole: chatRole,
              file,
              kind,
              currentUserId: sessionUserId,
            })
          } catch (err) {
            if (err instanceof ChatSendQueuedError || err instanceof ChatUploadError) {
              // Queued (offline/transient) → bubble stays pending, the outbox
              // drain retries. Permanent → red bubble is the retry surface.
              // Either way the bubble is the surface — no toast.
            } else if (err instanceof ChatFileValidationError) {
              toast.error(err.message)
            } else {
              console.error('[MessageThreadScreen] attachment send failed:', err)
              toast.error(err instanceof Error ? err.message : 'Anhang konnte nicht gesendet werden')
            }
          }
        }),
      )
      // Reset the input so re-selecting the same file fires onChange.
      if (kind === 'photo' && photoInputRef.current) photoInputRef.current.value = ''
      if (kind === 'document' && documentInputRef.current) documentInputRef.current.value = ''
    },
    [chatThreadId, chatRole, toast],
  )

  // Discard handler: unified durable-state-aware discard — removes the failed
  // optimistic row, the outbox record + backoff timer, both blob caches, and any
  // already-uploaded orphan blob (discardFailedMediaMessage does it all).
  const handleAttachmentDiscard = useCallback(
    (clientMessageId: string) => {
      if (!chatThreadId) return
      void discardFailedMediaMessage(chatThreadId, clientMessageId)
      setAttachmentRetryCount((prev) => {
        const next = { ...prev }
        delete next[clientMessageId]
        return next
      })
    },
    [chatThreadId],
  )

  // Retry handler shared by Image + Document failed bubbles.
  // Re-runs the Pro-gate before retrying — a user's subscription may have
  // expired between the first attempt and the retry tap.
  const handleAttachmentRetry = useCallback(
    async (clientMessageId: string, kind: 'photo' | 'document') => {
      if (!chatThreadId) return
      if (chatRole === 'craftsman') {
        const allowed = await sendMessageGate.gate()
        if (!allowed) return
      }
      const cached = await getCachedAttachment(clientMessageId)
      if (!cached) return
      const sessionUserId = getCurrentSession().user?.id ?? null
      try {
        await retryFailedAttachmentWorkflow({
          threadId: chatThreadId,
          clientMessageId,
          callerRole: chatRole,
          file: new File([cached.blobData], cached.fileName, { type: cached.mimeType }),
          kind,
          caption: cached.caption,
          currentUserId: sessionUserId,
        })
      } catch (err) {
        if (err instanceof ChatSendQueuedError) {
          // Transient → bubble back to pending, outbox drain retries. Not a
          // manual-retry failure, so the failed count stays put.
        } else if (err instanceof ChatUploadError) {
          setAttachmentRetryCount((prev) => ({
            ...prev,
            [clientMessageId]: (prev[clientMessageId] ?? 0) + 1,
          }))
        } else if (err instanceof OfflineError) {
          toast.error(err.message)
        } else {
          console.error('[MessageThreadScreen] attachment retry failed:', err)
        }
      }
    },
    [chatThreadId, chatRole, sendMessageGate, toast],
  )

  // Video send — called by VideoComposerSheet after probe + poster extraction.
  const handleVideoSend = useCallback(
    async (payload: VideoReadyPayload) => {
      if (!chatThreadId) return
      if (chatRole === 'craftsman') {
        const allowed = await sendMessageGate.gate()
        if (!allowed) return
      }
      const clientMessageId = crypto.randomUUID()
      const sessionUserId = getCurrentSession().user?.id ?? null
      setVideoProgressMap((prev) => ({ ...prev, [clientMessageId]: 0 }))
      try {
        await sendVideoMessageWorkflow({
          threadId: chatThreadId,
          clientMessageId,
          callerRole: chatRole,
          videoBlob: payload.blob,
          mimeType: payload.mimeType,
          fileExtension: payload.fileExtension,
          durationMs: payload.durationMs,
          width: payload.width,
          height: payload.height,
          posterFile: payload.posterFile,
          currentUserId: sessionUserId,
          onProgress: (pct) => {
            setVideoProgressMap((prev) => ({ ...prev, [clientMessageId]: pct }))
          },
        })
      } catch (err) {
        if (err instanceof ChatSendQueuedError || err instanceof ChatUploadError) {
          // Queued (offline/transient) → pending bubble, outbox retries.
          // Permanent → red bubble is the surface. No toast either way.
        } else if (err instanceof ChatFileValidationError) {
          toast.error(err.message)
        } else {
          console.error('[MessageThreadScreen] video send failed:', err)
          toast.error(err instanceof Error ? err.message : 'Video konnte nicht gesendet werden')
        }
      } finally {
        setVideoProgressMap((prev) => {
          const next = { ...prev }
          delete next[clientMessageId]
          return next
        })
      }
    },
    [chatThreadId, chatRole, sendMessageGate, toast],
  )

  const handleVideoDiscard = useCallback(
    (clientMessageId: string) => {
      if (!chatThreadId) return
      void discardFailedMediaMessage(chatThreadId, clientMessageId)
      setVideoRetryCount((prev) => {
        const next = { ...prev }
        delete next[clientMessageId]
        return next
      })
      setVideoProgressMap((prev) => {
        const next = { ...prev }
        delete next[clientMessageId]
        return next
      })
    },
    [chatThreadId],
  )

  const handleVideoRetry = useCallback(
    async (clientMessageId: string) => {
      if (!chatThreadId) return
      if (chatRole === 'craftsman') {
        const allowed = await sendMessageGate.gate()
        if (!allowed) return
      }
      const cached = await getCachedAttachment(clientMessageId)
      if (!cached || cached.kind !== 'video') return
      const sessionUserId = getCurrentSession().user?.id ?? null
      setVideoProgressMap((prev) => ({ ...prev, [clientMessageId]: 0 }))
      try {
        await retryFailedVideoWorkflow({
          threadId: chatThreadId,
          clientMessageId,
          callerRole: chatRole,
          videoBlob: cached.blobData,
          mimeType: cached.mimeType,
          fileExtension: cached.fileName.split('.').pop() ?? 'mp4',
          durationMs: cached.durationMs ?? 0,
          caption: cached.caption,
          currentUserId: sessionUserId,
          onProgress: (pct) => {
            setVideoProgressMap((prev) => ({ ...prev, [clientMessageId]: pct }))
          },
        })
      } catch (err) {
        if (err instanceof ChatSendQueuedError) {
          // Transient → pending bubble, outbox drain retries; count unchanged.
        } else if (err instanceof ChatUploadError) {
          setVideoRetryCount((prev) => ({
            ...prev,
            [clientMessageId]: (prev[clientMessageId] ?? 0) + 1,
          }))
        } else if (err instanceof OfflineError) {
          toast.error(err.message)
        } else {
          console.error('[MessageThreadScreen] video retry failed:', err)
        }
      } finally {
        setVideoProgressMap((prev) => {
          const next = { ...prev }
          delete next[clientMessageId]
          return next
        })
      }
    },
    [chatThreadId, chatRole, sendMessageGate, toast],
  )

  // Voice-note send: cache blob to IDB before upload, clear on success.
  // Workflow throws on RBAC/upload/RPC failure — caller surfaces via toast.
  // On failure the IDB entry is left in place so a follow-up retry path can
  // resurrect it; sweepStaleVoiceRecordings cleans abandoned entries after
  // 7 days.
  const handleVoiceSend = useCallback(
    async (recording: VoiceRecording) => {
      if (!chatThreadId) throw new Error('chat.voice.no_thread')
      const now = Date.now()
      if (sendingRef.current !== 0 && now - sendingRef.current < SEND_LOCK_MAX_MS) {
        throw new Error('chat.voice.busy')
      }
      const lockToken = now
      sendingRef.current = lockToken
      const channelType = chatThreadFromUrl?.channelType ?? 'customer'
      try {
        await cacheVoiceRecording({
          clientMessageId: recording.clientMessageId,
          threadId: chatThreadId,
          channelType,
          blob: recording.file,
          durationMs: recording.durationMs,
          mimeType: recording.mimeType,
          fileExtension: recording.file.name.split('.').pop() ?? 'm4a',
          createdAt: Date.now(),
        })
        const sessionUserId = getCurrentSession().user?.id ?? null
        await sendVoiceNoteWorkflow({
          threadId: chatThreadId,
          clientMessageId: recording.clientMessageId,
          callerRole: chatRole,
          blob: recording.file,
          durationMs: recording.durationMs,
          mimeType: recording.mimeType,
          currentUserId: sessionUserId,
        })
        await clearVoiceRecording(recording.clientMessageId)
      } catch (err) {
        if (err instanceof ChatSendQueuedError) {
          // Queued (offline/transient): the pending voice bubble stays and the
          // outbox drain sends on reconnect. Success from the user's POV — the
          // IDB blob is kept for the drain-worker, no toast, no re-throw (the
          // composer clears its recording).
          return
        }
        if (err instanceof ChatUploadError) {
          // Permanent upload failure: the red voice bubble in the stream IS the
          // retry surface. Re-throw so ChatComposer's `bubbleInserted` branch
          // skips its own failed-pending banner (no double surface). No toast.
          throw err
        }
        // Pre-insert failure (RBAC / validation / empty / busy / session):
        // no bubble exists — surface via toast + re-throw so the composer keeps
        // the recording. The IDB blob stays in place for retry.
        console.error('[MessageThreadScreen] voice send failed:', err)
        const msg = err instanceof Error ? err.message : 'Sprachnachricht konnte nicht gesendet werden'
        toast.error(msg)
        throw err
      } finally {
        // Token-guarded release — see handleChatSend.
        if (sendingRef.current === lockToken) sendingRef.current = 0
      }
    },
    [chatThreadId, chatRole, chatThreadFromUrl, toast],
  )

  // Manual retry of a failed voice bubble — reconstructs the recording from the
  // IDB cache and re-runs handleVoiceSend. A repeated PERMANENT failure bumps
  // the local failed-count so the bubble offers "verwerfen" after 3 tries;
  // queued/success clears it (handleVoiceSend swallows ChatSendQueuedError).
  const handleVoiceRetry = useCallback(
    async (clientMessageId: string) => {
      const cached = await readVoiceRecording(clientMessageId)
      if (!cached) return
      try {
        await handleVoiceSend({
          clientMessageId: cached.clientMessageId,
          file: new File([cached.blob], `voice-${cached.clientMessageId}.${cached.fileExtension}`, {
            type: cached.mimeType,
          }),
          durationMs: cached.durationMs,
          mimeType: cached.mimeType,
        })
        setVoiceRetryCount((prev) => {
          const next = { ...prev }
          delete next[clientMessageId]
          return next
        })
      } catch (err) {
        // ChatUploadError = permanent → bump count. Pre-insert errors were
        // already toasted by handleVoiceSend; ChatSendQueuedError never reaches
        // here (handleVoiceSend returns on it).
        if (err instanceof ChatUploadError) {
          setVoiceRetryCount((prev) => ({
            ...prev,
            [clientMessageId]: (prev[clientMessageId] ?? 0) + 1,
          }))
        }
      }
    },
    [handleVoiceSend],
  )

  // Discard a failed voice message — unified durable discard (bubble + outbox
  // record + backoff timer + voice/attachment blob caches + orphan blob).
  const handleVoiceDiscard = useCallback(
    (clientMessageId: string) => {
      if (!chatThreadId) return
      void discardFailedMediaMessage(chatThreadId, clientMessageId)
      setVoiceRetryCount((prev) => {
        const next = { ...prev }
        delete next[clientMessageId]
        return next
      })
    },
    [chatThreadId],
  )

  // Pro-Action-Gate for the voice path runs in ChatComposer (mirrors text's
  // `beforeSend`). A trial-expired craftsman gets the upgrade modal BEFORE
  // the recording is uploaded; the composer keeps the cached blob accessible
  // in its failed-pending banner so the user can retry after upgrading.
  const handleBeforeVoiceSend = useCallback(async () => {
    if (chatRole !== 'craftsman') return true
    return sendMessageGate.gate()
  }, [chatRole, sendMessageGate])

  // Pre-flight gate for ChatComposer text send. Craftsman → check Pro
  // subscription state for `send_message`; other roles always permitted.
  const handleBeforeSend = useCallback(async () => {
    if (chatRole !== 'craftsman') return true
    return sendMessageGate.gate()
  }, [chatRole, sendMessageGate])

  // Pre-flight gate for ChatComposer tile triggers.
  //   offer / change_order  → open_quote_composer gate (commercial document)
  //   photo / document      → send_message gate (an attachment IS a chat
  //                            message; without this gate, a trial-expired
  //                            craftsman could bypass send_message via the
  //                            attachment tiles)
  //   project_attach        → no gate (customer-only feature anyway)
  const handleBeforeTile = useCallback(
    async (kind: ComposerTileKind) => {
      if (chatRole !== 'craftsman') return true
      if (kind.type === 'offer' || kind.type === 'change_order') {
        return openQuoteComposerGate.gate()
      }
      if (kind.type === 'photo' || kind.type === 'document') {
        return sendMessageGate.gate()
      }
      return true
    },
    [chatRole, sendMessageGate, openQuoteComposerGate],
  )

  // Tile dispatcher — ChatComposer (Stage 2) emits ComposerTileKind events.
  // Map to existing workflows:
  //   offer (3 documentTypes) → opens QuoteCreationSheet (Slice-2 will
  //                              decouple QuoteCreationSheet from legacy
  //                              conversation prop; for now we guard with
  //                              getConversationById null-check).
  //   change_order            → navigates to nachtrag/neu (existing route).
  //   project_attach          → opens ProjectPickerSheet (existing).
  //   photo / document        → triggers hidden file input → workflow.
  const handleTileTrigger = useCallback(
    (kind: ComposerTileKind) => {
      if (kind.type === 'offer') {
        if (!threadId) return
        // Dual-path: a legacy conversation OR a cutover chat thread both let
        // the composer open. Only a thread unknown to both domains is "not
        // available". (Was: legacy-only getConversationById null-check, which
        // dead-ended every cutover inquiry thread — Block Q.)
        if (!buildQuoteContext(threadId, chatThreadFromUrl)) {
          toast.error('Angebot-Composer ist für diesen Thread nicht verfügbar')
          return
        }
        setComposerDocumentType(kind.documentType)
        setShowQuoteForm(true)
        return
      }
      if (kind.type === 'change_order') {
        if (!activeJobId) {
          toast.error('Kein aktiver Auftrag — Nachtrag nicht möglich')
          return
        }
        navigate(`/craftsman/nachtrag/neu?jobId=${activeJobId}`)
        return
      }
      if (kind.type === 'project_attach') {
        // Dual-path (mirrors the `offer` branch): a legacy conversation OR a
        // cutover chat thread both let the picker open. Post-cutover the
        // customer's inquiry threads live in the chat domain (legacy `thread`
        // is null), so the attach routes through the chat artifact_card path
        // in handleProjectSelect. Only a thread unknown to both domains is
        // "not available".
        if (!thread && !chatThreadId) {
          toast.error('Projekt anhängen ist für diesen Thread nicht verfügbar')
          return
        }
        setShowProjectPicker(true)
        return
      }
      if (kind.type === 'photo') {
        photoInputRef.current?.click()
        return
      }
      if (kind.type === 'document') {
        documentInputRef.current?.click()
        return
      }
      if (kind.type === 'video') {
        setShowVideoComposer(true)
        return
      }
    },
    [activeJobId, threadId, thread, chatThreadId, chatThreadFromUrl, navigate, toast],
  )

  const handleProjectSelect = useCallback(
    async (projectId: string) => {
      // Dual-path: legacy conversation OR cutover chat thread. Post-cutover the
      // customer's inquiry threads are chat-domain (legacy `thread` is null),
      // so the attach routes through the chat artifact_card path below.
      if (!thread && !chatThreadId) return
      // Guard against double-tap: ignore if an attach is already in flight
      if (isAttachingProjectRef.current) return
      isAttachingProjectRef.current = true
      setProjectSendError(null)
      try {
        if (thread) {
          await sendProjectAttachmentWorkflow(thread.id, projectId)
        } else if (chatThreadId) {
          // Chat-domain artifact reference: persists a `Project` artifact_card
          // message (message_type='artifact_card', artifact_type='Project').
          // ChatArtifactCardCompact renders it in the timeline; taps route to
          // /projects/{id}. RBAC + moderation run in the workflow layer
          // (sendMessageWorkflow). currentUserId is read fresh from the session
          // module so the block-check survives the cold-start race — same
          // rationale as handleChatSend.
          await sendMessageWorkflow({
            threadId: chatThreadId,
            clientMessageId: crypto.randomUUID(),
            callerRole: chatRole,
            artifactType: 'Project',
            artifactId: projectId,
            currentUserId: getCurrentSession().user?.id ?? null,
          })
        }
        setShowProjectPicker(false)
        toast.success('Projekt gesendet')
      } catch {
        // Surface the failure via InlineFeedback only — no additional
        // toast.  The old code fired both setProjectSendError AND
        // toast.error with the same message, causing a duplicate error
        // display (inline + global toast).
        setProjectSendError('Projekt konnte nicht gesendet werden. Bitte erneut versuchen.')
      } finally {
        // Explicit post-send refresh: runs on BOTH success and failure
        // so the visible timeline always reflects the confirmed artifact
        // state.  On success, this guarantees the new project-send event
        // is visible immediately — even if React batched the subscription-
        // driven setState calls.  On failure, this re-reads after the
        // optimistic rollback so the UI does not show a ghost card.
        if (threadId) {
          setThread(getMessageThreadById(threadId))
          setArtifacts(getThreadArtifacts(threadId))
        }
        isAttachingProjectRef.current = false
      }
    },
    [thread, chatThreadId, chatRole, threadId, toast]
  )

  const handleSetActiveProject = useCallback(
    (projectId: string) => {
      if (!thread) return
      try {
        setActiveThreadProjectWorkflow(thread.id, projectId)
        toast.success('Hauptprojekt gesetzt')
      } catch {
        toast.error('Hauptprojekt konnte nicht gesetzt werden')
      }
    },
    [thread, toast]
  )

  // Canonical conversation redirect: if the URL points to a non-canonical
  // duplicate thread, redirect to the canonical winner so all surfaces
  // (inbox, thread view, writes) use the same conversation.
  if (threadId) {
    const canonicalId = resolveCanonicalThreadId(threadId)
    if (canonicalId !== threadId) {
      return <Navigate to={`${effectiveBackPath}/${canonicalId}`} replace />
    }
  }

  // No threadId in URL — nothing to show, redirect to inbox
  if (!threadId) {
    return <Navigate to={effectiveBackPath} replace />
  }

  // Thread not yet loaded — show skeleton while waiting for hydration.
  // In cutover mode we also wait for chat-domain hydration, because the
  // chat-only fallback (push-deeplink to chat_threads.id with no legacy
  // mapping) needs `chatThreadFromUrl` to populate before deciding between
  // not-found and chat-only render.
  if (!thread && !loaded) {
    return (
      <AppShell active="messages" className="bg-[#F4F6FB]" hideBottomNav>
        <ScreenSkeleton variant="chat" />
      </AppShell>
    )
  }
  if (!thread && !chatHydrated) {
    return (
      <AppShell active="messages" className="bg-[#F4F6FB]" hideBottomNav>
        <ScreenSkeleton variant="chat" />
      </AppShell>
    )
  }

  // Thread not found — neither legacy nor chat-domain has a record.
  if (!effectiveHeaderData) {
    return (
      <AppShell active="messages" className="bg-[#F4F6FB]" hideBottomNav>
        <CorridorNotFound
          entityLabel="Nachricht"
          backTo={effectiveBackPath}
          backLabel="Zum Posteingang"
          subtitle="Diese Unterhaltung existiert nicht mehr oder ist nicht verfügbar."
        />
      </AppShell>
    )
  }

  // Escrow-€ header badge — the funded amount held in the platform's Treuhand
  // for this thread's job. Recomputed each render; the screen re-renders on the
  // escrow/timeline `bump` subscription, so this stays live. Only shown once
  // money is actually secured (funded_in_escrow or already partly released).
  const escrowBadgeAmount = (() => {
    const escrowJobId = artifacts.offerPaymentArtifact?.jobId
    if (!escrowJobId) return null
    const proj = resolveMoneyFlowProjection(escrowJobId, null)
    if (!proj || !proj.hasEscrowPlan) return null
    if (proj.fundingStatus !== 'funded_in_escrow' && proj.releasedAmount === 0) return null
    return proj.totalAmountFormatted
  })()

  // ── V5 „Klar & Glas" steelivory — edge-to-edge steel header (single row).
  // Rendered via AppShell's `header` slot so it's fixed/full-bleed; the message
  // list clears it with its own top padding. Escrow-€ badge + online presence
  // are wired in a later sub-block — the right slot keeps the moderation menu.
  const v5Header = (
    <div
      className="pb-3.5 pt-[max(54px,calc(env(safe-area-inset-top,0px)+16px))] shadow-[0_10px_26px_-18px_rgba(0,0,0,0.9)]"
      style={{ background: 'linear-gradient(180deg, #244377 0%, #1D3866 100%)' }}
    >
      <div className="mx-auto flex w-full max-w-[420px] items-center gap-3 px-3.5">
        <button
          type="button"
          onClick={goBack}
          aria-label="Zurück"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-[18px] text-white"
        >
          ←
        </button>

        {role === 'customer' && effectiveHeaderData.craftsmanUserId ? (
          <Link to={`/explore/craftsman/${effectiveHeaderData.craftsmanUserId}`} className="shrink-0">
            <Avatar
              src={effectiveHeaderData.avatarUrl}
              name={effectiveHeaderData.primaryName}
              size="sm"
              className="ring-2 ring-white/90"
            />
          </Link>
        ) : (
          <Avatar
            src={effectiveHeaderData.avatarUrl}
            name={effectiveHeaderData.primaryName}
            size="sm"
            className="ring-2 ring-white/90"
          />
        )}

        <div className="min-w-0 flex-1 leading-tight">
          {role === 'customer' && effectiveHeaderData.craftsmanUserId ? (
            <Link to={`/explore/craftsman/${effectiveHeaderData.craftsmanUserId}`} className="block">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15.5px] font-semibold text-white">
                  {effectiveHeaderData.primaryName}
                </span>
                {chatThreadFromUrl && (
                  <ChannelBadge channelType={chatThreadFromUrl.channelType} />
                )}
              </div>
              <div className="truncate text-[12px] text-white/70">
                {effectiveHeaderData.secondaryLine}
              </div>
            </Link>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[15.5px] font-semibold text-white">
                  {effectiveHeaderData.primaryName}
                </span>
                {chatThreadFromUrl && (
                  <ChannelBadge channelType={chatThreadFromUrl.channelType} />
                )}
              </div>
              <div className="truncate text-[12px] text-white/70">
                {effectiveHeaderData.secondaryLine}
              </div>
            </>
          )}
        </div>

        {escrowBadgeAmount ? (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-2.5 py-1 text-[11.5px] font-semibold tabular-nums text-white">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            {escrowBadgeAmount}
          </div>
        ) : null}
        {(() => {
          const targetId = role === 'customer'
            ? effectiveHeaderData.craftsmanUserId
            : effectiveHeaderData.customerUserId;
          return targetId ? (
            <span className="text-white">
              <ChatModerationMenu
                targetUserId={targetId}
                targetLabel={effectiveHeaderData.primaryName}
              />
            </span>
          ) : null;
        })()}
      </div>
    </div>
  )

  return (
    <AppShell active="messages" className="bg-[#EFE9E0]" hideBottomNav header={v5Header}>
      <V5ChatBackdrop />
      <section
        className="relative z-10 min-h-[100svh] px-4 pt-[max(118px,calc(env(safe-area-inset-top,0px)+82px))]"
        style={{ paddingBottom: 'calc(7rem + var(--keyboard-height, 0px))' }}
      >
        <div className="mx-auto w-full max-w-[420px]">

          {/* ── Connection banner (offline / verbinde …) — collapses to 0 height
              when connected. Offline sends still succeed (Media-Outbox).
              Sticky at the header edge: the thread auto-scrolls to bottom, so a
              flow-positioned banner would sit permanently off-screen at the top. */}
          <div
            className="sticky z-30"
            style={{ top: 'max(110px, calc(env(safe-area-inset-top, 0px) + 74px))' }}
          >
            <ChatConnectionBanner state={connectionState} />
          </div>

          {/* ── Persistent artifact top-cards removed (V5 redesign 2026-06-23,
              decision 3): every artifact now lives ONLY chronologically in the
              stream below via ChatArtifactCardCompact — no duplicated sticky
              card. The payment/payout trust strip stays (it is a status strip,
              not an artifact duplication). */}

          {/* ── Payment / payout trust strip (Block 3) ── */}
          {(thread || chatThreadId) && artifacts.offerPaymentArtifact?.jobId && (
            <ThreadPaymentStatusCard
              jobId={artifacts.offerPaymentArtifact.jobId}
              role={role}
            />
          )}

          {/* ── Chat timeline (messages + project send events + quote events) ── */}
          <div className="mt-2 flex flex-col gap-2">
            {(() => {
              // Timeline entries[]/sort/day-chips/renderList are memoized in
              // `timeline` (see the useMemo above) so they recompute only when
              // chatMessages / artifacts actually change, not on every global
              // store notify. The rendered output here is byte-identical.
              if (timeline.mode === 'hydrating') {
                return (
                  <div key="chat-hydrating" className="flex items-center justify-center px-6 py-10">
                    <p className="text-[13px] text-slate-400">Nachrichten werden geladen …</p>
                  </div>
                )
              }
              if (timeline.mode === 'empty') {
                const inquiryHint = timeline.inquiryHint
                return (
                  <div key="empty-thread" className="flex flex-col items-center justify-center px-6 py-10 text-center">
                    <div className="text-[28px]">💬</div>
                    <p className="mt-2 text-[14px] font-semibold text-slate-500">Noch keine Nachrichten</p>
                    <p className="mt-1 text-[12px] text-slate-400">
                      Schreibe eine Nachricht, um das Gespräch zu starten.
                    </p>
                    {inquiryHint ? (
                      <p className="mt-3 max-w-[260px] rounded-xl bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-500 ring-1 ring-slate-200/70">
                        Tipp: {inquiryHint}
                      </p>
                    ) : null}
                  </div>
                )
              }

              return timeline.renderList.map((entry) => {
                if (entry.kind === 'date') {
                  return (
                    <div key={`date-${entry.sortKey}`} className="my-3 flex justify-center">
                      <div className="rounded-full bg-white/85 px-3.5 py-1 text-[11.5px] font-semibold tracking-wide text-slate-500 shadow-[0_1px_2px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 backdrop-blur-md">
                        {entry.label}
                      </div>
                    </div>
                  )
                }
                if (entry.kind === 'project_send') {
                  return (
                    <ProjectSendEventCard
                      key={`project-send-${entry.artifact.artifactId}`}
                      artifact={entry.artifact}
                      timeLabel={formatMessageTimeLabel(entry.artifact.createdAt)}
                      role={role}
                      onSetActive={handleSetActiveProject}
                    />
                  )
                }

                if (entry.kind === 'quote_send') {
                  return (
                    <QuoteSendEventCard
                      key="quote-send-event"
                      artifact={entry.artifact}
                      timeLabel={formatMessageTimeLabel(entry.artifact.createdAt)}
                      role={role}
                      superseded={artifacts.offerFundingSuperseded}
                    />
                  )
                }

                if (entry.kind === 'funding_step') {
                  return (
                    <div key="funding-step-event">
                      <ThreadArtifactFundingCard artifact={entry.artifact} role={role} />
                      <div className="-mt-0.5 px-5 text-[10px] text-slate-400">
                        {formatMessageTimeLabel(entry.artifact.createdAt)}
                      </div>
                    </div>
                  )
                }

                if (entry.kind === 'chat_message') {
                  const msg = entry.message
                  // Bubble keys use clientMessageId — stable across the
                  // optimistic temp_→server-id swap. Keying on msg.id
                  // remounted every sent bubble on the realtime echo.
                  const isOwn = currentUserId !== null && msg.senderUserId === currentUserId
                  const bubbleKey = msg.clientMessageId ?? msg.id

                  // Block 3: a redacted message ("Für alle" gelöscht) shows a
                  // tombstone in place of the bubble; the timestamp survives.
                  if (msg.redacted) {
                    return (
                      <MessageTombstone key={bubbleKey} createdAt={msg.createdAt} isOwnBubble={isOwn} />
                    )
                  }

                  // Long-press → delete sheet (server-confirmed rows only).
                  // "Für alle" is offered only for own messages within 15 min.
                  const canDeleteForAll = isOwn && Date.now() - msg.createdAt < UNSEND_WINDOW_MS
                  const onMessageLongPress =
                    msg.status === 'sent'
                      ? () => setDeleteTarget({ message: msg, canDeleteForAll })
                      : undefined

                  const voiceAttachment =
                    msg.messageType === 'voice'
                      ? msg.attachments?.find((a) => a.assetType === 'voice') ?? null
                      : null
                  if (voiceAttachment) {
                    const voiceClientId = msg.clientMessageId ?? ''
                    return (
                      <LongPressBubble key={bubbleKey} onLongPress={onMessageLongPress}>
                      <VoiceMessageBubble
                        attachment={voiceAttachment}
                        createdAt={msg.createdAt}
                        status={msg.status}
                        isOwnBubble={isOwn}
                        onFirstPlay={
                          isOwn
                            ? undefined
                            : () => {
                                void markThreadReadWorkflow(msg.threadId, msg.id).catch(() => undefined)
                              }
                        }
                        onRetry={
                          isOwn && voiceClientId
                            ? () => { void handleVoiceRetry(voiceClientId) }
                            : undefined
                        }
                        onDiscardFailed={
                          isOwn && voiceClientId
                            ? () => { handleVoiceDiscard(voiceClientId) }
                            : undefined
                        }
                        failedRetryCount={voiceRetryCount[voiceClientId] ?? 0}
                      />
                      </LongPressBubble>
                    )
                  }
                  const imageAttachment =
                    msg.messageType === 'image' || msg.messageType === 'mixed'
                      ? msg.attachments?.find((a) => a.assetType === 'image') ?? null
                      : null
                  if (imageAttachment) {
                    const imgClientId = msg.clientMessageId ?? ''
                    return (
                      <LongPressBubble key={bubbleKey} onLongPress={onMessageLongPress}>
                      <ImageMessageBubble
                        attachment={imageAttachment}
                        caption={msg.body}
                        createdAt={msg.createdAt}
                        status={msg.status}
                        isOwnBubble={isOwn}
                        onRetry={
                          isOwn && imgClientId
                            ? () => { void handleAttachmentRetry(imgClientId, 'photo') }
                            : undefined
                        }
                        onDiscardFailed={
                          isOwn && imgClientId
                            ? () => { handleAttachmentDiscard(imgClientId) }
                            : undefined
                        }
                        failedRetryCount={attachmentRetryCount[imgClientId] ?? 0}
                      />
                      </LongPressBubble>
                    )
                  }
                  const documentAttachment =
                    msg.messageType === 'document' || msg.messageType === 'mixed'
                      ? msg.attachments?.find((a) => a.assetType === 'document') ?? null
                      : null
                  if (documentAttachment) {
                    const docClientId = msg.clientMessageId ?? ''
                    return (
                      <LongPressBubble key={bubbleKey} onLongPress={onMessageLongPress}>
                      <DocumentMessageBubble
                        attachment={documentAttachment}
                        caption={msg.body}
                        createdAt={msg.createdAt}
                        status={msg.status}
                        isOwnBubble={isOwn}
                        onRetry={
                          isOwn && docClientId
                            ? () => { void handleAttachmentRetry(docClientId, 'document') }
                            : undefined
                        }
                        onDiscardFailed={
                          isOwn && docClientId
                            ? () => { handleAttachmentDiscard(docClientId) }
                            : undefined
                        }
                        failedRetryCount={attachmentRetryCount[docClientId] ?? 0}
                      />
                      </LongPressBubble>
                    )
                  }
                  const videoAttachment =
                    msg.messageType === 'video'
                      ? msg.attachments?.find((a) => a.assetType === 'video') ?? null
                      : null
                  if (videoAttachment) {
                    const vidClientId = msg.clientMessageId ?? ''
                    return (
                      <LongPressBubble key={bubbleKey} onLongPress={onMessageLongPress}>
                      <VideoMessageBubble
                        attachment={videoAttachment}
                        caption={msg.body}
                        createdAt={msg.createdAt}
                        status={msg.status}
                        isOwnBubble={isOwn}
                        uploadProgress={videoProgressMap[vidClientId]}
                        onRetry={
                          isOwn && vidClientId
                            ? () => { void handleVideoRetry(vidClientId) }
                            : undefined
                        }
                        onDiscardFailed={
                          isOwn && vidClientId
                            ? () => { handleVideoDiscard(vidClientId) }
                            : undefined
                        }
                        failedRetryCount={videoRetryCount[vidClientId] ?? 0}
                      />
                      </LongPressBubble>
                    )
                  }
                  const textClientId = msg.clientMessageId ?? ''
                  return (
                    <LongPressBubble key={bubbleKey} onLongPress={onMessageLongPress}>
                    <ChatBubble
                      body={msg.body ?? ''}
                      createdAt={msg.createdAt}
                      status={msg.status}
                      isOwnBubble={isOwn}
                      variant="v5"
                      messageType={msg.messageType}
                      onRetry={
                        // Gate on status==='failed' too: a message that
                        // reconciled to 'sent' (realtime echo / outbox replay
                        // landed) must NOT keep a red retry button just because
                        // a stale failedTextSends entry lingers.
                        isOwn && textClientId && msg.status === 'failed' && failedTextSends[textClientId]
                          ? () => { void handleTextRetry(textClientId) }
                          : undefined
                      }
                      onDiscard={
                        isOwn && textClientId && msg.status === 'failed' && failedTextSends[textClientId]
                          ? () => { handleTextDiscard(textClientId) }
                          : undefined
                      }
                      retryCount={failedTextSends[textClientId]?.retryCount ?? 0}
                    />
                    </LongPressBubble>
                  )
                }

                if (entry.kind === 'chat_artifact_card') {
                  const msg = entry.message
                  return (
                    <ChatArtifactCardCompact
                      key={msg.clientMessageId ?? msg.id}
                      message={msg}
                      role={role}
                      onNavigate={(path) => navigate(path)}
                      offerFundingSuperseded={artifacts.offerFundingSuperseded}
                      threadArtifacts={artifacts}
                    />
                  )
                }

                const { message } = entry
                const isSystem = message.sender === 'system'
                const isUser = !isSystem && message.sender === 'user'

                if (isSystem) {
                  return (
                    <div
                      key={message.id}
                      className="flex justify-center"
                    >
                      <div className="max-w-[85%] rounded-2xl bg-white/85 px-4 py-2 text-center text-[12.5px] text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/70 backdrop-blur-md">
                        <div>{message.text}</div>
                        <div className="mt-1 text-[10px] text-slate-400">
                          {message.createdAtLabel}
                        </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <div
                    key={message.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className="relative max-w-[74%]">
                    <div
                      className={`rounded-[20px] px-4 py-3 text-[15px] leading-relaxed shadow-[0_8px_22px_-20px_rgba(2,6,23,0.18)] ${
                        isUser
                          ? 'rounded-br-none bg-[#2563EB] text-white'
                          : 'rounded-bl-none bg-white text-slate-900 ring-1 ring-slate-200/70'
                      }`}
                    >
                      <div>{message.text}</div>
                      <div
                        className={`mt-2 text-[10px] ${
                          isUser ? 'text-white/70' : 'text-slate-400'
                        }`}
                      >
                        {message.createdAtLabel}
                      </div>
                    </div>
                    <BubbleTail side={isUser ? 'right' : 'left'} tone={isUser ? 'own' : 'peer'} />
                    </div>
                  </div>
                )
              })
            })()}
            {/* Auto-scroll anchor — sits above the section's pb-28, which
                clears the fixed composer. */}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </section>

      {thread?.isBlocked && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 bg-[#F4F6FB] px-4 pb-[max(10px,env(safe-area-inset-bottom))] pt-3"
          style={{ bottom: 'var(--keyboard-height, 0px)', transition: 'bottom 0.22s ease-out' }}
        >
          <div className="mx-auto w-full max-w-[420px] rounded-[16px] bg-slate-100 px-4 py-3 text-center text-[13px] text-slate-500">
            Dieser Nutzer ist blockiert. Du kannst keine Nachrichten senden.
          </div>
        </div>
      )}
      {!thread?.isBlocked && (
        <div
          className="fixed inset-x-0 bottom-0 z-40"
          style={{ bottom: 'var(--keyboard-height, 0px)', transition: 'bottom 0.22s ease-out' }}
        >
          <div className="mx-auto w-full max-w-[420px]">
            {projectSendError && (
              <div className="px-4 pt-2">
                <InlineFeedback
                  error={projectSendError}
                  onDismiss={() => setProjectSendError(null)}
                />
              </div>
            )}
            {chatThreadError && (
              <div className="px-4 pt-2">
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                  {chatThreadError}
                  <button
                    type="button"
                    onClick={handleChatThreadRetry}
                    className="ml-2 font-semibold underline"
                  >
                    Erneut versuchen
                  </button>
                </div>
              </div>
            )}
            <ChatComposer
              role={chatRole}
              disabled={chatThreadId === null}
              draftKey={chatThreadId !== null ? `fixup.chat.draft.${chatThreadId}` : null}
              onSendText={handleChatSend}
              onTrigger={handleTileTrigger}
              beforeSend={handleBeforeSend}
              beforeTile={handleBeforeTile}
              onSendVoice={handleVoiceSend}
              beforeVoiceSend={handleBeforeVoiceSend}
              placeholder={chatThreadId === null ? 'Wird verbunden …' : 'Nachricht schreiben …'}
            />
          </div>
          {/* Pro-Action-Gate modals — TrialStartSheet + UpgradeSheet
              rendered by hook return value. Mounted at composer level so
              the modal portal sits inside this fixed-bottom container. */}
          {sendMessageGate.modals}
          {openQuoteComposerGate.modals}
          {/* Hidden file inputs for photo/document tiles. */}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void handleAttachmentFiles(e.target.files, 'photo')}
          />
          <input
            ref={documentInputRef}
            type="file"
            accept="application/pdf,image/*,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            multiple
            className="hidden"
            onChange={(e) => void handleAttachmentFiles(e.target.files, 'document')}
          />
          {/* VideoComposerSheet — triggered by video tile. */}
          {showVideoComposer && (
            <VideoComposerSheet
              onVideoReady={(payload) => { void handleVideoSend(payload) }}
              onClose={() => setShowVideoComposer(false)}
            />
          )}
          {/* ProjectPickerSheet — triggered by project_attach tile. */}
          {showProjectPicker && (
            <ProjectPickerSheet
              projects={projects}
              onSelect={handleProjectSelect}
              onClose={() => setShowProjectPicker(false)}
            />
          )}
          {/* QuoteCreationSheet — triggered by offer tiles + diagnosis deeplink.
              Dual-path context: legacy conversation OR cutover chat thread. */}
          {showQuoteForm && threadId && (() => {
            const quoteContext = buildQuoteContext(threadId, chatThreadFromUrl)
            if (!quoteContext) return null
            return (
              <QuoteCreationSheet
                key={composerDocumentType}
                context={quoteContext}
                documentType={composerDocumentType}
                sourceDiagnosisId={composerSourceDiagnosisId}
                sourceDiagnosisRef={composerSourceDiagnosisRef}
                initialScopeSummary={composerInitialScopeSummary}
                onCreated={() => {
                  setShowQuoteForm(false)
                  setComposerSourceDiagnosisId(undefined)
                  setComposerSourceDiagnosisRef(undefined)
                  setComposerInitialScopeSummary(undefined)
                  setThread(getMessageThreadById(threadId))
                  setArtifacts(getThreadArtifacts(threadId))
                }}
                onClose={() => {
                  setShowQuoteForm(false)
                  setComposerSourceDiagnosisId(undefined)
                  setComposerSourceDiagnosisRef(undefined)
                  setComposerInitialScopeSummary(undefined)
                }}
              />
            )
          })()}
          {/* Block 3 — message-delete action sheet (long-press). */}
          {deleteTarget && (
            <MessageActionSheet
              canDeleteForAll={deleteTarget.canDeleteForAll}
              busy={deleteBusy}
              error={deleteError}
              onPick={(mode) => { void handleDeletePick(mode) }}
              onDismiss={() => {
                setDeleteTarget(null)
                setDeleteError(null)
              }}
            />
          )}
        </div>
      )}
    </AppShell>
  )
}
