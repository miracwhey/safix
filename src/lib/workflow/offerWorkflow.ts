/**
 * Offer Workflow — Core Loop
 *
 * Orchestrates the lifecycle: create → accept/decline, with job creation
 * on acceptance.
 *
 * Rules:
 * - Only one pending offer per conversation at a time
 * - Acceptance is idempotent: re-accepting a previously accepted offer
 *   returns the same offer/job without side effects
 * - Declined offers can be followed by a new offer
 * - Job creation is linked to the conversation via sourceConversationId
 */

import type { Offer, OfferMode, OfferDocumentType } from '../offers/types'
import type { Job } from '../jobs/types'
import {
  getDocumentTypePolicy,
  resolveEffectiveDocumentType,
  documentTypeToLegacyOfferMode,
  getJobKindForDocumentType,
} from '../offers/commercialDocumentPolicy'
import {
  addOffer,
  getActiveOfferForConversation,
  getOfferById,
  updateOffer,
  getOffersByConversationId,
} from '../offers/service'
import {
  addJob,
  getJobById,
  getJobs,
  linkJobToProject,
  linkJobToSourceOffer,
  markProposalAccepted,
  markProposalSent,
  parseJobAmount,
} from '../jobs'
import { ensurePaymentForJob, updatePaymentAmounts, ensureDiagnosisPaymentForJob } from '../payments'
import { ensureEscrowPlan } from '../payments/escrow'
import { logInfo, logWarning } from '../observability'
import {
  ensureInvoiceForJob,
  isInvoiceRepositoryHydrated,
  getInvoiceByJobId,
} from '../invoices'
import { ensureTimelineEvent } from '../timeline'
import { getSpatialSceneRepository } from '../spatial/canonical/repository/registry'
import { normalizeErrorMessage } from '../diagnostics'
import { recordAnalyticsEvent } from '../analytics'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'
import { getConversationById, getConversations } from '../messages'
import { resolveCanonicalConversation } from '../messages/participantScope'
import {
  addProject,
  getProjectById,
  getProjectByJobId,
  updateProject,
  deriveProjectStatusFromJob,
  type Project,
} from '../projects'
import { generateProjectId, isValidProjectId } from '../projects/projectId'
import { generateUUID } from '../shared/generateUUID'
import type { Conversation } from '../messages/types.js'
import { recordWriteResult } from '../messages/threadArtifactTruthTrace'
import { getProviderIdByAuthUid } from '../providers/providerProfileService'
import { resolveIssuerData } from './issuerDataHelper'
import {
  persistOfferArtifact,
  updateOfferArtifactPhase,
  persistPaymentPhaseArtifact,
} from '../messages/threadArtifactService'
import { formatOfferPrice } from '../shared/formatters'
import { resolveAndEnsureRelationship } from '../commercialAttribution/commercialAttributionService'
import type { JobCommercialOrigin } from '../commercialAttribution/types'
import { validateOfferDocument } from '../offers/offerDocumentValidator'
import { normalizeDateToISO } from '../shared/formatters'
import { isConflictError } from '../messages/ConflictError'
import { getCallerUserId, RbacError } from '../auth/rbacGuards'
import type { SessionState } from '../session'

function findJobForConversation(conversationId: string, preferredProjectId?: string): Job | undefined {
  const jobs = getJobs()
  // When multiple jobs match (duplicate-job scenario), prefer the canonical
  // accepted job — the one linked to the accepted offer via sourceOfferId.
  const byConversation = jobs.filter((j) => j.sourceConversationId === conversationId)
  if (byConversation.length > 0) {
    return byConversation.find((j) => j.sourceOfferId) ?? byConversation[0]
  }
  if (preferredProjectId) {
    const byProject = jobs.filter((j) => j.projectId === preferredProjectId)
    if (byProject.length > 0) {
      return byProject.find((j) => j.sourceOfferId) ?? byProject[0]
    }
  }
  return undefined
}

/**
 * Resolve the canonical `providers.id` (DB-generated UUID) from a craftsman's
 * auth user ID (`providers.profile_id`).
 *
 * The `jobs.provider_id` / `escrow_payment_plans.provider_id` FKs reference
 * `providers.id`, which is NOT the same as the auth user ID. This helper
 * bridges that gap so the inserts satisfy the foreign key constraint.
 *
 * Acceptance runs in the CUSTOMER's session, so it cannot read the craftsman's
 * `providers` row through the owner-only RLS. It therefore resolves via the
 * `SECURITY DEFINER` resolver wrapped in `getProviderIdByAuthUid` rather than a
 * direct (RLS-blocked) profile read. Returns `undefined` when the lookup fails
 * (e.g. the mocked profile service in tests, or no providers row) so the caller
 * can proceed with the in-memory fallback / a NULL FK.
 */
async function resolveProviderId(craftsmanUserId: string): Promise<string | undefined> {
  try {
    return (await getProviderIdByAuthUid(craftsmanUserId)) ?? undefined
  } catch (err) {
    // Best-effort: log the failure and return undefined so the caller can
    // proceed with provider_id = null (FK allows NULL).
    logWarning('workflow.offer.provider_resolve_failed', {
      craftsmanUserId,
      error: String(err),
    })
    return undefined
  }
}

async function ensureProjectForAcceptedOffer(
  job: Job,
  conversation: Conversation | undefined,
  preferredProjectId?: string,
  /** Whether this offer type allows payment gating (from documentType policy). */
  allowsPaymentGating = true
): Promise<string | undefined> {
  const candidateProjectId = preferredProjectId ?? job.projectId
  // Also check getProjectByJobId to find auto-projects created during
  // inquiry conversion.  Without this, the offer flow can miss the
  // auto-project (whose UUID differs from the synthetic conversation
  // projectId) and create a duplicate project for the same job.
  const existing =
    (candidateProjectId ? getProjectById(candidateProjectId) : undefined) ??
    getProjectByJobId(job.id)

  const ownerFields = {
    ...((conversation?.customerUserId ?? job.customerUserId) && {
      customerUserId: (conversation?.customerUserId ?? job.customerUserId) as string,
    }),
    ...((conversation?.craftsmanUserId ?? job.craftsmanUserId) && {
      craftsmanUserId: (conversation?.craftsmanUserId ?? job.craftsmanUserId) as string,
    }),
  }

  if (existing) {
    const updates: Partial<Project> = {}
    if (!existing.sourceJobId) updates.sourceJobId = job.id
    if (!existing.paymentState) updates.paymentState = allowsPaymentGating ? 'deposit_required' : 'none'
    if (ownerFields.customerUserId && !existing.customerUserId) {
      updates.customerUserId = ownerFields.customerUserId
    }
    if (ownerFields.craftsmanUserId && !existing.craftsmanUserId) {
      updates.craftsmanUserId = ownerFields.craftsmanUserId
    }
    // Ensure craftsman name is populated when accepting an offer (Part G:
    // provider assignment consistency — the accepted quote anchors the
    // provider relationship, so the project must reflect that).
    if (!existing.craftsman && conversation?.craftsmanName) {
      updates.craftsman = conversation.craftsmanName
    }

    // Sync project status from canonical job truth so that the project
    // reflects 'accepted' immediately after offer acceptance — without
    // waiting for the next projectJobSyncBridge cycle.
    const derivedStatus = deriveProjectStatusFromJob(job)
    if (existing.status !== derivedStatus) {
      updates.status = derivedStatus
    }

    if (Object.keys(updates).length > 0) {
      await updateProject(existing.id, updates)
    }

    if (job.projectId !== existing.id) {
      await linkJobToProject(job.id, existing.id)
    }

    return existing.id
  }

  const newProjectId =
    candidateProjectId && isValidProjectId(candidateProjectId)
      ? candidateProjectId
      : generateProjectId()

  await addProject({
    id: newProjectId,
    sourceJobId: job.id,
    title: conversation?.projectTitle ?? job.title,
    customer: conversation?.customerName ?? '',
    craftsman: conversation?.craftsmanName ?? '',
    location: conversation?.projectLocation ?? job.location ?? 'Ort folgt',
    dateLabel: job.dateLabel,
    price: resolveCanonicalAmount(job.id).formatted || job.amount,
    status: 'accepted',
    paymentState: allowsPaymentGating ? 'deposit_required' : 'none',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: conversation?.inquiryOrigin ? 'inquiry' : 'direct',
    ...(conversation?.projectDescription && { description: conversation.projectDescription }),
    ...(conversation?.projectCostRange && { requestedBudget: conversation.projectCostRange }),
    ...ownerFields,
  })

  await linkJobToProject(job.id, newProjectId)

  return newProjectId
}

/**
 * Generates a human-readable offer reference.
 * Format: KV-{year}-{8 random hex chars uppercase}
 */
function generateOfferRef(): string {
  const year = new Date().getFullYear()
  const hex = generateUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
  return `KV-${year}-${hex}`
}

/**
 * Creates a structured offer from a conversation thread.
 *
 * All commercial fields beyond `price` are optional.  When snapshot fields
 * (projectTitleSnapshot, customerDescriptionSnapshot, locationSnapshot) are
 * not provided, they are automatically populated from the resolved conversation
 * context so the offer is self-contained at send time.
 *
 * @param params.conversationId           - The conversation this offer belongs to
 * @param params.customerUserId           - Customer who receives the offer
 * @param params.craftsmanUserId          - Craftsman who creates the offer
 * @param params.price                    - Required price string
 * @param params.offerMode                - 'binding' (default) or 'estimate'
 * @param params.offerRef                 - Human-readable reference; auto-generated if omitted
 * @param params.description              - General work description (backward-compat)
 * @param params.scopeSummary             - Concise summary of what is covered
 * @param params.scopeIncluded            - What IS included
 * @param params.scopeExcluded            - What is NOT included
 * @param params.assumptions              - Assumptions / prerequisites
 * @param params.paymentTerms             - Payment terms (e.g. '50% Anzahlung, 50% Abschluss')
 * @param params.validUntil               - ISO-8601 date string for offer validity
 * @param params.timingNote               - Optional timing/availability note
 * @param params.notes                    - Internal craftsman notes (not shown to customer)
 * @param params.version                  - Explicit version override (used by supersede flow)
 * @param params.projectTitleSnapshot     - Auto-populated from conversation if not provided
 * @param params.customerDescriptionSnapshot - Auto-populated from conversation if not provided
 * @param params.locationSnapshot         - Auto-populated from conversation if not provided
 *
 * @returns The newly created Offer
 * @throws  If an active (pending) offer already exists for this conversation
 */
export async function createOfferWorkflow(params: {
  conversationId: string
  customerUserId: string
  craftsmanUserId: string
  price: string
  offerMode?: OfferMode
  offerRef?: string
  description?: string
  scopeSummary?: string
  scopeIncluded?: string
  scopeExcluded?: string
  assumptions?: string
  paymentTerms?: string
  validUntil?: string
  timingNote?: string
  cancellationTerms?: string
  notes?: string
  version?: number
  projectTitleSnapshot?: string
  customerDescriptionSnapshot?: string
  locationSnapshot?: string
  craftsmanNameSnapshot?: string
  vatIncluded?: boolean
  vatRate?: number
  evidenceMediaIds?: string[]
  /**
   * Commercial document type (Paket 1 — leading typing).
   * Defaults to 'binding_offer' unless overridden.
   * If not provided, falls back to deriving from `offerMode`.
   */
  documentType?: OfferDocumentType
  /**
   * ID of the diagnosis offer this binding_offer was created from (Paket 4d).
   * Set when craftsman creates a follow-up offer after completing a diagnosis.
   * Provides audit trail: diagnosis → follow-up offer. No semantic transfer.
   */
  sourceDiagnosisId?: string
}): Promise<Offer> {
  // ── Input validation ──────────────────────────────────────────────────
  // Catch invalid/empty identifiers early with precise error messages so
  // the UI can surface actionable feedback instead of a generic Supabase
  // failure (e.g. RLS UUID cast error on an empty string).

  if (!params.conversationId) {
    throw new Error('Missing conversationId')
  }
  if (!params.craftsmanUserId) {
    throw new Error('Missing craftsmanUserId')
  }
  if (!params.customerUserId) {
    throw new Error('Missing customerUserId')
  }
  // Coerce to string to handle runtime callers that pass a number
  const priceStr = String(params.price ?? '').trim()
  if (!priceStr) {
    throw new Error('Missing price')
  }

  // Normalize validUntil to ISO-8601 (YYYY-MM-DD) at the workflow boundary.
  // Handles German DD.MM.YYYY input that may bypass UI normalization. No raw
  // fallback: an unparseable value becomes undefined so the document validator
  // below reports a missing Gültigkeit and we never persist junk into the TEXT
  // valid_until column (a raw fallback would silently store garbage from a
  // stale/tampered draft or a programmatic caller).
  const normalizedValidUntil = normalizeDateToISO(params.validUntil)

  // ── Type-specific commercial document validation ───────────────────────
  // Only enforced when documentType is explicitly provided (Paket 4a+).
  // Calls without documentType use the legacy default path and bypass
  // type-specific gates — this preserves backward compat for pre-Paket-1
  // data and test fixtures that test persistence invariants, not document
  // quality.
  if (params.documentType) {
    const docValidation = validateOfferDocument(params.documentType, {
      price: priceStr,
      scopeSummary: params.scopeSummary,
      scopeExcluded: params.scopeExcluded,
      paymentTerms: params.paymentTerms,
      validUntil: normalizedValidUntil,
      assumptions: params.assumptions,
    })
    if (!docValidation.valid) {
      const firstError = docValidation.errors[0]
      const allMessages = docValidation.errors.map((e) => e.message).join(' ')
      throw new Error(
        `[commercial_document_invalid:${firstError.code}] ${allMessages}`
      )
    }
  }

  const now = Date.now()
  // Resolve to canonical conversation so offer artifacts always target
  // the visible relationship thread, not a hidden duplicate.
  const rawConversation = getConversationById(params.conversationId)
  const conversation = rawConversation
    ? resolveCanonicalConversation(rawConversation, getConversations())
    : undefined
  const canonicalConversationId = conversation?.id ?? params.conversationId
  const preferredProjectId = conversation?.sourceProjectId ?? conversation?.projectId

  // Guard: prevent duplicate active offers.
  // Must run AFTER canonical resolution so the check uses the same
  // conversation ID that the offer will be written to — otherwise a
  // stale/non-canonical reference could miss an existing offer and allow
  // a duplicate.
  const existing = getActiveOfferForConversation(canonicalConversationId)
  if (existing) {
    throw new Error(
      `Active offer already exists for conversation ${canonicalConversationId}`
    )
  }

  // Pre-job path: resolvedJob may be undefined — that is expected.
  // A craftsman can send a quote before any job exists.
  const resolvedJob = findJobForConversation(canonicalConversationId, preferredProjectId)
  if (resolvedJob) {
    // Stamp send time on the existing job linked to this conversation/project
    await markProposalSent(resolvedJob.id, now)
  }

  // Derive grossTotal (cents) from the human-readable price string.
  // This is required by the invoice engine which treats offer.grossTotal as
  // the authoritative commercial amount. Failing to set it here would cause
  // invoice creation to throw when the funding workflow triggers ensureInvoiceForJob.
  const parsedGross = parseJobAmount(priceStr)
  const grossTotal =
    parsedGross !== null && parsedGross > 0 ? Math.round(parsedGross * 100) : undefined

  // ── Resolve snapshot fields from conversation context when not provided ──
  // These snapshot fields freeze the project context at offer-send time so
  // later changes to the project/conversation don't silently alter the offer.
  const resolvedProjectTitle =
    params.projectTitleSnapshot ?? conversation?.projectTitle ?? undefined
  const resolvedCustomerDescription =
    params.customerDescriptionSnapshot ?? conversation?.projectDescription ?? undefined
  const resolvedLocation =
    params.locationSnapshot ?? conversation?.projectLocation ?? undefined
  const resolvedCraftsmanName =
    params.craftsmanNameSnapshot ?? conversation?.craftsmanName ?? undefined

  // ── VAT calculation ────────────────────────────────────────────────────
  // Derive netTotal and vatAmount from grossTotal + vatRate.
  // vatIncluded=true (default): grossTotal is brutto → net = gross / (1 + rate/100)
  // vatIncluded=false: grossTotal is netto → gross = net * (1 + rate/100)
  const resolvedVatRate = params.vatRate ?? (grossTotal !== undefined ? 19 : undefined)
  const resolvedVatIncluded = params.vatIncluded !== false // default true
  let derivedNetTotal: number | undefined
  let derivedVatAmount: number | undefined
  let derivedGrossTotal = grossTotal
  if (grossTotal !== undefined && resolvedVatRate !== undefined) {
    if (resolvedVatIncluded) {
      derivedNetTotal = Math.round(grossTotal / (1 + resolvedVatRate / 100))
      derivedVatAmount = grossTotal - derivedNetTotal
    } else {
      derivedNetTotal = grossTotal
      derivedVatAmount = Math.round(grossTotal * resolvedVatRate / 100)
      derivedGrossTotal = derivedNetTotal + derivedVatAmount
    }
  }

  // Resolve leading commercial document type (Paket 1).
  // Priority: explicit params.documentType → derived from params.offerMode → default 'binding_offer'
  const documentType: OfferDocumentType = params.documentType ??
    (params.offerMode === 'estimate' ? 'estimate' : 'binding_offer')
  // Write legacy offerMode alongside documentType for backward compatibility.
  const legacyOfferMode = documentTypeToLegacyOfferMode(documentType)

  const offer: Offer = {
    id: crypto.randomUUID(),
    conversationId: canonicalConversationId,
    customerUserId: params.customerUserId,
    craftsmanUserId: params.craftsmanUserId,
    price: params.price,
    documentType,
    contextType: 'conversation' as const,
    offerMode: legacyOfferMode,
    offerRef: params.offerRef ?? generateOfferRef(),
    version: params.version ?? 1,
    ...(derivedGrossTotal !== undefined && { grossTotal: derivedGrossTotal }),
    ...(resolvedVatRate !== undefined && { vatRate: resolvedVatRate }),
    ...(derivedNetTotal !== undefined && { netTotal: derivedNetTotal }),
    ...(derivedVatAmount !== undefined && { vatAmount: derivedVatAmount }),
    vatIncluded: resolvedVatIncluded,
    ...(params.description && { description: params.description }),
    ...(params.scopeSummary && { scopeSummary: params.scopeSummary }),
    ...(params.scopeIncluded && { scopeIncluded: params.scopeIncluded }),
    ...(params.scopeExcluded && { scopeExcluded: params.scopeExcluded }),
    ...(params.assumptions && { assumptions: params.assumptions }),
    ...(params.paymentTerms && { paymentTerms: params.paymentTerms }),
    ...(normalizedValidUntil && { validUntil: normalizedValidUntil }),
    ...(params.timingNote && { timingNote: params.timingNote }),
    ...(params.cancellationTerms && { cancellationTerms: params.cancellationTerms }),
    ...(params.notes && { notes: params.notes }),
    ...(resolvedProjectTitle && { projectTitleSnapshot: resolvedProjectTitle }),
    ...(resolvedCustomerDescription && { customerDescriptionSnapshot: resolvedCustomerDescription }),
    ...(resolvedLocation && { locationSnapshot: resolvedLocation }),
    ...(resolvedCraftsmanName && { craftsmanNameSnapshot: resolvedCraftsmanName }),
    ...(params.evidenceMediaIds?.length && { evidenceMediaIds: params.evidenceMediaIds }),
    ...(preferredProjectId && { projectId: preferredProjectId }),
    ...(params.sourceDiagnosisId && { sourceDiagnosisId: params.sourceDiagnosisId }),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    sentAt: now,
    ...(resolvedJob && { createdJobId: resolvedJob.id }),
  }

  try {
    await addOffer(offer)

    // Persist first-class thread artifact record for the offer so it
    // survives reload from the canonical artifact table.
    // Snapshot fields are written so the card renders immediately without
    // waiting for the offer repository to hydrate.
    await persistOfferArtifact({
      conversationId: canonicalConversationId,
      offerId: offer.id,
      phase: 'sent',
      jobId: resolvedJob?.id,
      customerUserId: params.customerUserId,
      craftsmanUserId: params.craftsmanUserId,
      snapshotPrice: formatOfferPrice(offer.price),
      snapshotSummary: offer.description,
      snapshotPhaseLabel: documentType === 'estimate'
      ? 'Schätzung liegt vor'
      : documentType === 'cost_estimate'
        ? 'Kostenvoranschlag liegt vor'
        : documentType === 'diagnosis'
          ? 'Diagnose-Einsatz liegt vor'
          : 'Verbindliches Angebot liegt vor',
      snapshotDocumentType: documentType,
      snapshotVersion: offer.version,
      snapshotValidUntil: offer.validUntil,
    })

    // Post-write verification: confirm the offer is readable
    const persisted = getOfferById(offer.id)
    recordWriteResult({
      operation: 'createOfferWorkflow',
      timestamp: Date.now(),
      success: true,
      detail: {
        offerId: offer.id,
        conversationId: canonicalConversationId,
        persistedConfirmed: Boolean(persisted),
        offerStatus: persisted?.status ?? null,
      },
    })
  } catch (err) {
    if (isConflictError(err)) {
      throw new Error('Das Angebot wurde parallel geändert. Bitte lade die Seite neu und versuche es erneut.')
    }
    const errorMessage = normalizeErrorMessage(err)
    recordWriteResult({
      operation: 'createOfferWorkflow',
      timestamp: Date.now(),
      success: false,
      error: errorMessage,
      detail: { offerId: offer.id, conversationId: canonicalConversationId },
    })
    throw err instanceof Error ? err : new Error(errorMessage)
  }

  logInfo('workflow.offer.created', {
    offerId: offer.id,
    conversationId: canonicalConversationId,
  })

  recordAnalyticsEvent({
    eventType: 'offer_created',
    entityType: 'offer',
    entityId: offer.id,
    actorUserId: params.craftsmanUserId,
  })

  return offer
}

/**
 * Accepts a pending offer.
 *
 * On acceptance:
 * 1. Updates offer status to 'accepted' with acceptedAt timestamp
 * 2. Creates exactly one job linked to the conversation (idempotent)
 * 3. Links the job back to the offer via createdJobId
 *
 * @returns The accepted Offer with createdJobId populated
 * @throws  RbacError('rbac_customer') when the caller has a validated user
 *          that is not the offer's customer (H13 ownership guard)
 * @throws  If persistence fails (no silent UI-accepted-but-DB-failed)
 */
export async function acceptOfferWorkflow(
  offerId: string,
  session?: SessionState,
): Promise<Offer | undefined> {
  const offer = getOfferById(offerId)
  if (!offer) return undefined

  // H13 — workflow-layer ownership guard (third defense layer, see
  // src/lib/auth/rbacGuards.ts). RLS blocks a foreign accept at the
  // jobs-INSERT ("Jobs: insert own customer" WITH CHECK customer_user_id =
  // auth.uid()), but NOT a craftsman self-accepting his own offer when a job
  // already exists (inquiry-conversion path: findJobForConversation resolves
  // the job, the remaining writes are jobs-UPDATEs + offers_update_own —
  // both of which RLS permits the provider). Threat model: a logged-in
  // console caller. Fail closed on an identified mismatch; a missing
  // validated user is delegated to RLS (without a JWT every Supabase write
  // fails anyway, and in-memory test callers stay session-less by design).
  // Must run BEFORE the idempotent already-accepted branch below — that
  // branch performs writes (markProposalSent, ensurePaymentForJob,
  // ensureEscrowPlan).
  const callerId = getCallerUserId(session)
  if (callerId && offer.customerUserId !== callerId) {
    throw new RbacError('rbac_customer', `Caller is not the customer of offer ${offerId}`)
  }

  if (!offer.sentAt) {
    throw new Error('Offer cannot be accepted before it was sent')
  }
  // C-10 · C10.7 — Spatial-Offers (NULL conversationId, set sourceSpatialSceneId)
  // flow through the SAME accept pipeline so binding-offer payment/escrow/invoice
  // wiring stays identical. Every conversation-dependent step below is null-
  // guarded: getConversationById skips, findJobForConversation skips, updateOfferArtifactPhase
  // skips. After successful accept we additionally write scene.metadata.offerAcceptedAt.
  const conversation = offer.conversationId
    ? getConversationById(offer.conversationId)
    : undefined
  const preferredProjectId = conversation?.sourceProjectId ?? conversation?.projectId
  const acceptedAt = Date.now()

  // Resolve leading commercial document type and derive policy (Paket 1).
  const effectiveDocumentType = resolveEffectiveDocumentType(offer.documentType, offer.offerMode)
  const documentPolicy = getDocumentTypePolicy(effectiveDocumentType)

  // Idempotent: already accepted — still ensure job + payment linkage for binding offers
  if (offer.status === 'accepted') {
    if (offer.createdJobId) {
      const existingJob = getJobById(offer.createdJobId)
      if (existingJob) {
        if (!existingJob.proposalSentAt) {
          await markProposalSent(existingJob.id, offer.sentAt)
        }
        if (!existingJob.proposalAcceptedAt) {
          await markProposalAccepted(existingJob.id)
        }
        const linkedProjectId = await ensureProjectForAcceptedOffer(
          existingJob,
          conversation,
          preferredProjectId,
          documentPolicy.allowsPaymentGating
        )
        // non-binding: no payment / escrow linkage
        if (documentPolicy.allowsPaymentGating) {
          const parsedAmount = parseJobAmount(offer.price)
          await ensurePaymentForJob(existingJob.id, parsedAmount ?? undefined, {
            projectId: linkedProjectId ?? existingJob.projectId,
            customerUserId: existingJob.customerUserId,
            craftsmanUserId: existingJob.craftsmanUserId,
            offerId: offer.id,
          })
          if (parsedAmount !== null) {
            await updatePaymentAmounts(existingJob.id, parsedAmount, {
              projectId: linkedProjectId ?? existingJob.projectId,
              customerUserId: existingJob.customerUserId,
              craftsmanUserId: existingJob.craftsmanUserId,
              offerId: offer.id,
            })
          }
          if (parsedAmount !== null) {
            await ensureEscrowPlan({
              sourceOfferId: offer.id,
              jobId: existingJob.id,
              customerUserId: offer.customerUserId,
              providerId: existingJob.providerId ?? offer.craftsmanUserId,
              totalAmount: parsedAmount,
            })
          }
        }
      }
    }
    return offer
  }

  // Paket 1: non-binding offers (estimate, diagnosis) still create a Job for
  // tracking purposes — they just skip payment/escrow/invoice.
  // documentPolicy.allowsPaymentGating = false gates those steps below.

  // Guard: can only accept pending offers
  if (offer.status !== 'pending') {
    const msg = `Cannot accept offer ${offerId}: current status is '${offer.status}'. Only pending offers can be accepted.`
    logWarning('workflow.offer.invalid_accept', {
      offerId,
      currentStatus: offer.status,
    })
    throw new Error(msg)
  }

  // Guard: reject acceptance if the offer's validity period has expired.
  // Catches the window where validUntil has passed but the expiry cron has not yet run.
  if (offer.validUntil) {
    const todayUTC = new Date().toISOString().slice(0, 10)
    if (offer.validUntil < todayUTC) {
      const msg = `Cannot accept offer ${offerId}: offer validity expired on ${offer.validUntil}`
      logWarning('workflow.offer.expired_accept_rejected', { offerId, validUntil: offer.validUntil })
      throw new Error(msg)
    }
  }

  try {
    let resolvedJob =
      (offer.createdJobId ? getJobById(offer.createdJobId) : undefined) ??
      (offer.conversationId
        ? findJobForConversation(offer.conversationId, preferredProjectId)
        : undefined)

    if (!resolvedJob) {
      // No job yet — create on acceptance, using the true send timestamp from the offer
      const jobId = generateUUID()
      const projectId = preferredProjectId ?? generateProjectId()

      // Resolve the canonical providers.id for the FK column.
      // offer.craftsmanUserId is the auth user ID (providers.profile_id),
      // but jobs.provider_id references providers.id (DB-generated UUID).
      const providerId = offer.craftsmanUserId
        ? await resolveProviderId(offer.craftsmanUserId)
        : undefined

      // Resolve commercial origin for this customer↔craftsman pair before
      // creating the job — same resolution priority as convertInquiryToProjectWorkflow:
      //   1. Existing relationship in session cache or Supabase record
      //      (e.g. pre-created by recordInviteRelationship → merchant_brought)
      //   2. Infer from conversation inquiryOrigin → always platform_acquired
      //   3. DB error → 'unknown_pending_resolution' (blocks payment until reconciled)
      let commercialOrigin: JobCommercialOrigin | undefined
      if (offer.customerUserId && offer.craftsmanUserId) {
        commercialOrigin = await resolveAndEnsureRelationship(
          offer.customerUserId,
          offer.craftsmanUserId,
          { inquiryOrigin: conversation?.inquiryOrigin ?? null },
        )
      }

      // Derive jobKind from documentType policy (Paket 2).
      // This stamps the Job with its commercial origin so downstream guards
      // (execution, payment) can enforce policy without joining back to the Offer.
      const jobKind = getJobKindForDocumentType(effectiveDocumentType)

      const newJob: Job = {
        id: jobId,
        projectId,
        title: `Auftrag aus Angebot`,
        customer: conversation?.customerName ?? '',
        location: conversation?.projectLocation ?? 'Ort folgt',
        dateLabel: conversation?.projectStatusLabel ?? 'Termin offen',
        status: 'booked',
        amount: offer.price,
        description: offer.description ?? '',
        paymentState: documentPolicy.allowsPaymentGating ? 'deposit_required' : 'none',
        documentationStatus: 'Noch keine Dokumentation',
        assignedMemberIds: [],
        notes: [],
        photoCount: 0,
        activities: [],
        providerId,
        craftsmanUserId: offer.craftsmanUserId,
        customerUserId: offer.customerUserId,
        // C-10: Spatial-Offers carry NULL conversationId — coerce to undefined
        // so the Job FK (jobs.source_conversation_id) is left NULL too.
        sourceConversationId: offer.conversationId ?? undefined,
        sourceOfferId: offer.id,
        proposalSentAt: offer.sentAt,
        proposalAcceptedAt: acceptedAt,
        jobKind,
        ...(commercialOrigin != null && { commercialOrigin }),
        ...(commercialOrigin != null && {
          attributionStatus: commercialOrigin === 'unknown_pending_resolution'
            ? ('pending' as const)
            : ('finalized' as const),
        }),
      }
      await addJob(newJob)
      resolvedJob = newJob

      logInfo('workflow.offer.job_created', {
        offerId,
        jobId,
        conversationId: offer.conversationId,
      })
    }

    if (!resolvedJob.proposalSentAt) {
      // offer.sentAt is guaranteed non-falsy (guard at line 307–308).
      // The job may have been created through a separate flow (e.g. inquiry
      // conversion) without the sent timestamp.  Sync it now.
      await markProposalSent(resolvedJob.id, offer.sentAt)
      resolvedJob = getJobById(resolvedJob.id) ?? resolvedJob
    }

    // Backfill sourceOfferId for pre-existing jobs that were created via
    // inquiry conversion before the offer existed.  Without this, the
    // escrow plan recovery path dead-ends with SOURCE_OFFER_MISSING.
    if (!resolvedJob.sourceOfferId) {
      await linkJobToSourceOffer(resolvedJob.id, offerId)
      resolvedJob = getJobById(resolvedJob.id) ?? resolvedJob
    }

    const jobId = resolvedJob.id
    let job: Job | undefined = resolvedJob

    if (!resolvedJob.proposalAcceptedAt) {
      await markProposalAccepted(resolvedJob.id)
      job = getJobById(resolvedJob.id)
    }

    if (job) {
      const linkedProjectId = await ensureProjectForAcceptedOffer(
        job,
        conversation,
        preferredProjectId,
        documentPolicy.allowsPaymentGating
      )
      // binding_offer: full payment + escrow linkage.
      // diagnosis: own instant-payment path (no escrow).
      // estimate / cost_estimate: job is tracked but no payment is created.
      if (documentPolicy.allowsPaymentGating) {
        const parsedAmount = parseJobAmount(offer.price)
        const linkage = {
          projectId: linkedProjectId ?? job.projectId,
          customerUserId: job.customerUserId,
          craftsmanUserId: job.craftsmanUserId,
          offerId: offer.id,
        }
        await ensurePaymentForJob(job.id, parsedAmount ?? undefined, linkage)
        if (parsedAmount !== null) {
          await updatePaymentAmounts(job.id, parsedAmount, linkage)
        }
        if (parsedAmount !== null) {
          await ensureEscrowPlan({
            sourceOfferId: offer.id,
            jobId: job.id,
            customerUserId: offer.customerUserId,
            providerId: job.providerId ?? offer.craftsmanUserId,
            totalAmount: parsedAmount,
          })
        }
      } else if (documentPolicy.allowsDiagnosisPayment) {
        // Diagnosis instant-payment path: create a Payment record with
        // state 'diagnosis_payment_pending'. No escrow, no 25/75 split.
        const parsedAmount = parseJobAmount(offer.price)
        if (parsedAmount !== null && parsedAmount > 0) {
          await ensureDiagnosisPaymentForJob(job.id, parsedAmount, {
            projectId: linkedProjectId ?? job.projectId,
            customerUserId: job.customerUserId,
            craftsmanUserId: job.craftsmanUserId,
            offerId: offer.id,
          })
          if (offer.conversationId) {
            await persistPaymentPhaseArtifact({
              conversationId: offer.conversationId,
              jobId: job.id,
              offerId,
              phase: 'diagnosis_payment_due',
              customerUserId: offer.customerUserId,
              craftsmanUserId: offer.craftsmanUserId,
              snapshotPhaseLabel: 'Diagnose-Zahlung fällig',
              snapshotPrice: formatOfferPrice(offer.price),
            })
          }
        }
      }
    }

    await updateOffer(offerId, (o) => ({
      ...o,
      status: 'accepted' as const,
      acceptedAt,
      lockedAt: acceptedAt,
      updatedAt: acceptedAt,
      createdJobId: jobId,
    }))

    // C-10: Spatial-Offers have no thread-anchored artifact — skip the
    // conversation-anchored artifact-phase update for them. The scene-side
    // status reflection lives further down via scene.metadata.offerAcceptedAt.
    if (offer.conversationId) {
    // Update the first-class offer artifact to 'accepted' phase.
    // For binding offers, also persist a payment_phase artifact.
    // For estimate offers, no payment phase artifact — no payment is due.
    await updateOfferArtifactPhase(offer.conversationId, 'accepted', {
      jobId,
      offerId,
      snapshotPhaseLabel: effectiveDocumentType === 'estimate'
        ? 'Schätzung bestätigt'
        : effectiveDocumentType === 'cost_estimate'
          ? 'Kostenvoranschlag bestätigt'
          : effectiveDocumentType === 'diagnosis'
            ? 'Diagnose-Einsatz freigegeben'
            : 'Angebot angenommen',
    })
    if (documentPolicy.allowsPaymentGating) {
      await persistPaymentPhaseArtifact({
        conversationId: offer.conversationId,
        jobId,
        offerId,
        phase: 'payment_due',
        customerUserId: offer.customerUserId,
        craftsmanUserId: offer.craftsmanUserId,
        snapshotPhaseLabel: 'Zahlung fällig',
        snapshotPrice: formatOfferPrice(offer.price),
      })
    }
    } // end if (offer.conversationId) — C-10 spatial path skips thread-artifact updates

    // C-10 · C10.7 — write the accept timestamp back onto the source spatial
    // scene so the SpatialOfferStatusCard + provider/customer surfaces stay
    // in sync without re-querying the offer-repo. Best-effort: a scene write
    // failure does not roll back the offer accept (Job + Payment are already
    // persisted at this point).
    if (offer.sourceSpatialSceneId) {
      try {
        const sceneRepo = getSpatialSceneRepository()
        const currentScene = await sceneRepo.findById(offer.sourceSpatialSceneId)
        if (currentScene) {
          await sceneRepo.update(currentScene.id, {
            metadata: {
              ...currentScene.metadata,
              offerAcceptedAt: acceptedAt,
            },
          })
        }
      } catch (err) {
        logWarning('workflow.offer.scene_sync_failed', {
          offerId,
          sceneId: offer.sourceSpatialSceneId,
          phase: 'accept',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Post-write verification
    const persistedOffer = getOfferById(offerId)
    const persistedJob = getJobById(jobId)
    recordWriteResult({
      operation: 'acceptOfferWorkflow',
      timestamp: Date.now(),
      success: true,
      detail: {
        offerId,
        jobId,
        offerPersistedStatus: persistedOffer?.status ?? null,
        jobPersisted: Boolean(persistedJob),
        conversationId: offer.conversationId,
      },
    })

    logInfo('workflow.offer.accepted', { offerId, jobId })

    ensureTimelineEvent({ jobId, type: 'offer_accepted' })

    // ── Invoice Draft (binding offers only) ──────────────────────────────
    // Invoices are financial documents — non-binding offers do not trigger
    // invoice creation.  No payment obligation exists for estimates/diagnosis.
    if (documentPolicy.allowsPaymentGating) {
      if (!isInvoiceRepositoryHydrated()) {
        logWarning('workflow.offer.invoice_draft_skipped_unhydrated', { jobId, offerId })
      } else {
        const isNewInvoice = !getInvoiceByJobId(jobId)
        if (isNewInvoice) {
          try {
            const jobForInvoice = getJobById(jobId)
            if (jobForInvoice) {
              const issuerData = await resolveIssuerData(offer.craftsmanUserId)
              await ensureInvoiceForJob(jobForInvoice, issuerData)
              ensureTimelineEvent({ jobId, type: 'invoice_created' })
            }
          } catch (err) {
            logWarning('workflow.offer.invoice_draft_failed', { jobId, offerId, error: err })
          }
        }
      }
    }

    recordAnalyticsEvent({
      eventType: 'offer_accepted',
      entityType: 'offer',
      entityId: offerId,
      actorUserId: offer.customerUserId,
    })

    return getOfferById(offerId)
  } catch (err) {
    if (isConflictError(err)) {
      throw new Error('Das Angebot wurde parallel geändert. Bitte lade die Seite neu und versuche es erneut.')
    }
    const errorMessage = normalizeErrorMessage(err)
    recordWriteResult({
      operation: 'acceptOfferWorkflow',
      timestamp: Date.now(),
      success: false,
      error: errorMessage,
      detail: { offerId, conversationId: offer.conversationId },
    })
    throw err instanceof Error ? err : new Error(errorMessage)
  }
}

/**
 * Declines a pending offer.
 *
 * A declined offer cannot be accepted afterwards. The craftsman can create
 * a new offer for the same conversation after declining.
 *
 * @returns The declined Offer
 */
export async function declineOfferWorkflow(offerId: string): Promise<Offer | undefined> {
  const offer = getOfferById(offerId)
  if (!offer) return undefined

  // Idempotent: already declined
  if (offer.status === 'declined') return offer

  // C-10 · C10.7 — Spatial-Offers flow through the same decline pipeline;
  // the conversation-anchored artifact-phase update is skipped null-safe,
  // and the source scene's metadata.offerDeclinedAt is updated at the end.

  // Guard: can only decline pending offers
  if (offer.status !== 'pending') {
    const msg = `Cannot decline offer ${offerId}: current status is '${offer.status}'. Only pending offers can be declined.`
    logWarning('workflow.offer.invalid_decline', {
      offerId,
      currentStatus: offer.status,
    })
    throw new Error(msg)
  }

  const now = Date.now()
  await updateOffer(offerId, (o) => ({
    ...o,
    status: 'declined' as const,
    declinedAt: now,
    updatedAt: now,
  }))

  // Update the first-class offer artifact to 'declined' phase. Spatial-
  // Offers without a conversation anchor skip this step null-safe.
  if (offer.conversationId) {
    try {
      await updateOfferArtifactPhase(offer.conversationId, 'declined', {
        snapshotPhaseLabel: 'Angebot abgelehnt',
      })
    } catch (err) {
      if (isConflictError(err)) {
        throw new Error('Das Angebot wurde parallel geändert. Bitte lade die Seite neu und versuche es erneut.')
      }
      throw err
    }
  }

  // C-10 · C10.7 — scene-side decline reflection.
  if (offer.sourceSpatialSceneId) {
    try {
      const sceneRepo = getSpatialSceneRepository()
      const currentScene = await sceneRepo.findById(offer.sourceSpatialSceneId)
      if (currentScene) {
        await sceneRepo.update(currentScene.id, {
          metadata: {
            ...currentScene.metadata,
            offerDeclinedAt: now,
          },
        })
      }
    } catch (err) {
      logWarning('workflow.offer.scene_sync_failed', {
        offerId,
        sceneId: offer.sourceSpatialSceneId,
        phase: 'decline',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logInfo('workflow.offer.declined', { offerId })

  recordAnalyticsEvent({
    eventType: 'offer_declined',
    entityType: 'offer',
    entityId: offerId,
    actorUserId: offer.customerUserId,
  })

  return getOfferById(offerId)
}

/**
 * Supersedes an existing pending offer and creates a revised version.
 *
 * Use this when the craftsman needs to revise a sent (pending) offer.
 * The old offer is marked as `superseded`; a new offer is created with an
 * incremented version number and the same conversation linkage.
 *
 * The new offer params may omit fields to carry them over from the old offer —
 * but price is always required.
 *
 * @param offerId    - ID of the pending offer to supersede
 * @param newParams  - Full params for the replacement offer (price required)
 * @returns The newly created replacement Offer
 * @throws  If the offer to supersede is not found or not in `pending` status
 */
export async function supersedeOfferWorkflow(
  offerId: string,
  newParams: Parameters<typeof createOfferWorkflow>[0]
): Promise<Offer> {
  const existing = getOfferById(offerId)
  if (!existing) {
    throw new Error(`Cannot supersede offer ${offerId}: not found`)
  }
  if (existing.status !== 'pending') {
    throw new Error(
      `Cannot supersede offer ${offerId}: current status is '${existing.status}'. Only pending offers can be superseded.`
    )
  }
  // C-10: Spatial-Offers are superseded by issuing a fresh `create_spatial_offer`
  // RPC call against the same scene — the in-RPC pre-check (step 11) marks the
  // old offer canonical for the scene. This conversation-anchored supersede
  // path would lose that linkage and crash on the artifact-phase update.
  if (existing.conversationId == null) {
    throw new Error(
      `supersedeOfferWorkflow: offer ${offerId} has no conversationId — Spatial-Offers are superseded via a fresh create_spatial_offer RPC call against the same scene`
    )
  }

  const now = Date.now()

  // 1. Mark the existing offer as superseded
  await updateOffer(offerId, (o) => ({
    ...o,
    status: 'superseded' as const,
    updatedAt: now,
  }))

  // 2. Update thread artifact for the superseded offer
  await updateOfferArtifactPhase(existing.conversationId, 'superseded', {
    offerId,
    snapshotPhaseLabel: 'Angebot ersetzt',
  })

  logInfo('workflow.offer.superseded', { offerId, conversationId: existing.conversationId })

  // 3. Create the replacement offer with incremented version.
  //    Pass the old version so createOfferWorkflow stamps it correctly.
  //    Carry forward offerMode and offerRef if not explicitly overridden.
  const oldVersion = existing.version ?? 1
  const replacement = await createOfferWorkflow({
    documentType: existing.documentType,
    offerMode: existing.offerMode,
    ...newParams,
    conversationId: existing.conversationId,
    version: oldVersion + 1,
  })

  logInfo('workflow.offer.supersede_replacement_created', {
    oldOfferId: offerId,
    newOfferId: replacement.id,
    version: replacement.version,
    conversationId: existing.conversationId,
  })

  recordAnalyticsEvent({
    eventType: 'offer_superseded',
    entityType: 'offer',
    entityId: offerId,
    actorUserId: existing.craftsmanUserId,
  })

  return replacement
}

/**
 * Returns offers for a conversation grouped by version — most recent first.
 * Useful for rendering the offer history in a thread.
 */
export function getOfferVersionHistory(conversationId: string): Offer[] {
  return getOffersByConversationId(conversationId)
    .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))
}
