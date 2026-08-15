/**
 * ChangeOrder Workflow — State Machine
 *
 * Implements the lifecycle transitions for ChangeOrder (Nachtrag):
 *   draft    → pending   (send,   craftsman only)
 *   pending  → accepted  (accept, customer only)
 *   pending  → declined  (decline, customer only)
 *   pending  → cancelled (cancel, craftsman only)
 *
 * On acceptance:
 * - job.amount is updated to reflect the new commercial total
 * - payment.amounts.totalAmount is updated if still in deposit_required
 * - if payment is already locked (deposit paid or beyond): a SupplementaryPaymentRequest
 *   is created to carry the delta truth — the original payment is NOT silently mutated
 *
 * All transitions are idempotent: calling them again in the same target state
 * is a no-op. Role guards are enforced via callerUserId parameter.
 */

import type { ChangeOrder } from '../changeOrders/types'
import {
  getChangeOrderById,
  addChangeOrder,
  updateChangeOrder,
} from '../changeOrders'
import { getJobById, updateJobAmount } from '../jobs'
import { getPaymentForJob } from '../payments/service'
import { updatePaymentAmounts } from '../payments'
import { ensureSupplementaryPaymentRequest } from '../payments/supplementary'
import { createLedgerEntry } from '../payments/ledger/ledgerService'
import { ensureTimelineEvent } from '../timeline'
import { logInfo, logWarning } from '../observability'
import { formatEuro, formatCents } from '../shared/formatters'
import { jobKindAllowsStandardExecution } from '../offers/commercialDocumentPolicy'
import { generateUUID } from '../shared/generateUUID'
import {
  persistChangeOrderArtifact,
  updateChangeOrderArtifactPhase,
} from '../messages/threadArtifactService'
import { sendMessageWorkflow } from './chatWorkflow'

// ── Create + Send (combined V1 path) ─────────────────────────────────────────

/**
 * Creates a new ChangeOrder (Nachtrag) for an existing Job and immediately
 * sends it to the customer (draft → pending in one step).
 *
 * This is the canonical V1 entry point for the craftsman composer.  There is
 * no separate "save draft" step — the ChangeOrder is always sent immediately.
 *
 * Constraints enforced:
 *   - Job must exist and be of standard kind (binding_offer origin)
 *   - Job must be in 'in_progress' or 'waiting_payment' state
 *   - Caller must be the craftsman for this job
 *
 * When the job has a canonical chat_threads id (job.sourceConversationId), the
 * Nachtrag is emitted as a real artifact_card chat message (+ a thread_artifacts
 * snapshot) so the card appears in the stream for both parties — mirroring the
 * Project/Invoice producer model.
 *
 * @throws If the job does not exist, is not a standard job, is in a terminal
 *         state, or the caller is not the craftsman.
 */
export async function createChangeOrderWorkflow(params: {
  jobId: string
  craftsmanUserId: string
  customerUserId: string
  /** Human-readable description of what changed and why (required). */
  description: string
  /** Formatted price string for the delta amount (e.g. "450 €"). */
  price: string
  /** Delta amount in cents (minor units). Positive = more cost, negative = reduction. */
  grossTotal: number
  /** Net total in cents (optional, for VAT-aware display). */
  netTotal?: number
  /** VAT rate as percentage (e.g. 19). */
  vatRate?: number
  /** The accepted offer this ChangeOrder references (for delta computation). */
  sourceOfferId?: string
  /** @deprecated No longer the delivery key — card emission is gated on
   *  job.sourceConversationId. Still accepted for caller compatibility. */
  conversationId?: string
}): Promise<ChangeOrder> {
  const job = getJobById(params.jobId)
  if (!job) {
    throw new Error(
      `createChangeOrderWorkflow: job ${params.jobId} not found.`
    )
  }

  // Guard: standard jobs only
  if (!jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis' ? 'Diagnose-Auftrag' : 'Schätzungs-Verfolgungsauftrag'
    throw new Error(
      `createChangeOrderWorkflow: job ${params.jobId} ist ein ${kindLabel}. ` +
      `Nachträge sind nur für Standard-Aufträge möglich.`
    )
  }

  // Guard: job must be in an active execution state
  const allowedStatuses = new Set(['in_progress', 'waiting_payment'])
  if (!allowedStatuses.has(job.status)) {
    throw new Error(
      `createChangeOrderWorkflow: job ${params.jobId} ist im Status '${job.status}'. ` +
      `Nachträge sind nur bei 'in_progress' oder 'waiting_payment' möglich.`
    )
  }

  // Guard: caller must be the craftsman on this job
  if (job.craftsmanUserId && job.craftsmanUserId !== params.craftsmanUserId) {
    throw new Error(
      `createChangeOrderWorkflow: Aufrufer ${params.craftsmanUserId} ist nicht der Handwerker für Auftrag ${params.jobId}.`
    )
  }

  const now = Date.now()
  const changeOrderId = generateUUID()

  const changeOrder: ChangeOrder = {
    id: changeOrderId,
    jobId: params.jobId,
    craftsmanUserId: params.craftsmanUserId,
    customerUserId: params.customerUserId,
    description: params.description,
    price: params.price,
    currency: 'EUR',
    grossTotal: params.grossTotal,
    ...(params.netTotal != null && { netTotal: params.netTotal }),
    ...(params.vatRate != null && { vatRate: params.vatRate }),
    ...(params.sourceOfferId && { sourceOfferId: params.sourceOfferId }),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  }

  await addChangeOrder(changeOrder)

  // Immediately send: draft → pending
  const sent = await sendChangeOrderWorkflow(changeOrderId, params.craftsmanUserId)

  logInfo('workflow.changeOrder.created', {
    changeOrderId,
    jobId: params.jobId,
    grossTotal: params.grossTotal,
  })

  // Thread artifact + stream card — mirrors emitInvoiceArtifactToThread. The
  // composer's conversationId falls back to the legacy getConversationByProjectId
  // (a conversations.id sendMessageWorkflow cannot target), so resolve the
  // canonical chat_threads id from the job for BOTH the snapshot persist and the
  // artifact_card emit. The emit is the fix: without it the Nachtrag card has no
  // stream surface since Block 1 removed the persistent top-cards.
  const threadId = job.sourceConversationId
  if (threadId) {
    const deltaLabel =
      params.grossTotal >= 0
        ? `+${formatCents(params.grossTotal)}`
        : formatCents(params.grossTotal)
    // 1) Party-scoped snapshot (deterministic ta_co_<id>) — reload/hydration
    //    fallback DATA for the card. Best-effort.
    try {
      await persistChangeOrderArtifact({
        conversationId: threadId,
        changeOrderId,
        jobId: params.jobId,
        phase: 'pending',
        customerUserId: params.customerUserId,
        craftsmanUserId: params.craftsmanUserId,
        snapshotDeltaAmount: deltaLabel,
        snapshotDescription: params.description,
        snapshotPhaseLabel: 'Nachtrag liegt vor',
      })
    } catch (err) {
      logWarning('workflow.changeOrder.artifact_persist_failed', {
        changeOrderId,
        conversationId: threadId,
        error: String(err),
      })
    }
    // 2) The real artifact_card chat message — this RENDERS the card in the
    //    stream (ChatArtifactCardCompact) chronologically for both parties.
    //    The deterministic clientMessageId dedups repeat emits to one card.
    try {
      await sendMessageWorkflow({
        threadId,
        artifactType: 'ChangeOrder',
        artifactId: changeOrderId,
        clientMessageId: `co-card-${changeOrderId}`,
        callerRole: 'craftsman',
        currentUserId: params.craftsmanUserId ?? null,
      })
    } catch (err) {
      logWarning('workflow.changeOrder.artifact_card_send_failed', {
        changeOrderId,
        conversationId: threadId,
        error: String(err),
      })
    }
  } else {
    // No canonical chat_threads id (legacy-only / pre-cutover job): the card has
    // no stream surface. Log for parity with emitInvoiceArtifactToThread.
    logWarning('workflow.changeOrder.artifact_no_thread', {
      changeOrderId,
      jobId: params.jobId,
    })
  }

  return sent ?? changeOrder
}

// ── Send (draft → pending) ───────────────────────────────────────────────────

/**
 * Sends a ChangeOrder to the customer (draft → pending).
 * Only the craftsman who created the ChangeOrder may send it.
 *
 * @throws If caller is not the craftsman, or ChangeOrder is not in 'draft'.
 */
export async function sendChangeOrderWorkflow(
  changeOrderId: string,
  callerUserId: string
): Promise<ChangeOrder | undefined> {
  const co = getChangeOrderById(changeOrderId)
  if (!co) return undefined

  // Idempotent
  if (co.status === 'pending') return co

  // Guard: only the craftsman may send
  if (co.craftsmanUserId !== callerUserId) {
    throw new Error(
      `sendChangeOrderWorkflow: caller ${callerUserId} is not the craftsman for ChangeOrder ${changeOrderId}`
    )
  }

  // Guard: must be in draft to send
  if (co.status !== 'draft') {
    throw new Error(
      `sendChangeOrderWorkflow: ChangeOrder ${changeOrderId} is '${co.status}', not 'draft'. Cannot send.`
    )
  }

  // Paket 2: ChangeOrders may only be sent against standard (binding_offer-origin) jobs.
  // estimate_tracking and diagnosis jobs are tracking/diagnostic-only — they have no
  // binding commercial basis that a ChangeOrder could amend.
  const job = getJobById(co.jobId)
  if (job && !jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis' ? 'Diagnose-Auftrag' : 'Schätzungs-Verfolgungsauftrag'
    throw new Error(
      `sendChangeOrderWorkflow: ChangeOrder ${changeOrderId} cannot be sent — job ${co.jobId} is a ${kindLabel} (jobKind: '${job.jobKind}'). ` +
      `ChangeOrders require a standard binding_offer-origin job.`
    )
  }

  const now = Date.now()
  await updateChangeOrder(changeOrderId, (c) => ({
    ...c,
    status: 'pending' as const,
    sentAt: now,
    updatedAt: now,
  }))

  ensureTimelineEvent({ jobId: co.jobId, type: 'change_order_sent' })
  logInfo('workflow.changeOrder.sent', { changeOrderId, jobId: co.jobId })

  return getChangeOrderById(changeOrderId)
}

// ── Accept (pending → accepted) ──────────────────────────────────────────────

/**
 * Customer accepts a pending ChangeOrder (pending → accepted).
 *
 * Commercial effects:
 * - job.amount updated to new total (current total + delta)
 * - payment.amounts.totalAmount updated if still in deposit_required
 * - if payment is locked (past deposit_required): creates a SupplementaryPaymentRequest
 *   for the delta amount. The original Payment is not mutated. A timeline event
 *   'supplementary_payment_required' and a ledger entry are created.
 *
 * @throws If caller is not the customer, or ChangeOrder is not in 'pending'.
 */
export async function acceptChangeOrderWorkflow(
  changeOrderId: string,
  callerUserId: string
): Promise<ChangeOrder | undefined> {
  const co = getChangeOrderById(changeOrderId)
  if (!co) return undefined

  // Idempotent
  if (co.status === 'accepted') return co

  // Guard: only the customer may accept
  if (co.customerUserId !== callerUserId) {
    throw new Error(
      `acceptChangeOrderWorkflow: caller ${callerUserId} is not the customer for ChangeOrder ${changeOrderId}`
    )
  }

  // Guard: must be pending to accept
  if (co.status !== 'pending') {
    throw new Error(
      `acceptChangeOrderWorkflow: ChangeOrder ${changeOrderId} is '${co.status}', not 'pending'. Cannot accept.`
    )
  }

  // Paket 2: defense-in-depth — ChangeOrders must not be accepted against
  // estimate_tracking or diagnosis jobs. Should have been blocked at send time,
  // but guard here too to prevent stale-state exploitation.
  const job = getJobById(co.jobId)
  if (job && !jobKindAllowsStandardExecution(job.jobKind)) {
    const kindLabel = job.jobKind === 'diagnosis' ? 'Diagnose-Auftrag' : 'Schätzungs-Verfolgungsauftrag'
    throw new Error(
      `acceptChangeOrderWorkflow: ChangeOrder ${changeOrderId} cannot be accepted — job ${co.jobId} is a ${kindLabel}. ` +
      `ChangeOrders require a standard binding_offer-origin job.`
    )
  }

  const now = Date.now()
  await updateChangeOrder(changeOrderId, (c) => ({
    ...c,
    status: 'accepted' as const,
    acceptedAt: now,
    updatedAt: now,
  }))

  // Effect: update Job.amount and Payment total.
  // grossTotal is in cents (minor units); formatEuro and updatePaymentAmounts use euros.
  if (co.grossTotal != null) {
    const payment = getPaymentForJob(co.jobId)
    const currentTotalEuros = payment?.amounts.totalAmount ?? 0
    const deltaEuros = co.grossTotal / 100
    const newTotalEuros = currentTotalEuros + deltaEuros

    // Payment total update — only effective while still in deposit_required.
    if (payment) {
      if (payment.state !== 'deposit_required') {
        // Payment amounts are locked.  Original payment record is NOT mutated.
        // Instead, create a SupplementaryPaymentRequest to carry the delta truth.
        logWarning('workflow.changeOrder.payment_amounts_locked', {
          changeOrderId,
          jobId: co.jobId,
          paymentState: payment.state,
          deltaEuros,
          note: 'Deposit already paid. Payment total locked. Creating supplementary payment request for CO delta.',
        })

        if (co.grossTotal != null && co.grossTotal > 0) {
          try {
            const suppRequest = await ensureSupplementaryPaymentRequest({
              changeOrderId,
              jobId: co.jobId,
              originalPaymentId: payment.id,
              customerUserId: co.customerUserId,
              craftsmanUserId: co.craftsmanUserId,
              amountCents: co.grossTotal,
            })

            if (suppRequest) {
              // Ledger: record the supplementary obligation for audit/GMV tracking
              createLedgerEntry({
                paymentId: payment.id,
                jobId: co.jobId,
                type: 'supplementary_created',
                amount: deltaEuros,
                note: `Nachzahlungsbedarf aus Nachtrag ${changeOrderId} (Betrag gesperrt)`,
              })

              // Timeline: surface the event so both parties see it in the project history
              ensureTimelineEvent({
                jobId: co.jobId,
                type: 'supplementary_payment_required',
              })

              logInfo('workflow.changeOrder.supplementary_payment_created', {
                changeOrderId,
                supplementaryPaymentId: suppRequest.id,
                jobId: co.jobId,
                amountCents: co.grossTotal,
              })
            }
          } catch (err) {
            // Log prominently but do not block the ChangeOrder acceptance.
            // The CO is accepted; the supplementary request failure is recoverable
            // (re-run on next hydration or manual repair).
            logWarning('workflow.changeOrder.supplementary_payment_create_failed', {
              changeOrderId,
              jobId: co.jobId,
              error: String(err),
            })
          }
        }
      } else {
        const job = getJobById(co.jobId)
        await updatePaymentAmounts(co.jobId, newTotalEuros, {
          projectId: job?.projectId,
          customerUserId: co.customerUserId,
          craftsmanUserId: co.craftsmanUserId,
          offerId: co.sourceOfferId,
        })
      }
    }

    // Always update job display amount regardless of payment lock state.
    if (getJobById(co.jobId)) {
      await updateJobAmount(co.jobId, formatEuro(newTotalEuros))
    }
  }

  ensureTimelineEvent({ jobId: co.jobId, type: 'change_order_accepted' })
  logInfo('workflow.changeOrder.accepted', { changeOrderId, jobId: co.jobId })

  // Update thread artifact phase (best-effort, non-critical)
  try {
    await updateChangeOrderArtifactPhase(changeOrderId, 'accepted', {
      snapshotPhaseLabel: 'Nachtrag angenommen',
    })
  } catch { /* non-critical */ }

  return getChangeOrderById(changeOrderId)
}

// ── Decline (pending → declined) ─────────────────────────────────────────────

/**
 * Customer declines a pending ChangeOrder (pending → declined).
 * Job and payment are unchanged — no commercial effects.
 *
 * @throws If caller is not the customer, or ChangeOrder is not in 'pending'.
 */
export async function declineChangeOrderWorkflow(
  changeOrderId: string,
  callerUserId: string
): Promise<ChangeOrder | undefined> {
  const co = getChangeOrderById(changeOrderId)
  if (!co) return undefined

  // Idempotent
  if (co.status === 'declined') return co

  // Guard: only the customer may decline
  if (co.customerUserId !== callerUserId) {
    throw new Error(
      `declineChangeOrderWorkflow: caller ${callerUserId} is not the customer for ChangeOrder ${changeOrderId}`
    )
  }

  // Guard: must be pending to decline
  if (co.status !== 'pending') {
    throw new Error(
      `declineChangeOrderWorkflow: ChangeOrder ${changeOrderId} is '${co.status}', not 'pending'. Cannot decline.`
    )
  }

  const now = Date.now()
  await updateChangeOrder(changeOrderId, (c) => ({
    ...c,
    status: 'declined' as const,
    declinedAt: now,
    updatedAt: now,
  }))

  ensureTimelineEvent({ jobId: co.jobId, type: 'change_order_declined' })
  logInfo('workflow.changeOrder.declined', { changeOrderId, jobId: co.jobId })

  // Update thread artifact phase (best-effort, non-critical)
  try {
    await updateChangeOrderArtifactPhase(changeOrderId, 'declined', {
      snapshotPhaseLabel: 'Nachtrag abgelehnt',
    })
  } catch { /* non-critical */ }

  return getChangeOrderById(changeOrderId)
}

// ── Cancel (pending → cancelled) ─────────────────────────────────────────────

/**
 * Craftsman withdraws a pending ChangeOrder before the customer decides
 * (pending → cancelled). Job and payment are unchanged.
 *
 * Note: a draft ChangeOrder should simply be deleted, not cancelled.
 *
 * @throws If caller is not the craftsman, or ChangeOrder is not in 'pending'.
 */
export async function cancelChangeOrderWorkflow(
  changeOrderId: string,
  callerUserId: string
): Promise<ChangeOrder | undefined> {
  const co = getChangeOrderById(changeOrderId)
  if (!co) return undefined

  // Idempotent
  if (co.status === 'cancelled') return co

  // Guard: only the craftsman may cancel
  if (co.craftsmanUserId !== callerUserId) {
    throw new Error(
      `cancelChangeOrderWorkflow: caller ${callerUserId} is not the craftsman for ChangeOrder ${changeOrderId}`
    )
  }

  // Guard: must be pending to cancel (draft → delete, not cancel)
  if (co.status !== 'pending') {
    throw new Error(
      `cancelChangeOrderWorkflow: ChangeOrder ${changeOrderId} is '${co.status}', not 'pending'. Cannot cancel.`
    )
  }

  const now = Date.now()
  await updateChangeOrder(changeOrderId, (c) => ({
    ...c,
    status: 'cancelled' as const,
    updatedAt: now,
  }))

  ensureTimelineEvent({ jobId: co.jobId, type: 'change_order_cancelled' })
  logInfo('workflow.changeOrder.cancelled', { changeOrderId, jobId: co.jobId })

  // Update thread artifact phase (best-effort, non-critical)
  try {
    await updateChangeOrderArtifactPhase(changeOrderId, 'cancelled', {
      snapshotPhaseLabel: 'Nachtrag zurückgezogen',
    })
  } catch { /* non-critical */ }

  return getChangeOrderById(changeOrderId)
}
