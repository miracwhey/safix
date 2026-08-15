import {
  addConversation,
  getConversations,
  getConversationById,
  sendMessageToThread,
  updateConversation,
  resolveCanonicalThreadId,
} from '../messages'
import { addJob, getJobs, removeJob } from '../jobs'
import { addProject, updateProject, getProjectById } from '../projects'
import { generateProjectId } from '../projects/projectId'
import { deriveProjectStatusFromJob } from '../projects/projectStatusSync'
import type { ExploreProviderCard, ExploreReel } from '../explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../explore/exploreProfileService'
import type { ProjectCase } from '../../domain/projects/projectCaseTypes'
import { getCustomerContext } from '../customer/customerContextStore'
import { getSession } from '../session'
import { supabase } from '../supabase'
import { findCachedProviderByCategory } from '../discovery'
import { deriveSearchCriteriaFromReel } from '../explore/searchCriteriaSelectors'
import { logInfo, logWarning, logError } from '../observability'
import { fetchDiscoveryProviders } from '../discovery/discoveryService'
import { canSendRequest, recordRequestSend, MAX_DAILY_SENDS } from '../customerEntry/requestLimitService'
import { track } from '../analytics/track'
import { assertCustomerRole } from '../auth/rbacGuards'
import {
  resolveAndEnsureRelationship,
  recordInviteRelationship,
} from '../commercialAttribution/commercialAttributionService'
import type { JobCommercialOrigin } from '../commercialAttribution/types'
import { selectProvider } from '../customerEntry/guidedEntryState'
import { isChatCutoverEnabled } from '../chat/featureFlags'
import { getChatRepository } from '../chat/repository'
import type {
  ChatInquiryCriteria,
  ChatInquiryOrigin,
  ChatThreadDisplayMetadata,
} from '../chat/types'
import { createCustomerInquiryThreadWorkflow, sendMessageWorkflow } from './chatWorkflow'

// ---------------------------------------------------------------------------
// Daily request-send limit helpers
// ---------------------------------------------------------------------------

const DAILY_LIMIT_ERROR = `Tageslimit erreicht: Du kannst maximal ${MAX_DAILY_SENDS} Anfragen pro Tag senden.`

/**
 * Check the daily send limit and throw if the customer has exceeded it.
 * Skips the check if the user ID is not available (defensive — the request
 * will fail downstream on RLS anyway).
 */
async function enforceRequestLimit(customerUserId: string | undefined): Promise<void> {
  if (!customerUserId) return
  const allowed = await canSendRequest(customerUserId)
  if (!allowed) {
    throw new Error(DAILY_LIMIT_ERROR)
  }
}

// Workflow-layer RBAC guard for inquiry starts: only customers may initiate
// a "Projekt anfragen" flow. The CTA is hidden in the UI for non-customers
// (ExploreReelCard.viewerContext); this is the third defense layer alongside
// UI gates and DB RLS, matching the rbacGuards.ts contract documented at the
// top of src/lib/auth/rbacGuards.ts. Reuses the existing assertCustomerRole
// helper rather than introducing a parallel role check.

/**
 * Record a successful inquiry send against the daily limit.
 * Skips silently if the user ID is not available.
 */
async function recordInquirySend(customerUserId: string | undefined, providerId: string): Promise<void> {
  if (!customerUserId) return
  await recordRequestSend(customerUserId, providerId)
  // Funnel signal — fired here, the single recording chokepoint shared by every
  // inquiry path (reel / profile / category / project × cutover & legacy), so a
  // new inquiry is counted exactly once. After recordRequestSend so a cap-
  // exceeded throw never emits a false inquiry_created.
  track('inquiry_created', { providerId })
}

/**
 * In-memory lock to prevent duplicate inquiry starts for the same provider
 * within a single customer session.
 *
 * Keys are craftsmanHandle (unique provider identifier). Values are promises
 * representing the in-flight inquiry operation.
 *
 * When a user rapidly taps the inquiry button:
 * - First tap: creates a promise, stores it in the lock map, starts the workflow
 * - Subsequent taps: find the existing promise and await it, returning the same threadId
 * - On completion (success or failure): promise resolves/rejects, lock is released
 *
 * This prevents duplicate conversation creation without needing global architecture
 * or queue systems.
 */
const _inquiryLocks = new Map<string, Promise<string>>()

/**
 * Wraps an inquiry workflow function with an in-flight lock.
 *
 * If an inquiry for the same craftsman is already in progress, returns the
 * existing promise instead of creating a duplicate operation.
 *
 * The lock is automatically released after the operation completes (success or failure).
 */
async function withInquiryLock(
  craftsmanHandle: string,
  operation: () => Promise<string>
): Promise<string> {
  // If there's already an inquiry in flight for this craftsman, await it
  const existing = _inquiryLocks.get(craftsmanHandle)
  if (existing) {
    logInfo('workflow.inquiry.lock_hit', { craftsmanHandle })
    return existing
  }

  // Start the operation and store the promise
  const promise = (async () => {
    try {
      const threadId = await operation()
      return threadId
    } finally {
      // Always release the lock after operation completes
      _inquiryLocks.delete(craftsmanHandle)
    }
  })()

  _inquiryLocks.set(craftsmanHandle, promise)
  return promise
}

/** Fallback display name when the customer has not set one in their profile. */
const CUSTOMER_NAME_FALLBACK = 'Kunde'

/** Returns the customer's display name from context, falling back to the default. */
function resolveCustomerName(): string {
  const name = getCustomerContext().displayName.trim()
  return name.length > 0 ? name : CUSTOMER_NAME_FALLBACK
}

/** Returns the customer's avatar URL from context, or empty string if none set. */
function resolveCustomerAvatarUrl(): string {
  return getCustomerContext().avatarUrl ?? ''
}

/**
 * Returns the authenticated customer's Supabase user ID from the current
 * session, or undefined when no session is active.
 *
 * Stamped onto every new conversation so that:
 *   a) conversations/messages RLS can scope customer-side reads via
 *      customer_user_id = auth.uid()
 *   b) convertInquiryToProjectWorkflow can propagate customer ownership to
 *      the resulting job even when no source project is available (reel /
 *      profile / category inquiry paths).
 *
 * Resolution strategy:
 *   1. Fast path: read from the synchronous reactive store (getSession).
 *   2. Async fallback: if the store hasn't been hydrated yet (e.g. user
 *      clicks the CTA before refreshSession() resolves after app boot),
 *      call supabase.auth.getSession() directly so the live Supabase token
 *      is used.  Without this fallback, customer_user_id would be stamped as
 *      null and the conversations_insert_own RLS policy would reject the row.
 *
 * If the session is absent after both paths, a warning is logged and the
 * conversation will be created without a customer owner link (DB write will
 * be rejected by RLS).
 */
async function resolveCustomerUserId(): Promise<string | undefined> {
  // Fast path: reactive store already hydrated.
  const uid = getSession().user?.id
  if (uid) return uid

  // Async fallback: store not yet populated — query Supabase directly.
  const { data: { session } } = await supabase.auth.getSession()
  const asyncUid = session?.user?.id
  if (!asyncUid) {
    logWarning('workflow.inquiry.session_missing', {})
    console.warn(
      '[exploreInquiryWorkflow] No authenticated session — conversation will be created without customerUserId and the DB write will be rejected by RLS.'
    )
  }
  return asyncUid
}

/**
 * Find an existing conversation for the *current customer* and the given
 * craftsman handle, or return undefined if none exists.
 *
 * The lookup is intentionally scoped to the current user's customer UID so
 * that two separate customers messaging the same craftsman never share a
 * thread.  Without this guard, Customer B's inquiry would be silently routed
 * into Customer A's existing thread, mixing their messages.
 *
 * Accepts an explicit `customerUserId` parameter so that callers can resolve
 * the UID asynchronously (via `resolveCustomerUserId()`) BEFORE this lookup.
 * This eliminates the timing gap where `getSession().user?.id` might be
 * undefined on cold-start while DB-loaded conversations already carry a
 * `customerUserId`, causing a false "no existing thread" result and a
 * duplicate conversation.
 *
 * Matching rules:
 *   • customerUserId provided → match handle AND customerUserId === uid
 *   • customerUserId absent   → match handle AND c.customerUserId is absent
 *
 * Post-reload safety: the SupabaseMessageRepository loads conversations
 * filtered by the authenticated user's UID (via RLS), so after a page
 * refresh only the current customer's own conversations are in memory.
 * The UID check here provides defence-in-depth for within-session scenarios
 * (e.g. user switch without page reload) and for the InMemory repository
 * used in tests.
 */
function findExistingThreadForCraftsman(
  craftsmanHandle: string,
  customerUserId?: string
): string | undefined {
  const uid = customerUserId ?? getSession().user?.id ?? undefined
  const conversations = getConversations()
  const matches = conversations.filter(
    (c) =>
      c.craftsmanHandle === craftsmanHandle &&
      (uid != null ? c.customerUserId === uid : c.customerUserId == null)
  )

  if (matches.length === 0) return undefined

  // When multiple conversations exist for the same pair (legacy data or
  // race conditions), return the canonical winner — the most recently
  // created one.  This is the same rule used by
  // deduplicateConversationsByPair so inbox, thread view, and write
  // paths all agree on the same canonical conversation.
  let canonical = matches[0]
  for (let i = 1; i < matches.length; i++) {
    if ((matches[i].createdAt ?? 0) > (canonical.createdAt ?? 0)) {
      canonical = matches[i]
    }
  }

  return canonical.id
}

// ---------------------------------------------------------------------------
// Chat-Cutover path (VITE_CHAT_UI_CUTOVER_CUSTOMER): inquiries write to
// chat_threads instead of legacy conversations. Legacy path stays untouched
// behind the flag until the conversations retire (Slice E).
// ---------------------------------------------------------------------------

/**
 * Chat-domain twin of findExistingThreadForCraftsman: the most recently
 * created open customer-channel thread for the current customer ↔ craftsman
 * pair. Keyed by craftsmanUserId (uuid) — chat threads carry no handle.
 * The server-side reuse in rpc_get_or_create_chat_customer_thread covers the
 * cold-cache window where this lookup misses.
 */
function findExistingChatThreadForCraftsman(
  craftsmanUserId: string,
  customerUserId?: string,
): string | undefined {
  const uid = customerUserId ?? getSession().user?.id ?? undefined
  if (!uid) return undefined
  const matches = getChatRepository()
    .getThreads('customer')
    .filter(
      (t) =>
        t.craftsmanUserId === craftsmanUserId &&
        t.customerUserId === uid &&
        t.closedAt == null,
    )
  if (matches.length === 0) return undefined
  let canonical = matches[0]
  for (let i = 1; i < matches.length; i++) {
    if ((matches[i].createdAt ?? 0) > (canonical.createdAt ?? 0)) {
      canonical = matches[i]
    }
  }
  return canonical.id
}

interface StartChatInquiryInput {
  craftsmanUserId: string
  customerUserId?: string
  title: string
  inquiryOrigin: ChatInquiryOrigin
  sourceProjectId?: string | null
  inquiryCriteria?: ChatInquiryCriteria | null
  displayMetadata: ChatThreadDisplayMetadata
  logEvent: string
}

/**
 * Shared chat-path inquiry start: dedup → daily limit → thread create (RPC,
 * cache-seeded) → limit record. Mirrors the legacy per-entry-point sequence;
 * callers run inside withInquiryLock and have already passed
 * assertCustomerRole().
 */
async function startChatInquiry(input: StartChatInquiryInput): Promise<string> {
  const existing = findExistingChatThreadForCraftsman(
    input.craftsmanUserId,
    input.customerUserId,
  )
  if (existing) return existing

  await enforceRequestLimit(input.customerUserId)

  const threadId = await createCustomerInquiryThreadWorkflow({
    craftsmanUserId: input.craftsmanUserId,
    title: input.title,
    inquiryOrigin: input.inquiryOrigin,
    sourceProjectId: input.sourceProjectId ?? null,
    inquiryCriteria: input.inquiryCriteria ?? null,
    displayMetadata: input.displayMetadata,
  })

  await recordInquirySend(input.customerUserId, input.craftsmanUserId)

  logInfo(input.logEvent, { threadId, craftsmanId: input.craftsmanUserId })

  return threadId
}

/**
 * Start an inquiry from an explore reel.
 *
 * - If a conversation for the same craftsman already exists, reuse it.
 * - Otherwise create a new conversation and send an opening message
 *   pre-populated with context from the reel.
 *
 * Protected by an in-flight lock to prevent duplicate conversations from
 * rapid repeated taps.
 *
 * Returns the thread ID that should be navigated to.
 */
export async function startReelInquiryWorkflow(reel: ExploreReel): Promise<string> {
  assertCustomerRole()
  return withInquiryLock(reel.craftsmanHandle, async () => {
    // Resolve customerUserId FIRST so the reuse lookup uses the same
    // identity that will be stamped on any new conversation.  This
    // eliminates the cold-start timing gap where the session store
    // hasn't hydrated yet but DB-loaded conversations already carry
    // a customerUserId.
    const customerUserId = await resolveCustomerUserId()

    if (isChatCutoverEnabled('customer')) {
      return startChatInquiry({
        craftsmanUserId: reel.craftsmanId,
        customerUserId,
        title: reel.title,
        inquiryOrigin: 'reel',
        inquiryCriteria: deriveSearchCriteriaFromReel(reel) ?? null,
        displayMetadata: {
          customerName: resolveCustomerName(),
          customerAvatarUrl: resolveCustomerAvatarUrl(),
          craftsmanName: reel.craftsmanName,
          craftsmanHandle: reel.craftsmanHandle,
          craftsmanAvatarUrl: reel.craftsmanAvatarUrl,
          projectTitle: reel.title,
          projectSubtitle: 'Neue Anfrage',
          projectLocation: reel.location,
          projectCostRange: reel.costLabel,
          projectDuration: reel.durationLabel,
          projectStatusLabel: 'Anfrage läuft',
          syntheticProjectId: `project_explore_${reel.craftsmanId}_${crypto.randomUUID()}`,
        },
        logEvent: 'workflow.inquiry.reel_started',
      })
    }

    const existing = findExistingThreadForCraftsman(reel.craftsmanHandle, customerUserId)
    if (existing) return existing

    await enforceRequestLimit(customerUserId)

    const inquiryCriteria = deriveSearchCriteriaFromReel(reel)
    const threadId = crypto.randomUUID()
    const projectId = `project_explore_${reel.craftsmanId}_${threadId}`

    await addConversation({
      id: threadId,
      projectId,
      customerName: resolveCustomerName(),
      customerAvatarUrl: resolveCustomerAvatarUrl(),
      craftsmanName: reel.craftsmanName,
      craftsmanHandle: reel.craftsmanHandle,
      craftsmanAvatarUrl: reel.craftsmanAvatarUrl,
      craftsmanUserId: reel.craftsmanId,
      projectTitle: reel.title,
      projectSubtitle: 'Neue Anfrage',
      projectLocation: reel.location,
      projectCostRange: reel.costLabel,
      projectDuration: reel.durationLabel,
      projectStatusLabel: 'Anfrage läuft',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'reel',
      ...(inquiryCriteria != null && { inquiryCriteria }),
      ...(customerUserId != null && { customerUserId }),
    })

    // No auto-text: the customer should type manually.
    // Inquiry context is carried as conversation metadata (projectTitle,
    // projectLocation, etc.) and visible in the thread header.

    await recordInquirySend(customerUserId, reel.craftsmanId)

    logInfo('workflow.inquiry.reel_started', { threadId, craftsmanId: reel.craftsmanId })

    return threadId
  })
}

/**
 * Start an inquiry from a craftsman profile screen.
 *
 * - If a conversation for this craftsman already exists, reuse it.
 * - Otherwise create a new conversation with a generic opening message.
 *
 * Protected by an in-flight lock to prevent duplicate conversations from
 * rapid repeated taps.
 *
 * Returns the thread ID that should be navigated to.
 */
export async function startProfileInquiryWorkflow(
  profile: ExploreCraftsmanProfile
): Promise<string> {
  assertCustomerRole()
  return withInquiryLock(profile.craftsmanHandle, async () => {
    const customerUserId = await resolveCustomerUserId()

    if (isChatCutoverEnabled('customer')) {
      return startChatInquiry({
        craftsmanUserId: profile.craftsmanId,
        customerUserId,
        title: `Anfrage an ${profile.craftsmanName}`,
        inquiryOrigin: 'profile',
        displayMetadata: {
          customerName: resolveCustomerName(),
          customerAvatarUrl: resolveCustomerAvatarUrl(),
          craftsmanName: profile.craftsmanName,
          craftsmanHandle: profile.craftsmanHandle,
          craftsmanAvatarUrl: profile.craftsmanAvatarUrl,
          projectTitle: `Anfrage an ${profile.craftsmanName}`,
          projectSubtitle: 'Neue Anfrage',
          projectLocation: profile.location,
          projectStatusLabel: 'Anfrage läuft',
          syntheticProjectId: `project_profile_${profile.craftsmanId}_${crypto.randomUUID()}`,
        },
        logEvent: 'workflow.inquiry.profile_started',
      })
    }

    const existing = findExistingThreadForCraftsman(profile.craftsmanHandle, customerUserId)
    if (existing) return existing

    await enforceRequestLimit(customerUserId)

    const threadId = crypto.randomUUID()
    const projectId = `project_profile_${profile.craftsmanId}_${threadId}`

    logInfo('workflow.inquiry.profile_start', {
      threadId,
      craftsmanId: profile.craftsmanId,
      customerUserId: customerUserId ?? '(none)',
    })

    await addConversation({
      id: threadId,
      projectId,
      customerName: resolveCustomerName(),
      customerAvatarUrl: resolveCustomerAvatarUrl(),
      craftsmanName: profile.craftsmanName,
      craftsmanHandle: profile.craftsmanHandle,
      craftsmanAvatarUrl: profile.craftsmanAvatarUrl,
      craftsmanUserId: profile.craftsmanId,
      projectTitle: `Anfrage an ${profile.craftsmanName}`,
      projectSubtitle: 'Neue Anfrage',
      projectLocation: profile.location,
      projectStatusLabel: 'Anfrage läuft',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'profile',
      ...(customerUserId != null && { customerUserId }),
    })

    // No auto-text: the customer should type manually.
    // The thread opens directly for immediate conversation.
    // (Empty-thread UX hint is rendered in MessageThreadScreen.)

    await recordInquirySend(customerUserId, profile.craftsmanId)

    return threadId
  })
}

/**
 * Convert an inquiry thread into a structured project/job.
 *
 * - Looks up the conversation by threadId.
 * - If the conversation already has a backing job, returns the existing job ID.
 * - Otherwise creates a new job in 'new' state linked to the conversation's projectId,
 *   updates the conversation's status label, and sends a system message.
 *
 * Returns the new or existing job ID, or null if the thread is not found.
 */
/**
 * Normalised view over the two inquiry sources (legacy conversation row or
 * chat_threads row) — exactly the fields the conversion body reads.
 */
interface InquiryConversionSource {
  projectId: string
  projectTitle: string
  customerName: string
  craftsmanName: string
  projectLocation?: string
  projectCostRange?: string
  projectDescription?: string
  projectDuration?: string
  inquiryOrigin?: 'reel' | 'profile' | 'category' | 'project' | null
  sourceProjectId?: string
  craftsmanUserId?: string
  customerUserId?: string
}

export async function convertInquiryToProjectWorkflow(threadId: string): Promise<string | null> {
  // Cutover-Contract R3: ALWAYS check both domains by lookup — a craftsman can
  // convert an old legacy request and a new chat-thread request in the same
  // session, independent of the flag state.
  const legacyConversation = getConversationById(threadId)
  const chatThread = legacyConversation ? undefined : getChatRepository().getThread(threadId)
  const isChatThreadConversion = !legacyConversation && chatThread?.inquiryOrigin != null

  const conversation: InquiryConversionSource | undefined =
    legacyConversation ??
    (isChatThreadConversion
      ? {
          projectId:
            chatThread!.displayMetadata?.syntheticProjectId ?? `inquiry_${threadId}`,
          projectTitle:
            chatThread!.displayMetadata?.projectTitle ?? chatThread!.title ?? 'Anfrage',
          customerName: chatThread!.displayMetadata?.customerName ?? 'Kunde',
          craftsmanName: chatThread!.displayMetadata?.craftsmanName ?? '',
          projectLocation: chatThread!.displayMetadata?.projectLocation ?? undefined,
          projectCostRange: chatThread!.displayMetadata?.projectCostRange ?? undefined,
          projectDescription: chatThread!.displayMetadata?.projectDescription ?? undefined,
          projectDuration: chatThread!.displayMetadata?.projectDuration ?? undefined,
          inquiryOrigin: chatThread!.inquiryOrigin,
          sourceProjectId: chatThread!.sourceProjectId ?? undefined,
          craftsmanUserId: chatThread!.craftsmanUserId ?? undefined,
          customerUserId: chatThread!.customerUserId ?? undefined,
        }
      : undefined)

  if (!conversation) {
    logWarning('workflow.inquiry.entity_missing', { threadId })
    return null
  }

  // Primary idempotency guard: sourceConversationId is the reload-safe canonical
  // back-link from job to thread.  It is persisted as source_conversation_id so it
  // survives page reload — unlike conversation.projectId, which changes from the
  // synthetic placeholder to source_project_id (or '') after a Supabase round-trip.
  const existingByConversation = getJobs().find((j) => j.sourceConversationId === threadId)
  if (existingByConversation) return existingByConversation.id

  // Legacy fallback: jobs created before source_conversation_id was added use
  // the synthetic projectId as the only linkage.  Only apply when projectId is
  // non-empty to avoid a false match against jobs that also have '' as projectId.
  if (conversation.projectId) {
    const existingByProjectId = getJobs().find((j) => j.projectId === conversation.projectId)
    if (existingByProjectId) return existingByProjectId.id
  }

  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const jobId = `job_inquiry_${uid}`

  // Look up the source project before creating the job so we can propagate
  // the customer's auth UID.  This is the canonical path for builder-origin
  // inquiries where the project was created by an authenticated customer and
  // carries a customerUserId stamped at creation time.
  const sourceProject = conversation.sourceProjectId
    ? getProjectById(conversation.sourceProjectId)
    : undefined

  if (conversation.sourceProjectId && !sourceProject) {
    console.warn(
      `[convertInquiryToProjectWorkflow] sourceProjectId '${conversation.sourceProjectId}' not found — ` +
        `customer ownership will fall back to conversation.customerUserId ('${conversation.customerUserId ?? 'none'}') for job '${jobId}'`
    )
  }

  // Resolve the commercial origin for this customer↔craftsman pair before
  // creating the job so it can be stamped at creation time.
  //
  // Resolution priority (inside resolveAndEnsureRelationship):
  //   1. Existing relationship in session cache
  //   2. Existing Supabase record (e.g. pre-created by recordInviteRelationship
  //      during the customer's guided-entry session — merchant_brought path)
  //   3. Infer from inquiryOrigin → always platform_acquired as safe default
  //
  // The resolved origin is immutable once written to customer_provider_relationships.
  // Subsequent jobs between the same pair inherit the same origin automatically.
  const resolvedCustomerUserId = (sourceProject?.customerUserId ?? conversation.customerUserId) ?? null
  let commercialOrigin: JobCommercialOrigin | undefined
  if (resolvedCustomerUserId != null && conversation.craftsmanUserId != null) {
    commercialOrigin = await resolveAndEnsureRelationship(
      resolvedCustomerUserId,
      conversation.craftsmanUserId,
      { inquiryOrigin: conversation.inquiryOrigin ?? null }
    )
  }

  await addJob({
    id: jobId,
    projectId: conversation.projectId,
    title: conversation.projectTitle,
    customer: conversation.customerName,
    location: conversation.projectLocation ?? 'Ort folgt',
    dateLabel: 'Termin offen',
    status: 'new',
    amount: conversation.projectCostRange ?? '',
    description: `Anfrage über SaFix – ${conversation.projectTitle}. Bitte Details mit dem Kunden abstimmen.`,
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    // Explicit reverse link: the conversation thread that spawned this job.
    // Enables server-side lookups (e.g. notifications) to resolve the thread
    // without scanning all conversations by projectId.
    sourceConversationId: threadId,
    ...(conversation.craftsmanUserId != null && { craftsmanUserId: conversation.craftsmanUserId }),
    // Propagate the customer owner link using a priority chain:
    //   1. sourceProject.customerUserId – builder-origin path (project created
    //      by an authenticated customer via createProjectFromBuilderWorkflow)
    //   2. conversation.customerUserId  – all other inquiry paths (reel, profile,
    //      category) stamped at conversation-creation time from the session UID
    // Together these cover all real inquiry→job conversion paths.
    ...((sourceProject?.customerUserId ?? conversation.customerUserId) != null && {
      customerUserId: (sourceProject?.customerUserId ?? conversation.customerUserId) as string,
    }),
    // Stamp the resolved commercial origin so fee logic never needs to re-infer.
    // Also stamp attributionStatus so the payment gate can enforce the invariant
    // without re-reading commercial_origin string values.
    ...(commercialOrigin != null && { commercialOrigin }),
    ...(commercialOrigin != null && {
      attributionStatus: commercialOrigin === 'unknown_pending_resolution'
        ? ('pending' as const)
        : ('finalized' as const),
    }),
    intakeContext: {
      origin:
        conversation.inquiryOrigin === 'reel'
          ? 'inquiry_reel'
          : conversation.inquiryOrigin === 'project'
            ? 'inquiry_project'
            : conversation.inquiryOrigin === 'category'
              ? 'inquiry_category'
              : conversation.inquiryOrigin === 'profile'
                ? 'inquiry_profile'
                : 'direct',
      originLabel:
        conversation.inquiryOrigin === 'reel'
          ? 'Explore-Reel'
          : conversation.inquiryOrigin === 'project'
            ? 'Projektanfrage'
            : conversation.inquiryOrigin === 'category'
              ? 'Kategorieanfrage'
              : conversation.inquiryOrigin === 'profile'
                ? 'Handwerkerprofil'
                : 'Direkt',
      ...(conversation.projectDescription != null && {
        requestDescription: conversation.projectDescription,
      }),
      requestLocation: conversation.projectLocation,
      requestBudget: conversation.projectCostRange,
      requestDuration: conversation.projectDuration,
    },
    activities: [
      {
        id: `act_${uid}`,
        type: 'system',
        text: 'Auftrag aus Anfrage erstellt.',
        createdAtLabel: 'Jetzt',
      },
    ],
  })

  // Link the originating builder project to the newly created job so that
  // CustomerProjectDetailScreen can transition from builder mode to job lifecycle.
  // Also set craftsmanUserId on the project so that ownership-based RLS policies
  // can scope project reads and writes by the craftsman's auth UID.
  //
  // Compensation guard: if the project write step throws, remove the job that was
  // just persisted so we do not leave behind an orphaned job with no backing project.
  try {
    if (conversation.sourceProjectId) {
      const linked = await updateProject(conversation.sourceProjectId, {
        sourceJobId: jobId,
        ...(conversation.craftsmanUserId != null && { craftsmanUserId: conversation.craftsmanUserId }),
      })
      if (!linked) {
        // The source project could not be found — the job→project link cannot be
        // established.  Throw so the compensation block below removes the orphaned
        // job instead of returning a false success to the caller.
        throw new Error(
          `[convertInquiryToProjectWorkflow] sourceProjectId '${conversation.sourceProjectId}' not found — project→job link not established for job '${jobId}'`
        )
      }
    } else if (conversation.inquiryOrigin === 'profile') {
      // Profile-origin inquiries: do NOT create an auto-project at conversion
      // time.  A profile inquiry starts as a conversation only.  The real
      // canonical project is created at offer-acceptance time via
      // ensureProjectForAcceptedOffer (offerWorkflow.ts).
      //
      // Creating an auto-project here produced a "fake project shell" that:
      //   - showed as a raw Anfrage on customer home
      //   - rendered a project card in thread before any real project existed
      //   - blocked the craftsman with "project incomplete" intake gating
      //
      // Deferring project creation to acceptance keeps the flow clean:
      //   conversation → offer → acceptance → real project + job linkage.
      logInfo('workflow.inquiry.profile_skip_auto_project', { jobId, threadId })
    } else {
      // Non-builder, non-profile inquiry paths (reel, category) create an
      // auto-project now so that:
      //   1. CustomerProjectDetailScreen can display project/job status for the
      //      customer after the craftsman accepts.
      //   2. getProjectByJobId(jobId) returns a real entity, enabling the
      //      "Projekt öffnen →" link in thread artifact cards for customers.
      //   3. The customer can track their project after a page reload because
      //      SupabaseProjectRepository loads projects scoped by customer_user_id
      //      via RLS.
      //
      // The craftsman is the caller at this point (auth.uid() = craftsmanUserId),
      // so the INSERT satisfies projects_insert_own (craftsman_user_id = auth.uid()).
      // The customer gains SELECT access because customer_user_id is also set.
      const autoProjectId = generateProjectId()
      const customerUserId = sourceProject?.customerUserId ?? conversation.customerUserId
      // Derive initial project status from the canonical job state instead of
      // hardcoding 'accepted'.  The job was just created with status:'new' and
      // no proposal timestamps, so deriveProjectStatusFromJob yields 'request'.
      // This ensures customer home, project detail, and thread all tell the
      // same story from the very start — no split-brain between project
      // saying 'accepted' while job says 'new inquiry'.
      const derivedStatus = deriveProjectStatusFromJob({
        status: 'new',
        proposalSentAt: undefined,
        proposalAcceptedAt: undefined,
      })
      await addProject({
        id: autoProjectId,
        sourceJobId: jobId,
        title: conversation.projectTitle,
        customer: conversation.customerName,
        craftsman: conversation.craftsmanName,
        location: conversation.projectLocation ?? 'Ort folgt',
        dateLabel: 'Termin offen',
        price: '',
        status: derivedStatus,
        paymentState: 'deposit_required',
        messageCount: 0,
        noteCount: 0,
        photoCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: 'inquiry',
        ...(conversation.projectDescription != null && { description: conversation.projectDescription }),
        ...(conversation.projectCostRange != null && { requestedBudget: conversation.projectCostRange }),
        ...(conversation.craftsmanUserId != null && { craftsmanUserId: conversation.craftsmanUserId }),
        ...(customerUserId != null && { customerUserId }),
        // Inherit the same commercial origin as the linked job.
        ...(commercialOrigin != null && { commercialOrigin }),
      })
      logInfo('workflow.inquiry.auto_project_created', { jobId, projectId: autoProjectId })
    }
  } catch (projectError) {
    // Project write failed after job was already persisted.  Remove the job to
    // avoid a permanent orphaned-job / missing-project half-state.
    logError('workflow.inquiry.project_write_failed', projectError, { threadId, jobId })
    await removeJob(jobId)
    throw projectError
  }

  if (isChatThreadConversion) {
    // Chat path: the inbox derives "converted" from the job linkage
    // (sourceConversationId = chat-thread id) — no status-label write needed.
    // The notice goes out as a craftsman message (caller is the craftsman);
    // CHAT-3 push delivery to the customer is intentional here.
    sendMessageWorkflow({
      threadId,
      body: 'Ihre Anfrage wurde als Projekt aufgenommen. Ein Handwerker meldet sich in Kürze bei Ihnen.',
      clientMessageId: crypto.randomUUID(),
      callerRole: 'craftsman',
      currentUserId: getSession().user?.id ?? null,
    }).catch((err) => logError('workflow.inquiry.system_message_failed', err, { threadId }))
  } else {
    // Stamp the conversation so both parties see the updated status label.
    updateConversation(threadId, {
      projectStatusLabel: 'Auftrag erstellt',
    })

    sendMessageToThread(
      threadId,
      `Ihre Anfrage wurde als Projekt aufgenommen. Ein Handwerker meldet sich in Kürze bei Ihnen.`,
      'system'
    ).catch((err) => logError('workflow.inquiry.system_message_failed', err, { threadId }))
  }

  logInfo('workflow.inquiry.converted', { threadId, jobId })

  return jobId
}

/**
 * Start a service request directly from the customer's profile.
 *
 * Finds a real Discovery provider from the in-memory cache that best matches
 * the requested service category, then creates a pre-seeded inquiry
 * conversation using the customer's profile context and the entered request
 * description.
 *
 * Cache miss resilience:
 * - First attempts to find provider in the in-memory cache (populated by
 *   Discovery screens when they load provider cards).
 * - If cache is empty, performs a one-time fallback fetch from the database
 *   to find a matching provider.
 * - If no provider can be resolved after both attempts, throws an error with
 *   a clear message instead of returning null silently.
 *
 * If a conversation with a matching craftsman already exists, it is reused
 * and the new request description is sent as a follow-up message.
 *
 * Returns the thread ID to navigate to.
 * Throws an error when no provider is available (cache miss + DB fallback miss).
 */
export async function startCategoryInquiryWorkflow(
  category: string,
  description: string,
  location: string,
  sourceProjectId?: string
): Promise<string> {
  assertCustomerRole()
  let provider = findCachedProviderByCategory(category)

  // Cache miss fallback: attempt one direct DB read
  if (!provider) {
    logWarning('workflow.inquiry.cache_miss', { category, operation: 'startCategoryInquiryWorkflow' })

    // Bound the DB fallback to 2 s so that a hanging Supabase connection
    // (test environment, no network, cold start) fails fast rather than
    // silently blocking until the Vitest 5 s timeout fires.
    const allProviders = await Promise.race([
      fetchDiscoveryProviders(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2000)
      ),
    ]).catch(() => [] as import('../discovery').DiscoveryProvider[])
    if (allProviders.length === 0) {
      logError('workflow.inquiry.no_providers_available', new Error('No discovery providers available'), { category })
      throw new Error(
        `Keine Handwerker verfügbar. Bitte versuche es später erneut oder kontaktiere den Support.`
      )
    }

    // Apply same matching logic as the cache
    const norm = (s: string) => s.trim().toLowerCase()
    const catNorm = norm(category)

    // Convert DiscoveryProvider to ExploreProviderCard format
    const providerCards: ExploreProviderCard[] = allProviders.map(p => ({
      craftsmanId: p.profileId,
      craftsmanName: p.displayName || p.companyName,
      craftsmanHandle: `provider-${p.profileId}`,
      craftsmanAvatarUrl: p.avatarUrl ?? undefined,
      location: p.city || '',
      primaryCategory: p.tradeCategories[0] || category,
      tradeCategories: p.tradeCategories,
      servicesOffered: [],
      serviceRadiusKm: 50,
    }))

    // Exact match
    provider = providerCards.find((p) =>
      p.tradeCategories.some((t) => norm(t) === catNorm)
    ) ?? null

    // Partial match
    if (!provider) {
      provider = providerCards.find((p) =>
        p.tradeCategories.some(
          (t) => norm(t).includes(catNorm) || catNorm.includes(norm(t))
        )
      ) ?? null
    }

    // General fallback: first available provider
    if (!provider && providerCards.length > 0) {
      provider = providerCards[0]
    }

    if (!provider) {
      logError('workflow.inquiry.provider_match_failed', new Error('No matching provider found'), { category })
      throw new Error(
        `Kein passender Handwerker für "${category}" gefunden. Bitte versuche eine andere Kategorie.`
      )
    }

    logInfo('workflow.inquiry.cache_fallback_success', { category, providerId: provider.craftsmanId })
  }

  return await startCategoryInquiryWorkflowFromProvider(
    category,
    description,
    location,
    provider,
    sourceProjectId
  )
}

/**
 * Start a category inquiry against an explicitly provided real provider card.
 *
 * Used by the Search screen (where the provider is already selected from
 * search results) and by startCategoryInquiryWorkflow (which resolves the
 * provider from the Discovery cache first).
 *
 * - If a conversation for the same craftsman already exists, appends the new
 *   request as a follow-up message.
 * - Otherwise creates a new conversation pre-seeded with the request context.
 *
 * Protected by an in-flight lock to prevent duplicate conversations from
 * rapid repeated taps.
 *
 * Returns the thread ID to navigate to.
 */
export async function startCategoryInquiryWorkflowFromProvider(
  category: string,
  description: string,
  location: string,
  provider: ExploreProviderCard,
  sourceProjectId?: string
): Promise<string> {
  assertCustomerRole()
  return withInquiryLock(provider.craftsmanHandle, async () => {
    const resolvedLocation = location.trim() || provider.location

    const customerUserId = await resolveCustomerUserId()

    if (isChatCutoverEnabled('customer')) {
      return startChatInquiry({
        craftsmanUserId: provider.craftsmanId,
        customerUserId,
        title: `${category}-Anfrage`,
        inquiryOrigin: 'category',
        sourceProjectId: sourceProjectId ?? null,
        displayMetadata: {
          customerName: resolveCustomerName(),
          customerAvatarUrl: resolveCustomerAvatarUrl(),
          craftsmanName: provider.craftsmanName,
          craftsmanHandle: provider.craftsmanHandle,
          craftsmanAvatarUrl: provider.craftsmanAvatarUrl ?? '',
          projectTitle: `${category}-Anfrage`,
          projectSubtitle: 'Neue Anfrage',
          projectDescription: description,
          projectLocation: resolvedLocation,
          projectStatusLabel: 'Anfrage läuft',
          syntheticProjectId: `project_category_${provider.craftsmanId}_${crypto.randomUUID()}`,
        },
        logEvent: 'workflow.inquiry.category_started',
      })
    }

    const existing = findExistingThreadForCraftsman(provider.craftsmanHandle, customerUserId)
    if (existing) {
      // Reuse the canonical thread — no auto-text.  The customer can type
      // their own message if they want to communicate something new.
      return existing
    }

    await enforceRequestLimit(customerUserId)

    const threadId = crypto.randomUUID()
    const projectId = `project_category_${provider.craftsmanId}_${threadId}`

    await addConversation({
      id: threadId,
      projectId,
      customerName: resolveCustomerName(),
      customerAvatarUrl: resolveCustomerAvatarUrl(),
      craftsmanName: provider.craftsmanName,
      craftsmanHandle: provider.craftsmanHandle,
      craftsmanAvatarUrl: provider.craftsmanAvatarUrl ?? '',
      craftsmanUserId: provider.craftsmanId,
      projectTitle: `${category}-Anfrage`,
      projectSubtitle: 'Neue Anfrage',
      projectLocation: resolvedLocation,
      projectStatusLabel: 'Anfrage läuft',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'category',
      projectDescription: description,
      ...(sourceProjectId != null && { sourceProjectId }),
      ...(customerUserId != null && { customerUserId }),
    })

    // No auto-text: the customer should type manually.
    // Inquiry context is carried as conversation metadata (projectTitle,
    // projectDescription, projectLocation) and visible in the thread header.

    await recordInquirySend(customerUserId, provider.craftsmanId)

    return threadId
  })
}

/**
 * Start an inquiry from a search result card using a structured builder project.
 *
 * - Attaches the project's title, category, description, budget and timing to
 *   the conversation so the craftsman receives full project context.
 * - If a conversation for the same craftsman already exists, appends a
 *   project-context message to the existing thread.
 * - Sets inquiryOrigin to 'project' and records the sourceProjectId for
 *   downstream conversion.
 *
 * Protected by an in-flight lock to prevent duplicate conversations from
 * rapid repeated taps.
 *
 * Returns the thread ID to navigate to.
 */
export async function startProjectInquiryWorkflow(
  project: ProjectCase,
  reel: ExploreReel
): Promise<string> {
  assertCustomerRole()
  return withInquiryLock(reel.craftsmanHandle, async () => {
    const customerUserId = await resolveCustomerUserId()

    if (isChatCutoverEnabled('customer')) {
      return startChatInquiry({
        craftsmanUserId: reel.craftsmanId,
        customerUserId,
        title: project.title,
        inquiryOrigin: 'project',
        sourceProjectId: project.id,
        displayMetadata: {
          customerName: resolveCustomerName(),
          customerAvatarUrl: resolveCustomerAvatarUrl(),
          craftsmanName: reel.craftsmanName,
          craftsmanHandle: reel.craftsmanHandle,
          craftsmanAvatarUrl: reel.craftsmanAvatarUrl,
          projectTitle: project.title,
          projectSubtitle: project.category ?? 'Projektanfrage',
          projectDescription: project.description ?? null,
          projectLocation: project.location,
          projectCostRange: project.requestedBudget,
          projectDuration: project.requestedTiming ?? null,
          projectStatusLabel: 'Anfrage läuft',
          syntheticProjectId: `project_inquiry_${reel.craftsmanId}_${crypto.randomUUID()}`,
        },
        logEvent: 'workflow.inquiry.project_started',
      })
    }

    const existing = findExistingThreadForCraftsman(reel.craftsmanHandle, customerUserId)
    if (existing) {
      // Reuse the canonical thread — no auto-text.  Project context is
      // conveyed via project attachment cards, not fake customer messages.
      return existing
    }

    await enforceRequestLimit(customerUserId)

    const threadId = crypto.randomUUID()
    const conversationProjectId = `project_inquiry_${reel.craftsmanId}_${threadId}`

    await addConversation({
      id: threadId,
      projectId: conversationProjectId,
      customerName: resolveCustomerName(),
      customerAvatarUrl: resolveCustomerAvatarUrl(),
      craftsmanName: reel.craftsmanName,
      craftsmanHandle: reel.craftsmanHandle,
      craftsmanAvatarUrl: reel.craftsmanAvatarUrl,
      craftsmanUserId: reel.craftsmanId,
      projectTitle: project.title,
      projectSubtitle: project.category ?? 'Projektanfrage',
      projectLocation: project.location,
      projectCostRange: project.requestedBudget,
      projectStatusLabel: 'Anfrage läuft',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'project',
      sourceProjectId: project.id,
      ...(project.description != null && { projectDescription: project.description }),
      ...(project.requestedTiming != null && { projectDuration: project.requestedTiming }),
      ...(customerUserId != null && { customerUserId }),
    })

    // No auto-text: the customer should type manually.
    // Project context is carried as conversation metadata and project
    // attachment cards, not fake customer messages.

    await recordInquirySend(customerUserId, reel.craftsmanId)

    return threadId
  })
}

/**
 * Mark an incoming inquiry thread as reviewed by the craftsman.
 *
 * Called when a craftsman opens an inquiry thread for the first time. This:
 * - Clears the unread count so the badge disappears.
 * - Records a `reviewedAt` timestamp so the triage status transitions from
 *   `new_unread` to `needs_response` in the request inbox.
 *
 * Resolves to the canonical conversation for the pair so the review mark
 * is always written to the master thread, not a stale duplicate.
 *
 * Only operates on threads that originated from an inquiry flow.
 */
export function markRequestReviewedWorkflow(threadId: string): void {
  // Dual-path by lookup, NOT by flag (Cutover-Contract R3): a thread that
  // exists in the chat cache is a chat_threads inquiry regardless of the
  // flag state; legacy conversation ids fall through to the legacy path.
  const chatThread = getChatRepository().getThread(threadId)
  if (chatThread) {
    if (!chatThread.inquiryOrigin) return
    if (chatThread.reviewedAt) return // already reviewed – no-op
    getChatRepository()
      .updateThreadInquiryState(threadId, { reviewedAt: Date.now() })
      .catch((err) => logError('workflow.inquiry.review_persist_failed', err, { threadId }))
    return
  }

  const canonicalId = resolveCanonicalThreadId(threadId)
  const conversation = getConversationById(canonicalId)
  if (!conversation) return
  if (!conversation.inquiryOrigin) return
  if (conversation.reviewedAt) return // already reviewed – no-op

  updateConversation(canonicalId, {
    reviewedAt: Date.now(),
    unreadCount: 0,
  })
}

/**
 * Decline an incoming inquiry request on behalf of the craftsman.
 *
 * - Sends a polite decline message to the customer (as the craftsman/counterparty).
 * - Marks the conversation as declined so it is removed from the craftsman's
 *   request inbox without being converted to a structured job.
 *
 * Resolves to the canonical conversation for the pair so the decline state
 * is always written to the master thread, not a stale duplicate.
 *
 * Only operates on threads that originated from an inquiry flow.
 */
const DECLINE_MESSAGE =
  'Vielen Dank für Ihre Anfrage. Leider können wir diesen Auftrag zum jetzigen Zeitpunkt nicht annehmen. Ich wünsche Ihnen viel Erfolg bei Ihrem Vorhaben.'

export function declineRequestWorkflow(threadId: string): void {
  // Dual-path by lookup, NOT by flag (Cutover-Contract R3).
  const chatThread = getChatRepository().getThread(threadId)
  if (chatThread) {
    if (!chatThread.inquiryOrigin) return
    const now = Date.now()
    // Decline message as the craftsman (current user). Fire-and-forget like
    // the legacy path — the decline state is written regardless.
    sendMessageWorkflow({
      threadId,
      body: DECLINE_MESSAGE,
      clientMessageId: crypto.randomUUID(),
      callerRole: 'craftsman',
      currentUserId: getSession().user?.id ?? null,
    }).catch((err) =>
      logError('workflow.inquiry.decline_message_failed', err, { threadId }),
    )
    getChatRepository()
      .updateThreadInquiryState(threadId, { reviewedAt: now, declinedAt: now })
      .catch((err) =>
        logError('workflow.inquiry.decline_persist_failed', err, { threadId }),
      )
    logInfo('workflow.inquiry.declined', { threadId })
    return
  }

  const canonicalId = resolveCanonicalThreadId(threadId)
  const conversation = getConversationById(canonicalId)
  if (!conversation) return
  if (!conversation.inquiryOrigin) return

  // Send a polite decline message from the craftsman side.
  // sendMessageToThread already resolves canonical internally, but we pass
  // the canonical ID explicitly for consistency.
  // .catch() prevents an unhandled rejection — the decline state is written
  // regardless of whether the message send succeeds.
  sendMessageToThread(
    canonicalId,
    DECLINE_MESSAGE,
    'counterparty'
  ).catch((err) => logError('workflow.inquiry.decline_message_failed', err, { threadId: canonicalId }))

  updateConversation(canonicalId, {
    reviewedAt: conversation.reviewedAt ?? Date.now(),
    declinedAt: Date.now(),
    projectStatusLabel: 'Abgelehnt',
    unreadCount: 0,
  })

  logInfo('workflow.inquiry.declined', { threadId })
}

/**
 * Start an inquiry from a search result using a structured builder project and
 * a real ExploreProviderCard (i.e. from real provider-card-based matching).
 *
 * Equivalent to startProjectInquiryWorkflow but accepts ExploreProviderCard
 * instead of ExploreReel, enabling the search flow to work with real provider
 * data without depending on mock reel structures.
 *
 * Protected by an in-flight lock to prevent duplicate conversations from
 * rapid repeated taps.
 *
 * Returns the thread ID to navigate to.
 */
export async function startProjectInquiryWorkflowFromProvider(
  project: ProjectCase,
  provider: ExploreProviderCard
): Promise<string> {
  assertCustomerRole()
  return withInquiryLock(provider.craftsmanHandle, async () => {
    const customerUserId = await resolveCustomerUserId()

    if (isChatCutoverEnabled('customer')) {
      return startChatInquiry({
        craftsmanUserId: provider.craftsmanId,
        customerUserId,
        title: project.title,
        inquiryOrigin: 'project',
        sourceProjectId: project.id,
        displayMetadata: {
          customerName: resolveCustomerName(),
          customerAvatarUrl: resolveCustomerAvatarUrl(),
          craftsmanName: provider.craftsmanName,
          craftsmanHandle: provider.craftsmanHandle,
          craftsmanAvatarUrl: provider.craftsmanAvatarUrl ?? '',
          projectTitle: project.title,
          projectSubtitle: project.category ?? 'Projektanfrage',
          projectDescription: project.description ?? null,
          projectLocation: project.location,
          projectCostRange: project.requestedBudget,
          projectDuration: project.requestedTiming ?? null,
          projectStatusLabel: 'Anfrage läuft',
          syntheticProjectId: `project_inquiry_${provider.craftsmanId}_${crypto.randomUUID()}`,
        },
        logEvent: 'workflow.inquiry.project_started',
      })
    }

    const existing = findExistingThreadForCraftsman(provider.craftsmanHandle, customerUserId)
    if (existing) {
      // Reuse the canonical thread — no auto-text.  Project context is
      // conveyed via project attachment cards, not fake customer messages.
      return existing
    }

    await enforceRequestLimit(customerUserId)

    const threadId = crypto.randomUUID()
    const conversationProjectId = `project_inquiry_${provider.craftsmanId}_${threadId}`

    await addConversation({
      id: threadId,
      projectId: conversationProjectId,
      customerName: resolveCustomerName(),
      customerAvatarUrl: resolveCustomerAvatarUrl(),
      craftsmanName: provider.craftsmanName,
      craftsmanHandle: provider.craftsmanHandle,
      craftsmanAvatarUrl: provider.craftsmanAvatarUrl ?? '',
      craftsmanUserId: provider.craftsmanId,
      projectTitle: project.title,
      projectSubtitle: project.category ?? 'Projektanfrage',
      projectLocation: project.location,
      projectCostRange: project.requestedBudget,
      projectStatusLabel: 'Anfrage läuft',
      timeLabel: 'Jetzt',
      unreadCount: 0,
      inquiryOrigin: 'project',
      sourceProjectId: project.id,
      ...(project.description != null && { projectDescription: project.description }),
      ...(project.requestedTiming != null && { projectDuration: project.requestedTiming }),
      ...(customerUserId != null && { customerUserId }),
    })

    // No auto-text: the customer should type manually.
    // Project context is carried as conversation metadata and project
    // attachment cards, not fake customer messages.

    await recordInquirySend(customerUserId, provider.craftsmanId)

    return threadId
  })
}

// ---------------------------------------------------------------------------
// Invited guided-entry provider selection
// ---------------------------------------------------------------------------

/**
 * Wire the invited guided-entry provider selection to both the guided-entry
 * state machine and the durable commercial attribution record.
 *
 * Called when a customer in path='invited' taps "Betrieb auswählen" on a
 * provider card in SearchScreen (mode='provider').
 *
 * Side effects (in order):
 *   1. Advances the guided-entry state machine to 'provider_selected'.
 *      selectProvider() guards against non-invited paths internally.
 *   2. Persists a merchant_brought / invite relationship for this
 *      customer↔craftsman pair so that subsequent inquiry→job conversion
 *      deterministically produces commercial_origin = merchant_brought
 *      without guessing from inquiryOrigin signals.
 *
 * Immutability guarantee: recordInviteRelationship uses ON CONFLICT DO NOTHING
 * plus a session cache — a pre-existing relationship is never reclassified.
 *
 * Returns true on success; false if the customer is not authenticated or if
 * the state machine transition fails (e.g. not currently in the invited path).
 */
export async function selectInvitedProviderWorkflow(
  craftsmanUserId: string
): Promise<boolean> {
  const customerUserId = await resolveCustomerUserId()
  if (!customerUserId) return false

  const selected = await selectProvider(craftsmanUserId)
  if (!selected) return false

  await recordInviteRelationship(customerUserId, craftsmanUserId)
  return true
}
