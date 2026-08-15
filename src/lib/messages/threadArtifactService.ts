/**
 * Thread Artifact Service
 *
 * Write-side operations for first-class persisted thread artifact records.
 * Each function creates or updates a canonical artifact row that binds a
 * business entity (project, offer, payment phase) to a conversation.
 *
 * Read-side: threadArtifactSelectors.ts uses these records as the PRIMARY
 * source of truth, falling back to derived paths only for migration.
 */

import type { ArtifactType, ThreadArtifactRecord } from './threadArtifactRecord'
import { getThreadArtifactRepository } from './repository/threadArtifactRegistry'

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateArtifactId(type: ArtifactType, conversationId: string): string {
  return `ta_${type}_${conversationId}_${crypto.randomUUID()}`
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns all persisted artifact records for a conversation.
 */
export function getThreadArtifactRecords(
  conversationId: string
): ThreadArtifactRecord[] {
  return getThreadArtifactRepository().getByConversationId(conversationId)
}

/**
 * Returns all persisted project artifact records that reference a given projectId.
 *
 * Scans the full artifact cache — O(n) where n is the total number of artifact
 * records.  This is acceptable for client-side usage (cache limited to ~500
 * records by the Supabase query limit).
 *
 * Used by the craftsman pre-job request detail screen to resolve snapshot data
 * when the full project entity is not available in the project store.
 */
export function findArtifactRecordsByProjectId(
  projectId: string
): ThreadArtifactRecord[] {
  return getThreadArtifactRepository()
    .getAll()
    .filter((r) => r.artifactType === 'project' && r.projectId === projectId)
}

/**
 * Returns a single persisted artifact record by conversation + type.
 */
export function getThreadArtifactRecord(
  conversationId: string,
  type: ArtifactType
): ThreadArtifactRecord | undefined {
  return getThreadArtifactRepository().getByConversationAndType(
    conversationId,
    type
  )
}

/**
 * Persists a project artifact record for a conversation.
 *
 * Each call creates a NEW append-only artifact record — multiple project
 * cards can coexist in the same thread.  This is the multi-send model:
 * each send produces a new visible project-card event.
 *
 * Snapshot fields are written at persist time so the card can render
 * immediately without waiting for the project repository to hydrate.
 */
export async function persistProjectArtifact(params: {
  conversationId: string
  projectId: string
  customerUserId?: string
  craftsmanUserId?: string
  snapshotTitle?: string
  snapshotStatus?: string
  snapshotSummary?: string
  snapshotCategory?: string
  snapshotLocation?: string
  snapshotBudget?: string
  snapshotTiming?: string
}): Promise<void> {
  const now = Date.now()

  const record: ThreadArtifactRecord = {
    id: generateArtifactId('project', params.conversationId),
    conversationId: params.conversationId,
    artifactType: 'project',
    projectId: params.projectId,
    snapshotTitle: params.snapshotTitle,
    snapshotStatus: params.snapshotStatus,
    snapshotSummary: params.snapshotSummary,
    snapshotCategory: params.snapshotCategory,
    snapshotLocation: params.snapshotLocation,
    snapshotBudget: params.snapshotBudget,
    snapshotTiming: params.snapshotTiming,
    customerUserId: params.customerUserId,
    craftsmanUserId: params.craftsmanUserId,
    createdAt: now,
    updatedAt: now,
  }

  await getThreadArtifactRepository().insert(record)
}

/**
 * Persists an offer artifact record for a conversation.
 *
 * Called by createOfferWorkflow when a craftsman creates an offer.
 * Returns a Promise that resolves when canonical persistence is confirmed,
 * or rejects on write failure.
 *
 * Snapshot fields are written at persist time so the card can render
 * immediately without waiting for the offer repository to hydrate.
 */
export async function persistOfferArtifact(params: {
  conversationId: string
  offerId: string
  phase: string
  jobId?: string
  customerUserId?: string
  craftsmanUserId?: string
  snapshotPrice?: string
  snapshotSummary?: string
  snapshotPhaseLabel?: string
  /** Commercial document type snapshot (Paket 4b). */
  snapshotDocumentType?: string
  /** Offer version snapshot (Paket 4b). */
  snapshotVersion?: number
  /** Offer validity date snapshot ISO-8601 (Paket 4b). */
  snapshotValidUntil?: string
}): Promise<void> {
  const now = Date.now()
  const existing = getThreadArtifactRepository().getByConversationAndType(
    params.conversationId,
    'offer'
  )

  const record: ThreadArtifactRecord = {
    id: existing?.id ?? generateArtifactId('offer', params.conversationId),
    conversationId: params.conversationId,
    artifactType: 'offer',
    offerId: params.offerId,
    phase: params.phase,
    jobId: params.jobId ?? existing?.jobId,
    snapshotPrice: params.snapshotPrice ?? existing?.snapshotPrice,
    snapshotSummary: params.snapshotSummary ?? existing?.snapshotSummary,
    snapshotPhaseLabel: params.snapshotPhaseLabel ?? existing?.snapshotPhaseLabel,
    snapshotDocumentType: params.snapshotDocumentType ?? existing?.snapshotDocumentType,
    snapshotVersion: params.snapshotVersion ?? existing?.snapshotVersion,
    snapshotValidUntil: params.snapshotValidUntil ?? existing?.snapshotValidUntil,
    customerUserId: params.customerUserId ?? existing?.customerUserId,
    craftsmanUserId: params.craftsmanUserId ?? existing?.craftsmanUserId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Persists a payment-phase artifact record for a conversation.
 *
 * Called by acceptOfferWorkflow when an offer is accepted and payment
 * becomes actionable.  Returns a Promise that resolves when canonical
 * persistence is confirmed, or rejects on write failure.
 *
 * Snapshot fields are written at persist time so the card can render
 * immediately without waiting for the payment repository to hydrate.
 */
export async function persistPaymentPhaseArtifact(params: {
  conversationId: string
  jobId: string
  offerId?: string
  phase: string
  customerUserId?: string
  craftsmanUserId?: string
  snapshotPhaseLabel?: string
  snapshotPrice?: string
}): Promise<void> {
  const now = Date.now()
  const existing = getThreadArtifactRepository().getByConversationAndType(
    params.conversationId,
    'payment_phase'
  )

  const record: ThreadArtifactRecord = {
    id:
      existing?.id ??
      generateArtifactId('payment_phase', params.conversationId),
    conversationId: params.conversationId,
    artifactType: 'payment_phase',
    jobId: params.jobId,
    offerId: params.offerId ?? existing?.offerId,
    phase: params.phase,
    snapshotPhaseLabel: params.snapshotPhaseLabel ?? existing?.snapshotPhaseLabel,
    snapshotPrice: params.snapshotPrice ?? existing?.snapshotPrice,
    customerUserId: params.customerUserId ?? existing?.customerUserId,
    craftsmanUserId: params.craftsmanUserId ?? existing?.craftsmanUserId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Updates the phase of an existing offer artifact for a conversation.
 *
 * Called by acceptOfferWorkflow / declineOfferWorkflow to transition
 * the offer artifact through its lifecycle.  Returns a Promise that resolves
 * when canonical persistence is confirmed, or rejects on write failure.
 *
 * Snapshot phase label is updated alongside the phase so the card displays
 * the correct status label immediately.
 */
export async function updateOfferArtifactPhase(
  conversationId: string,
  phase: string,
  updates?: { jobId?: string; offerId?: string; snapshotPhaseLabel?: string }
): Promise<void> {
  const existing = getThreadArtifactRepository().getByConversationAndType(
    conversationId,
    'offer'
  )
  if (!existing) return

  const record: ThreadArtifactRecord = {
    ...existing,
    phase,
    ...(updates?.jobId != null && { jobId: updates.jobId }),
    ...(updates?.offerId != null && { offerId: updates.offerId }),
    ...(updates?.snapshotPhaseLabel != null && { snapshotPhaseLabel: updates.snapshotPhaseLabel }),
    updatedAt: Date.now(),
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Updates the phase of an existing funding_step artifact for a conversation.
 *
 * Analogous to updateOfferArtifactPhase — called by funding lifecycle
 * workflows (customerFundingEntryWorkflow, confirmFundingWorkflow, etc.)
 * to persist canonical funding phase progression to the artifact record.
 *
 * Idempotent: no-op when the artifact does not exist or is already at the
 * target phase.  Returns a Promise that resolves when canonical persistence
 * is confirmed, or rejects on write failure.
 *
 * Snapshot phase label is updated alongside the phase so the card displays
 * the correct status label immediately.
 */
export async function updateFundingArtifactPhase(
  conversationId: string,
  phase: string,
  updates?: { snapshotPhaseLabel?: string }
): Promise<void> {
  const existing = getThreadArtifactRepository().getByConversationAndType(
    conversationId,
    'funding_step'
  )
  if (!existing) return

  // Idempotent: skip if already at the target phase
  if (existing.phase === phase) return

  const record: ThreadArtifactRecord = {
    ...existing,
    phase,
    ...(updates?.snapshotPhaseLabel != null && { snapshotPhaseLabel: updates.snapshotPhaseLabel }),
    updatedAt: Date.now(),
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Persists a ChangeOrder (Nachtrag) artifact record for a conversation.
 *
 * Each ChangeOrder produces a NEW append-only artifact record — multiple
 * ChangeOrder cards can coexist in the same thread.  Uses a deterministic
 * record ID keyed to the changeOrderId so that subsequent status updates
 * (accept/decline/cancel) can upsert the same record.
 *
 * Snapshot fields are written at persist time so the card can render
 * immediately without waiting for the ChangeOrder repository to hydrate.
 */
export async function persistChangeOrderArtifact(params: {
  conversationId: string
  changeOrderId: string
  jobId: string
  phase: string
  customerUserId?: string
  craftsmanUserId?: string
  snapshotDeltaAmount?: string
  snapshotDescription?: string
  snapshotPhaseLabel?: string
}): Promise<void> {
  const now = Date.now()
  // Deterministic ID: keyed to changeOrderId so upsert finds the same record.
  const recordId = `ta_co_${params.changeOrderId}`

  const existing = getThreadArtifactRepository()
    .getAll()
    .find((r) => r.id === recordId)

  const record: ThreadArtifactRecord = {
    id: recordId,
    conversationId: params.conversationId,
    artifactType: 'change_order',
    changeOrderId: params.changeOrderId,
    jobId: params.jobId,
    phase: params.phase,
    snapshotPrice: params.snapshotDeltaAmount ?? existing?.snapshotPrice,
    snapshotSummary: params.snapshotDescription ?? existing?.snapshotSummary,
    snapshotPhaseLabel: params.snapshotPhaseLabel ?? existing?.snapshotPhaseLabel,
    customerUserId: params.customerUserId ?? existing?.customerUserId,
    craftsmanUserId: params.craftsmanUserId ?? existing?.craftsmanUserId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Updates the phase (status) of an existing ChangeOrder artifact record.
 *
 * Called when the ChangeOrder is accepted, declined, or cancelled so the
 * thread card reflects the current state without requiring a full entity reload.
 * No-op when no artifact record exists for the given changeOrderId.
 */
export async function updateChangeOrderArtifactPhase(
  changeOrderId: string,
  phase: string,
  updates?: { snapshotPhaseLabel?: string }
): Promise<void> {
  const recordId = `ta_co_${changeOrderId}`
  const existing = getThreadArtifactRepository()
    .getAll()
    .find((r) => r.id === recordId)
  if (!existing) return

  if (existing.phase === phase) return

  const record: ThreadArtifactRecord = {
    ...existing,
    phase,
    ...(updates?.snapshotPhaseLabel != null && { snapshotPhaseLabel: updates.snapshotPhaseLabel }),
    updatedAt: Date.now(),
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Persists an Invoice (Rechnung) artifact record for a conversation.
 *
 * Each Invoice produces an append-only artifact record keyed to its invoiceId
 * via a deterministic record ID, so subsequent status updates (sent → paid →
 * cancelled) upsert the same record.
 *
 * Snapshot fields are written at persist time so the card can render
 * immediately without waiting for the Invoice repository to hydrate.
 */
export async function persistInvoiceArtifact(params: {
  conversationId: string
  invoiceId: string
  jobId: string
  phase: string
  customerUserId?: string
  craftsmanUserId?: string
  snapshotAmount?: string
  snapshotInvoiceNumber?: string
  snapshotPhaseLabel?: string
}): Promise<void> {
  const now = Date.now()
  // Deterministic ID: keyed to invoiceId so upsert finds the same record.
  const recordId = `ta_inv_${params.invoiceId}`

  const existing = getThreadArtifactRepository()
    .getAll()
    .find((r) => r.id === recordId)

  const record: ThreadArtifactRecord = {
    id: recordId,
    conversationId: params.conversationId,
    artifactType: 'invoice',
    invoiceId: params.invoiceId,
    jobId: params.jobId,
    phase: params.phase,
    snapshotPrice: params.snapshotAmount ?? existing?.snapshotPrice,
    snapshotSummary: params.snapshotInvoiceNumber ?? existing?.snapshotSummary,
    snapshotPhaseLabel: params.snapshotPhaseLabel ?? existing?.snapshotPhaseLabel,
    customerUserId: params.customerUserId ?? existing?.customerUserId,
    craftsmanUserId: params.craftsmanUserId ?? existing?.craftsmanUserId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Updates the phase (status) of an existing Invoice artifact record.
 *
 * Called when the Invoice transitions (sent → paid → cancelled) so the thread
 * card reflects the current state without requiring a full entity reload.
 * No-op when no artifact record exists for the given invoiceId.
 */
export async function updateInvoiceArtifactPhase(
  invoiceId: string,
  phase: string,
  updates?: { snapshotPhaseLabel?: string }
): Promise<void> {
  const recordId = `ta_inv_${invoiceId}`
  const existing = getThreadArtifactRepository()
    .getAll()
    .find((r) => r.id === recordId)
  if (!existing) return

  if (existing.phase === phase) return

  const record: ThreadArtifactRecord = {
    ...existing,
    phase,
    ...(updates?.snapshotPhaseLabel != null && { snapshotPhaseLabel: updates.snapshotPhaseLabel }),
    updatedAt: Date.now(),
  }

  await getThreadArtifactRepository().upsert(record)
}

/**
 * Backfill: derives artifact records from existing conversation/project/offer
 * state and persists them.  Safe to call multiple times — project artifacts
 * are only created if none exist yet for the conversation.  Offer artifacts
 * use upsert semantics (idempotent).
 *
 * Used during migration to populate thread_artifacts for threads that were
 * created before this model existed.  Returns a Promise that resolves when all
 * writes are confirmed.
 */
export async function backfillThreadArtifacts(params: {
  conversationId: string
  sourceProjectId?: string
  offerId?: string
  offerPhase?: string
  jobId?: string
  customerUserId?: string
  craftsmanUserId?: string
}): Promise<void> {
  if (params.sourceProjectId) {
    // Backfill is idempotent: skip if a project artifact already exists
    const existing = getThreadArtifactRepository().getByConversationAndType(
      params.conversationId,
      'project'
    )
    if (!existing) {
      await persistProjectArtifact({
        conversationId: params.conversationId,
        projectId: params.sourceProjectId,
        customerUserId: params.customerUserId,
        craftsmanUserId: params.craftsmanUserId,
      })
    }
  }

  if (params.offerId) {
    await persistOfferArtifact({
      conversationId: params.conversationId,
      offerId: params.offerId,
      phase: params.offerPhase ?? 'sent',
      jobId: params.jobId,
      customerUserId: params.customerUserId,
      craftsmanUserId: params.craftsmanUserId,
    })
  }
}
