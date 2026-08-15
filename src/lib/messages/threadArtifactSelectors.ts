/**
 * Thread Artifact Selectors — MULTI-SEND PROJECT CARDS
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * STATUS: MULTI-SEND — APPEND-ONLY PROJECT ARTIFACTS
 *
 * RUN 1 removed all legacy fallback/inference/migration paths.
 * RUN 2 rebuilt cards on the clean thread_artifacts contract.
 * SNAPSHOT HARDENING makes cards render from artifact snapshot data
 * immediately, without depending on secondary repo hydration timing.
 * MULTI-SEND changed project artifacts from single-slot to append-only:
 * a conversation may have multiple project-send artifacts, each with
 * its own identity and timestamp, rendered in history order.
 *
 * Only the PRIMARY path (thread_artifacts record → entity) is used.
 * No fallback, no inference, no multi-repo derivation.
 *
 * When the full entity hasn't loaded yet, the card renders from
 * snapshot display data stored in the artifact record itself.
 * The pending flag is only true when both the entity and snapshot are
 * missing — a truly degraded state that should not occur in normal
 * operation since write paths now always persist snapshot data.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── READ CONTRACT ──
 *
 * getThreadArtifacts(threadId) reads ONLY from persisted ThreadArtifactRecord
 * rows.  If the full entity hasn't loaded yet but snapshot data exists, the
 * card renders from the snapshot.  Only when both entity and snapshot are
 * missing does pendingProjectArtifact / pendingOfferArtifact signal true.
 *
 * Project artifacts (MULTI-SEND):
 *   All ThreadArtifactRecords(conversationId, 'project') → projectId → Project
 *   Fallback: snapshot display data from artifact record
 *   Multiple artifacts per conversation, ordered by createdAt.
 *
 * Offer artifact:
 *   ThreadArtifactRecord(conversationId, 'offer') → offerId → Offer
 *   Phase derived from offer.status + linked job/payment state
 *   Fallback: snapshot display data from artifact record
 *
 * Canonical writes (unchanged):
 *   - sendProjectAttachmentToThread (project artifact + snapshot, append-only)
 *   - createOfferWorkflow (offer artifact + snapshot)
 *   - acceptOfferWorkflow (offer phase update + payment_phase artifact + snapshot)
 *   - declineOfferWorkflow (offer phase update + snapshot)
 *   - backfillThreadArtifacts (one-time migration helper)
 */

import type { Conversation } from './types'
import {
  FUNDING_ACTIVE_CTA_PHASES,
} from './threadArtifactTypes'
import type {
  ThreadArtifacts,
  ProjectArtifact,
  OfferPaymentArtifact,
  FundingStepArtifact,
  FundingStepPhase,
  FundingStepSnapshot,
  OfferPaymentPhase,
  ProjectSnapshot,
  OfferSnapshot,
  ChangeOrderArtifact,
  ChangeOrderSnapshot,
  InvoiceArtifact,
  InvoiceSnapshot,
} from './threadArtifactTypes'
import type { Offer, OfferDocumentType } from '../offers/types'
import type { Job } from '../jobs/types'
import type { PaymentState } from '../shared/coreTypes'
import type { PersistenceStatus } from './threadArtifactTruthTrace'
import { getConversationById, getConversations } from './store'
import { getOfferById } from '../offers/service'
import { getProjectById } from '../projects'
import { getJobById } from '../jobs'
import { getPaymentForJob } from '../payments'
import { getActionablePaymentState } from '../jobs/helpers'
import { isConversationParticipant, getRelationshipGroup } from './participantScope'
import { getSession } from '../session'
import { getThreadArtifactRepository } from './repository/threadArtifactRegistry'
import { getChangeOrderById } from '../changeOrders/service'
import { getInvoiceById } from '../invoices/invoiceStore'
import { formatCents } from '../shared/formatters'
import { getFundingRequestById, getFundingRequestByJobId, isFundingConfirmedForJob } from '../payments/fundingRequest'
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus'
import { formatEuro } from '../shared/formatters'

// ── Canonical job lookup ──────────────────────────────────────────────────

/**
 * Finds the canonical job for a conversation using a strict priority order:
 *
 *   1. PRIMARY: job.sourceConversationId matches ANY conversation in the
 *      relationship group (set by acceptOfferWorkflow — the canonical
 *      post-acceptance link)
 *
 *   2. FALLBACK: job.projectId matches sourceProjectId or projectId from
 *      ANY conversation in the relationship group (legacy data without
 *      sourceConversationId)
 *
 * Searches across all conversation IDs in the customer ↔ craftsman
 * relationship group so that jobs linked to non-canonical duplicate
 * conversations are still found.
 *
 * This helper is the single source of truth for conversation → job resolution.
 * Used by getJobContextForThread (messageWorkflow) and getThreadConversionState
 * (selectors) — NOT part of the business-card rendering layer.
 */
export function findCanonicalJobForConversation(
  conversation: Conversation,
  jobs: Job[]
): { job: Job; canonical: boolean } | null {
  // Collect all conversation IDs in the relationship group
  const allConversations = getConversations()
  const groupIds = getRelationshipGroup(conversation, allConversations)
  const groupIdSet = new Set(groupIds)

  // PRIMARY: sourceConversationId matches any conversation in the group
  const primaryMatches = jobs.filter(
    (j) => j.sourceConversationId && groupIdSet.has(j.sourceConversationId)
  )
  if (primaryMatches.length > 0) {
    // When multiple jobs match (duplicate-job scenario), prefer the canonical
    // accepted job — the one linked to the accepted offer via sourceOfferId.
    const canonical = primaryMatches.find((j) => j.sourceOfferId) ?? primaryMatches[0]
    return { job: canonical, canonical: true }
  }

  // Collect all projectId-like identifiers across the group for fallback
  const projectIds = new Set<string>()
  for (const cid of groupIds) {
    const c = getConversationById(cid)
    if (!c) continue
    if (c.sourceProjectId) projectIds.add(c.sourceProjectId)
    if (c.projectId) projectIds.add(c.projectId)
  }

  // FALLBACK: projectId-based matching (legacy conversations)
  const fallbackMatches = jobs.filter(
    (j) => j.projectId && projectIds.has(j.projectId)
  )
  if (fallbackMatches.length > 0) {
    // Same canonical preference for fallback matches
    const canonical = fallbackMatches.find((j) => j.sourceOfferId) ?? fallbackMatches[0]
    return { job: canonical, canonical: false }
  }

  return null
}

// ── Project artifact resolution (MULTI-SEND, PRIMARY ONLY) ───────────────

/**
 * Resolves ALL project artifacts from persisted ThreadArtifactRecords.
 *
 * MULTI-SEND: A conversation may have multiple project artifacts (one per
 * send).  Each is resolved independently and returned in createdAt order.
 *
 * SNAPSHOT HARDENING: When the full project entity isn't loaded yet but
 * snapshot data exists in the artifact record, a snapshot-based artifact
 * is returned so the card renders immediately.  The pending flag is only
 * true when ALL records lack both entity and snapshot.
 *
 * RUN 1 TEARDOWN: All fallback paths removed:
 *   - REMOVED: conversation.sourceProjectId (was FALLBACK A)
 *   - REMOVED: job.sourceConversationId → job → project (was FALLBACK B)
 *   - REMOVED: conversation.projectId UUID (was FALLBACK C, already removed)
 *   - REMOVED: message attachments (was MIGRATION, already removed)
 */
function resolveProjectArtifacts(
  conversation: Conversation
): { artifacts: ProjectArtifact[]; pending: boolean } {
  // ── PRIMARY: persisted ThreadArtifactRecords — the ONLY source ──
  const allRecords = getThreadArtifactRepository().getByConversationId(conversation.id)
  const projectRecords = allRecords
    .filter((r) => r.artifactType === 'project' && r.projectId)
    .sort((a, b) => a.createdAt - b.createdAt)

  if (projectRecords.length === 0) return { artifacts: [], pending: false }

  // The active operational project is the one pointed to by sourceProjectId.
  // If sourceProjectId is not set, the first sent project is implicitly active.
  const activeProjectId = conversation.sourceProjectId ?? projectRecords[0].projectId

  const resolved: ProjectArtifact[] = []
  let anyPending = false

  for (const artifactRecord of projectRecords) {
    // Build snapshot from artifact record (always available if write paths
    // are working correctly — they persist snapshot fields at write time)
    const snapshot: ProjectSnapshot | null = artifactRecord.snapshotTitle
      ? {
          title: artifactRecord.snapshotTitle,
          status: artifactRecord.snapshotStatus ?? 'request',
          summary: artifactRecord.snapshotSummary,
          projectId: artifactRecord.projectId!,
          category: artifactRecord.snapshotCategory,
          location: artifactRecord.snapshotLocation,
          requestedBudget: artifactRecord.snapshotBudget,
          requestedTiming: artifactRecord.snapshotTiming,
        }
      : null

    const project = getProjectById(artifactRecord.projectId!)

    // Enrich snapshot with entity data when available
    const enrichedSnapshot: ProjectSnapshot | null = project
      ? {
          title: project.title,
          status: project.status,
          summary: project.category ?? project.description,
          projectId: project.id,
          category: project.category,
          location: project.location,
          requestedBudget: project.requestedBudget,
          requestedTiming: project.requestedTiming,
        }
      : snapshot

    // If entity is loaded, use it (enriched card)
    // If not loaded but snapshot exists, return snapshot-based card (stable)
    // If neither, mark as pending
    if (!project && !snapshot) {
      anyPending = true
      continue
    }

    const persistenceStatus: PersistenceStatus = 'confirmed'
    const isCustomerCreated = Boolean(artifactRecord.projectId)

    resolved.push({
      kind: 'project',
      artifactId: artifactRecord.id,
      project: project ?? null,
      snapshot: enrichedSnapshot,
      isCustomerCreated,
      isActiveProject: artifactRecord.projectId === activeProjectId,
      persistenceStatus,
      createdAt: artifactRecord.createdAt,
    })
  }

  return {
    artifacts: resolved,
    // Pending is only true when NO cards resolve at all — if at least one
    // project card renders (from entity or snapshot), the UI does not need
    // a loading skeleton.  Individual degraded records are silently skipped.
    pending: anyPending && resolved.length === 0,
  }
}

// ── Offer/Payment artifact resolution (PRIMARY ONLY) ─────────────────────

/**
 * Derives the offer lifecycle phase from offer status and payment state.
 */
function deriveOfferPhase(offer: Offer, job: Job | undefined): OfferPaymentPhase {
  if (offer.status === 'declined') return 'declined'

  if (offer.status === 'accepted') {
    if (job) {
      // Funded truth dominates: if funding is confirmed for this job,
      // the offer is simply "accepted" — never "payment_due".
      if (isFundingConfirmedForJob(job.id)) return 'accepted'

      // Terminal-dead funding (expired / cancelled) can never be paid — a pay
      // attempt 409s FUNDING_REQUEST_EXPIRED. The job stays paymentState
      // 'deposit_required' (getActionablePaymentState ignores funding terminal
      // state), so guard here: the offer is 'accepted', NOT 'payment_due'. The
      // sibling funding card surfaces the expired/cancelled state.
      if (isFundingRequestTerminalDead(getFundingRequestByJobId(job.id)?.status)) {
        return 'accepted'
      }

      const payment = getPaymentForJob(job.id)
      const actionableState = getActionablePaymentState(job, payment)
      if (actionableState === 'deposit_required') return 'payment_due'
    }
    return 'accepted'
  }

  // pending
  return 'sent'
}

/**
 * Resolves an offer/payment artifact from ONLY the persisted ThreadArtifactRecord.
 *
 * SNAPSHOT HARDENING: When the full offer entity isn't loaded yet but
 * snapshot data exists in the artifact record, a snapshot-based artifact
 * is returned so the card renders immediately.  The pending flag is only
 * true when both the entity and snapshot are missing.
 *
 * RUN 1 TEARDOWN: All fallback paths removed:
 *   - REMOVED: getOffersByConversationId scan (was FALLBACK)
 */
function resolveOfferPaymentArtifact(
  conversation: Conversation
): { artifact: OfferPaymentArtifact | null; pending: boolean } {
  // ── PRIMARY: persisted ThreadArtifactRecord — the ONLY source ──
  const artifactRecord = getThreadArtifactRepository().getByConversationAndType(
    conversation.id,
    'offer'
  )
  if (!artifactRecord?.offerId) return { artifact: null, pending: false }

  // Build snapshot from artifact record
  const snapshot: OfferSnapshot | null = artifactRecord.snapshotPrice
    ? {
        price: artifactRecord.snapshotPrice,
        summary: artifactRecord.snapshotSummary,
        phaseLabel: artifactRecord.snapshotPhaseLabel ?? 'Angebot liegt vor',
        offerId: artifactRecord.offerId!,
        documentType: (artifactRecord.snapshotDocumentType as OfferDocumentType) ?? undefined,
        version: artifactRecord.snapshotVersion ?? undefined,
        validUntil: artifactRecord.snapshotValidUntil ?? undefined,
      }
    : null

  const activeOffer = getOfferById(artifactRecord.offerId) ?? undefined

  // If entity is loaded, use it for enriched rendering
  if (activeOffer) {
    const linkedJob = activeOffer.createdJobId
      ? getJobById(activeOffer.createdJobId)
      : undefined

    const phase = deriveOfferPhase(activeOffer, linkedJob)

    let paymentState: PaymentState | null = null
    if (linkedJob) {
      const payment = getPaymentForJob(linkedJob.id)
      paymentState = getActionablePaymentState(linkedJob, payment) ?? null
    }

    const persistenceStatus: PersistenceStatus = 'confirmed'
    const documentType: OfferDocumentType = activeOffer.documentType ?? 'binding_offer'

    return {
      artifact: {
        kind: 'offer_payment',
        phase,
        offer: activeOffer,
        snapshot,
        jobId: linkedJob?.id ?? null,
        paymentState,
        documentType,
        persistenceStatus,
        createdAt: artifactRecord.createdAt,
      },
      pending: false,
    }
  }

  // If entity not loaded but snapshot exists, return snapshot-based card
  if (snapshot) {
    let phase: OfferPaymentPhase =
      (artifactRecord.phase as OfferPaymentPhase) ?? 'sent'

    // Funded truth dominates: if the persisted phase is payment_due but
    // canonical funded truth now exists for the linked job, downgrade to
    // 'accepted' so the snapshot card does not show a stale payment CTA.
    // Terminal-dead funding (expired / cancelled) downgrades the same way —
    // the request can never be paid, so the snapshot card must not show a
    // payment CTA for it either.
    if (phase === 'payment_due' && artifactRecord.jobId) {
      if (
        isFundingConfirmedForJob(artifactRecord.jobId) ||
        isFundingRequestTerminalDead(getFundingRequestByJobId(artifactRecord.jobId)?.status)
      ) {
        phase = 'accepted'
      }
    }

    const documentType: OfferDocumentType =
      (artifactRecord.snapshotDocumentType as OfferDocumentType) ?? 'binding_offer'

    return {
      artifact: {
        kind: 'offer_payment',
        phase,
        offer: null,
        snapshot,
        jobId: artifactRecord.jobId ?? null,
        paymentState: null,
        documentType,
        persistenceStatus: 'confirmed',
        createdAt: artifactRecord.createdAt,
      },
      pending: false,
    }
  }

  // Neither entity nor snapshot — pending
  return { artifact: null, pending: true }
}

// ── Funding Step artifact resolution ──────────────────────────────────────

/**
 * Resolves a funding step artifact from persisted ThreadArtifactRecord.
 *
 * The funding step card is tied to a specific funding request and escrow plan.
 * It shows the full upfront escrow funding amount and drives the customer
 * into the correct funding flow.
 *
 * Resolution strategy for the funding request:
 *   1. PRIMARY: use artifactRecord.fundingRequestId (set by server and local workflow)
 *   2. FALLBACK: resolve by artifactRecord.jobId via getFundingRequestByJobId
 *      (defense-in-depth for artifacts created before the funding_request_id
 *       column was added to the DB)
 *
 * Legacy guard: if the artifact record lacks jobId (pre-jobId legacy row),
 * the resolved FundingRequest.jobId is used to populate the view model's
 * jobId.  This ensures the duplicate-suppression reconciliation in
 * getThreadArtifacts() can still match the funding_step to the offer by
 * jobId even for legacy artifacts.
 */
function resolveFundingStepArtifact(
  conversation: Conversation
): { artifact: FundingStepArtifact | null; pending: boolean } {
  const artifactRecord = getThreadArtifactRepository().getByConversationAndType(
    conversation.id,
    'funding_step'
  )
  if (!artifactRecord) return { artifact: null, pending: false }

  // Resolve the funding request ID: prefer direct field, fallback to jobId lookup
  const resolvedFundingRequestId =
    artifactRecord.fundingRequestId ??
    (artifactRecord.jobId ? getFundingRequestByJobId(artifactRecord.jobId)?.id : undefined)

  if (!resolvedFundingRequestId && !artifactRecord.snapshotPrice) {
    // No funding request reference and no snapshot — cannot render
    return { artifact: null, pending: !!artifactRecord.jobId }
  }

  // Build snapshot from artifact record
  const snapshot: FundingStepSnapshot | null = artifactRecord.snapshotPrice
    ? {
        amount: artifactRecord.snapshotPrice,
        fundingRequestId: resolvedFundingRequestId ?? '',
        escrowPlanId: artifactRecord.escrowPlanId ?? '',
        phaseLabel: artifactRecord.snapshotPhaseLabel ?? 'Zahlung',
      }
    : null

  // Try to enrich from the live funding request entity
  const fundingRequest = resolvedFundingRequestId
    ? getFundingRequestById(resolvedFundingRequestId)
    : undefined

  // Derive phase from the strongest available truth:
  //   1. Live FundingRequest entity (most authoritative)
  //   2. Canonical funded truth via isFundingConfirmedForJob (covers escrow plan)
  //   3. Stored artifact phase (weakest — may be stale 'sent' from creation)
  let phase: FundingStepPhase
  if (fundingRequest) {
    phase = mapFundingRequestStatusToPhase(fundingRequest.status)
  } else {
    const storedPhase = (artifactRecord.phase as FundingStepPhase) ?? 'sent'
    // Funded dominance: if the stored phase is a pre-funded state but
    // canonical funded truth already exists for this job, override to 'funded'
    // so the snapshot card does not show a stale 'sent' CTA.
    const jobIdForDominance = artifactRecord.jobId
    if (
      storedPhase !== 'funded' &&
      storedPhase !== 'funding_failed' &&
      storedPhase !== 'cancelled' &&
      storedPhase !== 'expired' &&
      jobIdForDominance &&
      isFundingConfirmedForJob(jobIdForDominance)
    ) {
      phase = 'funded'
    } else {
      phase = storedPhase
    }
  }

  if (!fundingRequest && !snapshot) {
    return { artifact: null, pending: true }
  }

  return {
    artifact: {
      kind: 'funding_step',
      phase,
      fundingRequestId: resolvedFundingRequestId ?? '',
      escrowPlanId: artifactRecord.escrowPlanId ?? fundingRequest?.escrowPlanId ?? '',
      jobId: artifactRecord.jobId ?? fundingRequest?.jobId ?? '',
      projectId: artifactRecord.projectId ?? '',
      sourceOfferId: '',
      amount: fundingRequest
        ? formatEuro(fundingRequest.amount)
        : snapshot?.amount ?? '',
      snapshot: fundingRequest
        ? {
            amount: formatEuro(fundingRequest.amount),
            fundingRequestId: fundingRequest.id,
            escrowPlanId: fundingRequest.escrowPlanId,
            phaseLabel: mapFundingPhaseToLabel(phase),
          }
        : snapshot,
      persistenceStatus: 'confirmed',
      createdAt: artifactRecord.createdAt,
    },
    pending: false,
  }
}

function mapFundingRequestStatusToPhase(status: string): FundingStepPhase {
  switch (status) {
    case 'created': return 'sent'
    case 'sent': return 'sent'
    case 'funding_started': return 'funding_started'
    case 'funding_initiated': return 'funding_initiated'
    case 'funded': return 'funded'
    case 'funding_failed': return 'funding_failed'
    case 'expired': return 'expired'
    case 'cancelled': return 'cancelled'
    default: return 'sent'
  }
}

function mapFundingPhaseToLabel(phase: FundingStepPhase): string {
  switch (phase) {
    case 'sent': return 'Zahlung angefordert'
    case 'funding_started': return 'Einzahlung gestartet'
    case 'funding_initiated': return 'Einzahlung eingeleitet'
    case 'funded': return 'Zahlung bestätigt'
    case 'funding_failed': return 'Einzahlung fehlgeschlagen'
    case 'cancelled': return 'Einzahlung storniert'
    case 'expired': return 'Einzahlung abgelaufen'
  }
}

// ── ChangeOrder artifact resolution (MULTI-SEND, APPEND-ONLY) ────────────

function mapChangeOrderStatusToPhaseLabel(status: string): string {
  switch (status) {
    case 'pending':   return 'Nachtrag liegt vor'
    case 'accepted':  return 'Nachtrag angenommen'
    case 'declined':  return 'Nachtrag abgelehnt'
    case 'cancelled': return 'Nachtrag zurückgezogen'
    default:          return 'Nachtrag'
  }
}

/**
 * Resolves ALL ChangeOrder artifacts for a conversation from persisted records.
 *
 * APPEND-ONLY: Multiple ChangeOrder artifacts may coexist in one thread.
 * Each is resolved independently. Returns empty when no change_order records exist.
 * Live entity enriches the snapshot but is never required for basic rendering.
 */
function resolveChangeOrderArtifacts(
  conversation: Conversation
): ChangeOrderArtifact[] {
  const allRecords = getThreadArtifactRepository().getByConversationId(conversation.id)
  const coRecords = allRecords
    .filter((r) => r.artifactType === 'change_order' && r.changeOrderId)
    .sort((a, b) => a.createdAt - b.createdAt)

  if (coRecords.length === 0) return []

  const resolved: ChangeOrderArtifact[] = []

  for (const artifactRecord of coRecords) {
    const changeOrder = getChangeOrderById(artifactRecord.changeOrderId!)

    // Derive current status: prefer live entity, fallback to stored phase
    const status = (changeOrder?.status ?? artifactRecord.phase ?? 'pending') as ChangeOrderArtifact['status']

    // Build snapshot from artifact record
    const snapshot: ChangeOrderSnapshot | null = artifactRecord.snapshotPrice
      ? {
          changeOrderId: artifactRecord.changeOrderId!,
          deltaAmount: artifactRecord.snapshotPrice,
          description: artifactRecord.snapshotSummary ?? '',
          phaseLabel: artifactRecord.snapshotPhaseLabel ?? mapChangeOrderStatusToPhaseLabel(status),
        }
      : null

    // Enrich snapshot with live entity data when available
    const enrichedSnapshot: ChangeOrderSnapshot | null = changeOrder
      ? {
          changeOrderId: changeOrder.id,
          deltaAmount: changeOrder.grossTotal != null
            ? (changeOrder.grossTotal >= 0 ? '+' : '') + formatCents(changeOrder.grossTotal)
            : changeOrder.price,
          description: changeOrder.description,
          phaseLabel: mapChangeOrderStatusToPhaseLabel(changeOrder.status),
        }
      : snapshot

    if (!changeOrder && !snapshot) continue

    resolved.push({
      kind: 'change_order',
      artifactId: artifactRecord.id,
      changeOrder: changeOrder ?? null,
      snapshot: enrichedSnapshot,
      status,
      jobId: artifactRecord.jobId ?? changeOrder?.jobId ?? '',
      persistenceStatus: 'confirmed',
      createdAt: artifactRecord.createdAt,
    })
  }

  return resolved
}

// ── Invoice (Rechnung) artifact resolution (APPEND-ONLY) ─────────────────

function mapInvoiceStatusToPhaseLabel(status: string): string {
  switch (status) {
    case 'issued':    return 'Rechnung gestellt'
    case 'sent':      return 'Rechnung versendet'
    case 'paid':      return 'Rechnung bezahlt'
    case 'cancelled': return 'Rechnung storniert'
    default:          return 'Rechnung'
  }
}

/**
 * Resolves ALL Invoice artifacts for a conversation from persisted records.
 *
 * APPEND-ONLY: Multiple invoices may coexist in one thread. Each is resolved
 * independently. Returns empty when no invoice records exist. The live entity
 * enriches the snapshot but is never required for basic rendering.
 */
function resolveInvoiceArtifacts(
  conversation: Conversation
): InvoiceArtifact[] {
  const allRecords = getThreadArtifactRepository().getByConversationId(conversation.id)
  const invRecords = allRecords
    .filter((r) => r.artifactType === 'invoice' && r.invoiceId)
    .sort((a, b) => a.createdAt - b.createdAt)

  if (invRecords.length === 0) return []

  const resolved: InvoiceArtifact[] = []

  for (const artifactRecord of invRecords) {
    const invoice = getInvoiceById(artifactRecord.invoiceId!)

    // Derive current status: prefer live entity, fallback to stored phase
    const status = (invoice?.status ?? artifactRecord.phase ?? 'sent') as InvoiceArtifact['status']

    // Build snapshot from artifact record (invoice number is stored in summary)
    const snapshot: InvoiceSnapshot | null = artifactRecord.snapshotPrice
      ? {
          invoiceId: artifactRecord.invoiceId!,
          amount: artifactRecord.snapshotPrice,
          invoiceNumber: artifactRecord.snapshotSummary ?? '',
          phaseLabel: artifactRecord.snapshotPhaseLabel ?? mapInvoiceStatusToPhaseLabel(status),
        }
      : null

    // Enrich snapshot with live entity data when available
    const enrichedSnapshot: InvoiceSnapshot | null = invoice
      ? {
          invoiceId: invoice.id,
          amount: formatEuro(invoice.amounts.grossAmount),
          invoiceNumber: invoice.invoiceNumber,
          phaseLabel: mapInvoiceStatusToPhaseLabel(invoice.status),
        }
      : snapshot

    if (!invoice && !snapshot) continue

    resolved.push({
      kind: 'invoice',
      artifactId: artifactRecord.id,
      invoice: invoice ?? null,
      snapshot: enrichedSnapshot,
      status,
      jobId: artifactRecord.jobId ?? invoice?.jobId ?? '',
      persistenceStatus: 'confirmed',
      createdAt: artifactRecord.createdAt,
    })
  }

  return resolved
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Derives the thread artifacts for a conversation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTI-SEND — APPEND-ONLY PROJECT ARTIFACTS
 *
 * Resolution reads ONLY from persisted ThreadArtifactRecord rows.
 * Project artifacts are append-only: multiple project cards may coexist
 * in one thread.  projectArtifacts returns the full array in order;
 * projectArtifact is a convenience getter for the first (backward-compat).
 *
 * When the full entity hasn't loaded yet but snapshot data exists,
 * the card renders from the snapshot immediately.
 * Pending is only true when both entity and snapshot are missing.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function getThreadArtifacts(threadId: string): ThreadArtifacts {
  const empty: ThreadArtifacts = {
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

  const conversation = getConversationById(threadId)

  // Resolve the set of conversation-like contexts whose artifacts feed this
  // thread. Two cases:
  //   • Legacy thread → aggregate across its relationship group (duplicate
  //     conversations of the same Customer↔Provider pair) after a participant
  //     check.
  //   • Cutover chat thread → no legacy `conversations` row exists; offer /
  //     project / funding / change-order artifacts are persisted keyed by the
  //     `chat_threads.id` (= threadId). Resolve against a synthetic
  //     single-thread context. Access is enforced by RLS plus each artifact's
  //     own party-scoping (customer_user_id / craftsman_user_id) — the legacy
  //     participant check does not apply since the conversation row is absent.
  // (Was: `if (!conversation) return empty`, which blanked every cutover
  // thread's artifacts so a sent offer never surfaced its card — Block Q.)
  let groupConversations: Conversation[]
  if (conversation) {
    // Defense-in-depth: refuse to resolve artifacts for a conversation
    // where the current user is not a participant.  This prevents stale
    // cache data from leaking artifacts to the wrong account.
    const currentUserId = getSession().user?.id
    if (currentUserId && !isConversationParticipant(conversation, currentUserId)) {
      return empty
    }
    const groupIds = getRelationshipGroup(conversation, getConversations())
    groupConversations = groupIds
      .map((cid) => getConversationById(cid))
      .filter((c): c is Conversation => Boolean(c))
  } else {
    groupConversations = [{ id: threadId } as Conversation]
  }

  let allProjectArtifacts: ProjectArtifact[] = []
  let anyProjectPending = false
  let offerResult: { artifact: OfferPaymentArtifact | null; pending: boolean } = {
    artifact: null,
    pending: false,
  }
  let fundingStepResult: { artifact: FundingStepArtifact | null; pending: boolean } = {
    artifact: null,
    pending: false,
  }
  let allChangeOrderArtifacts: ChangeOrderArtifact[] = []
  let allInvoiceArtifacts: InvoiceArtifact[] = []

  for (const c of groupConversations) {
    const projectResult = resolveProjectArtifacts(c)
    allProjectArtifacts = allProjectArtifacts.concat(projectResult.artifacts)
    if (projectResult.pending) anyProjectPending = true

    // For offer, take the first non-null result found across the group
    if (!offerResult.artifact) {
      const offer = resolveOfferPaymentArtifact(c)
      if (offer.artifact || offer.pending) {
        offerResult = offer
      }
    }

    // For funding step, take the first non-null result found across the group
    if (!fundingStepResult.artifact) {
      const funding = resolveFundingStepArtifact(c)
      if (funding.artifact || funding.pending) {
        fundingStepResult = funding
      }
    }

    // ChangeOrders are append-only across the group — collect all
    allChangeOrderArtifacts = allChangeOrderArtifacts.concat(
      resolveChangeOrderArtifacts(c)
    )

    // Invoices are append-only across the group — collect all
    allInvoiceArtifacts = allInvoiceArtifacts.concat(
      resolveInvoiceArtifacts(c)
    )
  }

  // Sort all project artifacts chronologically across the group
  allProjectArtifacts.sort((a, b) => a.createdAt - b.createdAt)
  // Sort all ChangeOrder artifacts chronologically
  allChangeOrderArtifacts.sort((a, b) => a.createdAt - b.createdAt)
  // Deduplicate ChangeOrder artifacts by changeOrderId across conversations
  const seenCoIds = new Set<string>()
  allChangeOrderArtifacts = allChangeOrderArtifacts.filter((co) => {
    const id = co.changeOrder?.id ?? co.snapshot?.changeOrderId ?? co.artifactId
    if (seenCoIds.has(id)) return false
    seenCoIds.add(id)
    return true
  })
  // Sort all Invoice artifacts chronologically
  allInvoiceArtifacts.sort((a, b) => a.createdAt - b.createdAt)
  // Deduplicate Invoice artifacts by invoiceId across conversations
  const seenInvIds = new Set<string>()
  allInvoiceArtifacts = allInvoiceArtifacts.filter((inv) => {
    const id = inv.invoice?.id ?? inv.snapshot?.invoiceId ?? inv.artifactId
    if (seenInvIds.has(id)) return false
    seenInvIds.add(id)
    return true
  })

  // ── Offer / funding-step reconciliation (Block 3: card hierarchy) ────────
  //
  // CANONICAL CONTEXT KEY: jobId — links offer, funding request, escrow plan.
  //
  // ACTIVE-CARD DOMINANCE RULE:
  // For a single canonical context (same jobId), exactly one card should be
  // the primary active representation.  The funding step card is more specific
  // and more advanced in the workflow than the offer card, so when both exist
  // for the same jobId:
  //
  //   1. Funding in active CTA phase (sent / funding_started / funding_initiated):
  //      The funding step IS the payment action surface.  The offer card must
  //      not also show 'payment_due' — downgrade to 'accepted'.
  //      The offer card is superseded: `offerFundingSuperseded = true`
  //      so the UI suppresses it from the persistent context area — the
  //      funding CTA is the dominant surface, showing both creates competing
  //      representations.  The offer event still appears in the timeline
  //      with passive/historical styling.
  //
  //   2. Funding in funded phase:
  //      The funding card is the canonical funded confirmation.  The offer card
  //      must not show 'payment_due' — downgrade to 'accepted'.
  //      The offer card is superseded: same as (1).
  //
  //   3. Funding in a RETRYABLE failure phase (funding_failed):
  //      The funding card shows the failure.  The offer card may retain
  //      'payment_due' — the customer can still retry paying the same request.
  //      The offer card is NOT superseded — it remains the active surface.
  //
  //   4. Funding in a TERMINAL-DEAD phase (expired / cancelled):
  //      The request can never be paid — a pay attempt 409s FUNDING_REQUEST_EXPIRED.
  //      The offer card must NOT show 'payment_due' — downgrade to 'accepted' so it
  //      is not presented as payable (and the HW is not told the customer must pay).
  //      Not superseded: the funding card carries the dead state (no CTA); the offer
  //      stays visible as a passive, accepted quote.
  //
  // CONTEXT SCOPING: reconciliation is keyed by jobId.  Different jobs/contexts
  // are never cross-suppressed.

  let reconciledOffer = offerResult.artifact
  const fundingArtifact = fundingStepResult.artifact
  let offerFundingSuperseded = false

  if (
    reconciledOffer &&
    reconciledOffer.phase === 'payment_due' &&
    fundingArtifact &&
    reconciledOffer.jobId &&
    reconciledOffer.jobId === fundingArtifact.jobId
  ) {
    if (
      fundingArtifact.phase === 'funded' ||
      FUNDING_ACTIVE_CTA_PHASES.has(fundingArtifact.phase) ||
      // Terminal-dead funding (expired / cancelled): the offer must not remain
      // payable. The FundingStepPhase strings match the FundingRequestStatus
      // strings, so the same predicate classifies them.
      isFundingRequestTerminalDead(fundingArtifact.phase)
    ) {
      reconciledOffer = { ...reconciledOffer, phase: 'accepted' }
    }
  }

  // Mark offer as superseded when funding is the dominant active surface
  // (active CTA phase or funded confirmation) for the same canonical context.
  // When funding is the current action/confirmation surface, the offer card
  // is historical-only and must not compete in the persistent context area.
  if (
    reconciledOffer &&
    fundingArtifact &&
    reconciledOffer.jobId &&
    reconciledOffer.jobId === fundingArtifact.jobId &&
    (fundingArtifact.phase === 'funded' || FUNDING_ACTIVE_CTA_PHASES.has(fundingArtifact.phase))
  ) {
    offerFundingSuperseded = true
  }

  return {
    projectArtifacts: allProjectArtifacts,
    projectArtifact: allProjectArtifacts[0] ?? null,
    offerPaymentArtifact: reconciledOffer,
    fundingStepArtifact: fundingStepResult.artifact,
    changeOrderArtifacts: allChangeOrderArtifacts,
    invoiceArtifacts: allInvoiceArtifacts,
    offerFundingSuperseded,
    pendingProjectArtifact: anyProjectPending && allProjectArtifacts.length === 0,
    pendingOfferArtifact: offerResult.pending,
    pendingFundingArtifact: fundingStepResult.pending,
  }
}
