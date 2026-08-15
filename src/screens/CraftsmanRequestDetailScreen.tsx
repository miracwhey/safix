/**
 * CraftsmanRequestDetailScreen — Pre-Job Request Detail (Level 2)
 *
 * Full request detail view for the craftsman BEFORE a job has been created.
 * This is the destination for the "Details ansehen →" CTA on sent project
 * cards and the "Projekt öffnen →" link in the top context bar when the
 * project has no sourceJobId yet.
 *
 * Once a job exists, the craftsman navigates to CraftsmanJobDetailScreen
 * instead (/craftsman/jobs/:jobId).
 *
 * Resolution chain:
 *   1. Full project entity from the project store (fast path).
 *   2. Thread artifact snapshot data for the projectId (fallback).
 *      This covers cases where the project entity hasn't been loaded
 *      yet (e.g. craftsman doesn't have the entity in their store but
 *      the artifact snapshot was persisted at send time).
 *   3. Chat-thread cache for the projectId (Cutover Slice D). Dual-path
 *      by lookup, not by flag: with the craftsman cutover active the chat
 *      cache is preferred over (2), otherwise it is the last resort —
 *      chat-native inquiries have no legacy artifact rows at all.
 *   4. "Anfrage nicht gefunden" only when genuinely no data exists.
 *
 * This screen is read-only — it does NOT mutate thread state, active
 * project state, or any other part of the thread artifact model.
 *
 * Route: /craftsman/request/:projectId
 */

import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { Star } from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { Icon } from '../components/primitives'
import RequestDetailView from '../components/projects/RequestDetailView'
import type { RequestDetailData } from '../components/projects/RequestDetailView'
import CraftsmanRequestSpatialSection from '../components/spatial/provider/CraftsmanRequestSpatialSection'
import { subscribeProjects, getProjectById, ensureProjectLoaded, isProjectRepositoryHydrated } from '../lib/projects'
import {
  findArtifactRecordsByProjectId,
  getConversationByProjectId,
  getProjectHauptprojektStatus,
  getRequestQualityForConversation,
  isMessageRepositoryHydrated,
  subscribeThreadArtifacts,
} from '../lib/messages'
import {
  getChatRepository,
  getThreadByLegacyConversationId,
  isChatCutoverEnabled,
  useChatHydrated,
  useChatMessages,
  type ChatThreadViewModel,
} from '../lib/chat'
import { getRequestQualityForThread } from '../lib/chat/requestInboxSelectors'

// Block D Slice 2 M2: `subscribeMessages` + `subscribeThreadArtifacts`
// retained inside the effect below — they cover conversation-row updates
// and thread_artifacts mutations that the chat domain does not surface
// (e.g. intake flow patching projectDescription without a new message).
// Chat-domain reactivity is additive: `useChatMessages` re-runs the effect
// on every new chat message; the legacy subscriptions cover orthogonal
// store mutations. Plan §5a "preserve enrichWithConversationContext".

/**
 * Builds a display-data object from thread artifact snapshot fields.
 * Used when the full project entity isn't available in the project store.
 */
function resolveFromArtifactSnapshot(projectId: string): RequestDetailData | undefined {
  const records = findArtifactRecordsByProjectId(projectId)
  if (records.length === 0) return undefined

  // Use the most recently created artifact record for the freshest snapshot.
  // Sort explicitly by createdAt to avoid depending on insertion order.
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)
  const record = sorted[sorted.length - 1]
  if (!record.snapshotTitle) return undefined

  return {
    title: record.snapshotTitle,
    status: record.snapshotStatus ?? 'request',
    ...(record.snapshotCategory != null && { category: record.snapshotCategory }),
    ...(record.snapshotSummary != null && { description: record.snapshotSummary }),
    ...(record.snapshotLocation != null && { location: record.snapshotLocation }),
    ...(record.snapshotBudget != null && { requestedBudget: record.snapshotBudget }),
    ...(record.snapshotTiming != null && { requestedTiming: record.snapshotTiming }),
  }
}

/**
 * Finds the chat thread that carries this project's inquiry context.
 * Matches the real `sourceProjectId` (project inquiries) or the synthetic
 * project id stamped into the display metadata at inquiry-creation time
 * (profile/category/reel inquiries without a real projects row).
 */
function findChatThreadForProject(projectId: string): ChatThreadViewModel | undefined {
  return getChatRepository()
    .getThreads('customer')
    .find(
      (t) =>
        t.sourceProjectId === projectId ||
        t.displayMetadata?.syntheticProjectId === projectId,
    )
}

/**
 * Builds a display-data object from the chat-thread cache (Cutover Slice D).
 * Chat twin of `resolveFromArtifactSnapshot` for threads whose request
 * context lives in `displayMetadata` / `inquiryCriteria` instead of a
 * legacy artifact record.
 */
function resolveFromChatThread(projectId: string): RequestDetailData | undefined {
  const thread = findChatThreadForProject(projectId)
  if (!thread) return undefined

  const md = thread.displayMetadata
  const criteria = thread.inquiryCriteria
  const description = md?.projectDescription ?? criteria?.description
  const location = md?.projectLocation ?? criteria?.location
  const budget = md?.projectCostRange ?? criteria?.budget
  const timing = md?.projectDuration ?? criteria?.timing

  return {
    title: md?.projectTitle ?? thread.title ?? 'Anfrage',
    status: 'request',
    ...(criteria?.category != null && { category: criteria.category }),
    ...(description != null && { description }),
    ...(location != null && { location }),
    ...(budget != null && { requestedBudget: budget }),
    ...(timing != null && { requestedTiming: timing }),
  }
}

/**
 * Enriches a base RequestDetailData with conversation metadata.
 *
 * The conversation carries request context that may not be present in
 * the project entity or artifact snapshot — particularly `projectDescription`
 * (from category inquiries) and `inquiryCriteria` (from reel inquiries).
 * This fills in gaps so the craftsman request detail shows richer information.
 */
function enrichWithConversationContext(
  base: RequestDetailData,
  projectId: string
): RequestDetailData {
  const conversation = getConversationByProjectId(projectId)
  if (!conversation) return base

  const enriched = { ...base }

  // Fill description from conversation if the base doesn't have one
  if (!enriched.description) {
    if (conversation.projectDescription) {
      enriched.description = conversation.projectDescription
    } else if (conversation.inquiryCriteria?.description) {
      enriched.description = conversation.inquiryCriteria.description
    }
  }

  // Fill location from conversation if the base doesn't have one
  if (!enriched.location && conversation.projectLocation) {
    enriched.location = conversation.projectLocation
  }
  if (!enriched.location && conversation.inquiryCriteria?.location) {
    enriched.location = conversation.inquiryCriteria.location
  }

  // Fill category from inquiry criteria if not already set
  if (!enriched.category && conversation.inquiryCriteria?.category) {
    enriched.category = conversation.inquiryCriteria.category
  }

  // Fill budget from conversation or inquiry criteria
  if (!enriched.requestedBudget && conversation.projectCostRange) {
    enriched.requestedBudget = conversation.projectCostRange
  }
  if (!enriched.requestedBudget && conversation.inquiryCriteria?.budget) {
    enriched.requestedBudget = conversation.inquiryCriteria.budget
  }

  // Fill timing from conversation or inquiry criteria
  if (!enriched.requestedTiming && conversation.projectDuration) {
    enriched.requestedTiming = conversation.projectDuration
  }
  if (!enriched.requestedTiming && conversation.inquiryCriteria?.timing) {
    enriched.requestedTiming = conversation.inquiryCriteria.timing
  }

  return enriched
}

/**
 * Resolves request detail data from the best available source.
 * Full project entity is preferred; artifact snapshot is the fallback.
 * In both cases, conversation metadata enriches the result with
 * additional context (description, inquiry criteria) when available.
 */
function resolveRequestDetail(projectId: string): RequestDetailData | undefined {
  // Fast path: full project entity
  const project = getProjectById(projectId)
  if (project) return enrichWithConversationContext(project, projectId)

  // Snapshot fallback is dual-path by lookup, not by flag: with the
  // craftsman cutover active the chat cache is the primary snapshot source
  // and the legacy artifact snapshot the safety net — otherwise today's
  // order is kept with the chat cache as last resort (chat-native inquiries
  // have no legacy artifact rows).
  const snapshot = isChatCutoverEnabled('craftsman')
    ? (resolveFromChatThread(projectId) ?? resolveFromArtifactSnapshot(projectId))
    : (resolveFromArtifactSnapshot(projectId) ?? resolveFromChatThread(projectId))
  if (snapshot) return enrichWithConversationContext(snapshot, projectId)

  return undefined
}

export default function CraftsmanRequestDetailScreen() {
  const { projectId } = useParams()
  const goBack = useSmartBack('/craftsman/messages')
  const [detail, setDetail] = useState<RequestDetailData | undefined>(() =>
    projectId ? resolveRequestDetail(projectId) : undefined
  )

  // Chat-domain reactive trigger (Block D Slice 2 M2). Resolves the chat
  // thread for this project's conversation; new chat_messages or thread
  // updates re-run the effect below so refresh() picks them up. The
  // conversation snapshot itself is still read read-only from lib/messages
  // — chat owns transport, conversations still own request context.
  // Cutover Slice D: chat-native inquiry threads have no legacy conversation
  // row — fall back to a project-id lookup in the chat cache so the trigger
  // and the quality score below cover both eras (dual-path by lookup).
  const conversationForProject = projectId ? getConversationByProjectId(projectId) : null
  const chatThread =
    getThreadByLegacyConversationId(conversationForProject?.id) ??
    (projectId ? findChatThreadForProject(projectId) : undefined)
  const chatMessages = useChatMessages(chatThread?.id)
  const isChatHydrated = useChatHydrated()

  // Deterministic loaded decision:
  //   - detail found → loaded
  //   - detail not found AND repos hydrated → loaded (will render "not found")
  //   - detail not found AND repos NOT hydrated → stay loading
  // Note: with the cutover OFF, `isChatHydrated` is a refresh trigger, not a
  // readiness gate — a chat-domain that has not finished hydrating must not
  // flip valid legacy detail into "loading" or block the canonical "not
  // found" path. With the cutover ON, the chat cache is a primary source, so
  // its hydration gates the "not found" verdict too.
  const [loaded, setLoaded] = useState(() => {
    if (detail) return true
    return (
      isProjectRepositoryHydrated() &&
      isMessageRepositoryHydrated() &&
      (!isChatCutoverEnabled('craftsman') || getChatRepository().isHydrated())
    )
  })

  // Track whether this project is the customer's active Hauptprojekt.
  const [isHauptprojekt, setIsHauptprojekt] = useState(() =>
    projectId ? (getProjectHauptprojektStatus(projectId)?.isActive ?? false) : false
  )

  useEffect(() => {
    if (!projectId) return

    const refresh = () => {
      const found = resolveRequestDetail(projectId)
      setDetail(found)
      setIsHauptprojekt(getProjectHauptprojektStatus(projectId)?.isActive ?? false)
      if (
        found ||
        (isProjectRepositoryHydrated() &&
          isMessageRepositoryHydrated() &&
          (!isChatCutoverEnabled('craftsman') || getChatRepository().isHydrated()))
      ) {
        setLoaded(true)
      }
    }

    const unsubProjects = subscribeProjects(refresh)
    const unsubArtifacts = subscribeThreadArtifacts(refresh)
    // Cutover Slice D: the chat cache is a primary source — thread-level
    // updates (display metadata, lazy per-thread hydration) must re-resolve
    // even when no new chat message re-runs this effect.
    const unsubChat = isChatCutoverEnabled('craftsman')
      ? getChatRepository().subscribe(refresh)
      : undefined
    // Recipient may reach this screen (card tap / push deep-link) for a project
    // shared into a chat thread but absent from their owner-scoped cache. Lazy-
    // fetch by id; RLS (projects_select_shared_in_chat_thread) decides access.
    // On success subscribeProjects(refresh) re-resolves the primary path.
    if (!getProjectById(projectId)) {
      void ensureProjectLoaded(projectId)
    }
    refresh()

    return () => {
      unsubProjects()
      unsubArtifacts()
      unsubChat?.()
    }
  }, [projectId, chatMessages, isChatHydrated])

  // Auto-redirect to job detail when this request has been converted into a job.
  // The request detail screen represents pre-job state; once a job exists,
  // CraftsmanJobDetailScreen is the canonical owner of this context.
  const projectEntity = projectId ? getProjectById(projectId) : undefined
  if (projectEntity?.sourceJobId) {
    return <Navigate to={`/craftsman/jobs/${projectEntity.sourceJobId}`} replace />
  }

  if (!detail && !loaded) {
    return (
      <AppShell active="messages">
        <ScreenSkeleton variant="detail" eyebrow="Anfrage" />
      </AppShell>
    )
  }

  if (!detail) {
    return (
      <AppShell active="messages">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
            <div className="text-[18px] font-semibold text-slate-900">
              Anfrage nicht gefunden
            </div>
            <div className="mt-2 text-[14px] text-slate-500">
              Die Anfrage konnte nicht geladen werden.
            </div>
          </div>
        </section>
      </AppShell>
    )
  }

  // Intrinsic quality score, derived from the same source as the inbox tier
  // badge so both surfaces agree. Computed only on the success path (after the
  // loading / not-found / redirect early returns), and recomputed on
  // chat-message changes via the render trigger above.
  // Dual-path: with the cutover active the chat thread is the primary source
  // (same scorer as the chat inbox); the other domain fills the gap so a
  // request resolved by either path never loses its quality section.
  const qualityFromConversation = conversationForProject
    ? getRequestQualityForConversation(conversationForProject)
    : undefined
  const qualityFromThread = chatThread
    ? getRequestQualityForThread(chatThread)
    : undefined
  const quality = isChatCutoverEnabled('craftsman')
    ? (qualityFromThread ?? qualityFromConversation)
    : (qualityFromConversation ?? qualityFromThread)

  return (
    <AppShell active="messages">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center rounded-full bg-white px-4 py-2 text-[14px] font-semibold text-slate-700 ring-1 ring-slate-200/70 shadow-[0_12px_28px_-24px_rgba(2,6,23,0.35)]"
          >
            ← Zurück
          </button>

          {/* ── Full request detail (Level 2) ── */}
          <RequestDetailView project={detail} qualityScore={quality} />

          {/* ── V1.5.1 Phase B · Customer direct-shared Self-Scan preview ── */}
          <CraftsmanRequestSpatialSection
            customerUserId={projectEntity?.customerUserId ?? null}
          />

          {/* ── Hauptprojekt status (read-only for craftsman) ── */}
          {isHauptprojekt && (
            <div
              className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]"
              data-testid="hauptprojekt-status-section"
            >
              <div
                className="flex items-center gap-2 rounded-card bg-warn/5 px-4 py-3 ring-1 ring-warn/20"
                data-testid="hauptprojekt-active-badge"
              >
                <Icon icon={Star} size="sm" className="shrink-0 text-warn" />
                <span className="text-[14px] font-semibold text-ink">
                  Hauptprojekt des Kunden
                </span>
              </div>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  )
}
