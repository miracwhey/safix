/**
 * Thread Artifact Truth Trace
 *
 * Runtime diagnosis and truth-enforcement module.
 *
 * Exposes:
 * - Whether project/offer artifacts are confirmed from persisted remote state
 * - Last write result / error for sendProjectAttachmentToThread, createOfferWorkflow,
 *   acceptOfferWorkflow
 * - Full debug snapshot of thread truth: auth user, conversation, project, offer,
 *   job, and payment state as observed from persisted sources
 *
 * This module is intentionally a temporary debug/diagnostic layer to identify
 * the real broken layer in the write → persist → rehydrate chain.
 */

import type { Conversation } from './types'
import type { Offer } from '../offers/types'
import type { PaymentState } from '../shared/coreTypes'

// ── Write result tracking ──────────────────────────────────────────────────

export type WriteOperation =
  | 'sendProjectAttachmentToThread'
  | 'createOfferWorkflow'
  | 'acceptOfferWorkflow'

export type WriteResult = {
  operation: WriteOperation
  timestamp: number
  success: boolean
  error?: string
  /** Key facts from the write (e.g. the offer ID, project ID that was persisted) */
  detail?: Record<string, unknown>
}

const writeResults: WriteResult[] = []

const MAX_WRITE_RESULTS = 20

export function recordWriteResult(result: WriteResult): void {
  writeResults.push(result)
  // Keep only last MAX_WRITE_RESULTS results to avoid unbounded growth
  while (writeResults.length > MAX_WRITE_RESULTS) writeResults.shift()
}

export function getWriteResults(): ReadonlyArray<WriteResult> {
  return writeResults
}

export function getLastWriteResult(operation: WriteOperation): WriteResult | undefined {
  for (let i = writeResults.length - 1; i >= 0; i--) {
    if (writeResults[i].operation === operation) return writeResults[i]
  }
  return undefined
}

export function clearWriteResults(): void {
  writeResults.length = 0
}

// ── Persistence confirmation ───────────────────────────────────────────────

export type PersistenceStatus = 'confirmed' | 'unconfirmed' | 'missing'

/**
 * Checks whether a project artifact's backing linkage is confirmed from
 * persisted remote state.
 *
 * Resolution order (mirrors threadArtifactSelectors PRIMARY → MIGRATION):
 * 1. thread_artifacts record — canonical first-class source
 * 2. conversation.sourceProjectId — migration path (auto-backfills to PRIMARY)
 *
 * Old split-brain paths (conversation.projectId UUID, message attachments)
 * are intentionally excluded: they were phantom paths that never backfilled
 * and caused cards to disappear after reload.
 */
export function checkProjectArtifactPersistence(
  conversation: Conversation | undefined,
  projectExists: (id: string) => boolean,
  threadArtifactProjectId?: string | null
): PersistenceStatus {
  if (!conversation) return 'missing'
  // PRIMARY: thread_artifacts record is the canonical source.
  if (threadArtifactProjectId && projectExists(threadArtifactProjectId)) {
    return 'confirmed'
  }
  // MIGRATION: sourceProjectId (auto-backfills to PRIMARY on first read).
  if (conversation.sourceProjectId && projectExists(conversation.sourceProjectId)) {
    return 'confirmed'
  }
  return 'unconfirmed'
}

/**
 * Checks whether an offer artifact is confirmed from persisted remote state.
 *
 * An offer artifact is "confirmed" when there is at least one offer row
 * in the store for this conversation.
 */
export function checkOfferArtifactPersistence(
  offers: Offer[]
): PersistenceStatus {
  if (offers.length === 0) return 'missing'
  return 'confirmed'
}

// ── Full truth trace snapshot ──────────────────────────────────────────────

export type TruthTraceSnapshot = {
  // Auth / scope
  authUserId: string | null

  // Conversation
  conversationId: string
  conversationSourceProjectId: string | null
  sourceProjectIdResolvesToRealProject: boolean

  // Project artifact
  projectArtifactPersistenceStatus: PersistenceStatus
  projectArtifactProjectId: string | null

  // Offers
  offerCount: number
  offers: Array<{
    id: string
    status: string
    createdJobId: string | null
  }>
  offerArtifactPersistenceStatus: PersistenceStatus

  // Job context
  resolvedJobId: string | null
  resolvedPaymentState: PaymentState | null

  // Write results
  lastWriteResults: {
    sendProjectAttachmentToThread: WriteResult | undefined
    createOfferWorkflow: WriteResult | undefined
    acceptOfferWorkflow: WriteResult | undefined
  }
}

/**
 * Builds a full truth trace snapshot for a conversation thread.
 *
 * This is the primary diagnostic output — it shows exactly what the runtime
 * sees and whether artifacts come from confirmed persisted links or fallback
 * paths.
 */
export function buildTruthTraceSnapshot(params: {
  authUserId: string | null
  conversation: Conversation | undefined
  projectExists: (id: string) => boolean
  projectArtifactProjectId: string | null
  offers: Offer[]
  resolvedJobId: string | null
  resolvedPaymentState: PaymentState | null
}): TruthTraceSnapshot {
  const {
    authUserId,
    conversation,
    projectExists,
    projectArtifactProjectId,
    offers,
    resolvedJobId,
    resolvedPaymentState,
  } = params

  const conversationId = conversation?.id ?? '(none)'
  const sourceProjectId = conversation?.sourceProjectId ?? null

  return {
    authUserId,
    conversationId,
    conversationSourceProjectId: sourceProjectId,
    sourceProjectIdResolvesToRealProject:
      sourceProjectId ? projectExists(sourceProjectId) : false,

    projectArtifactPersistenceStatus: checkProjectArtifactPersistence(
      conversation,
      projectExists,
      projectArtifactProjectId
    ),
    projectArtifactProjectId,

    offerCount: offers.length,
    offers: offers.map((o) => ({
      id: o.id,
      status: o.status,
      createdJobId: o.createdJobId ?? null,
    })),
    offerArtifactPersistenceStatus: checkOfferArtifactPersistence(offers),

    resolvedJobId,
    resolvedPaymentState,

    lastWriteResults: {
      sendProjectAttachmentToThread: getLastWriteResult('sendProjectAttachmentToThread'),
      createOfferWorkflow: getLastWriteResult('createOfferWorkflow'),
      acceptOfferWorkflow: getLastWriteResult('acceptOfferWorkflow'),
    },
  }
}
