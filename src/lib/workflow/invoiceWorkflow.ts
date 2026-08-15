/**
 * Invoice Workflow — Explicit Craftsman Actions
 *
 * issueInvoiceWorkflow              — draft → issued (engine baseline only)
 * issueInvoiceWithSnapshotWorkflow  — draft → issued (Block 7.1B3 §14-Pfad)
 * markInvoiceSentWorkflow           — issued → sent
 *
 * `issueInvoiceWorkflow` bleibt der dünne Pfad für Legacy- und Test-Aufrufer
 * — Engine validiert nur Baseline (Placeholder, parties, lineItems).
 *
 * `issueInvoiceWithSnapshotWorkflow` ist der Production-Pfad ab Block 7.1B3:
 * lädt Provider-Tax-Profile, Customer-Billing (via SECURITY-DEFINER-RPC),
 * akzeptierte ChangeOrders, SupplementaryPayments und Schedule, baut den
 * §14-Snapshot via `buildInvoiceSnapshot`, validiert die §14-Hard-Gates über
 * `validateInvoiceSnapshotComplete` und setzt Snapshot + status='issued'
 * atomisch über die Repository-Update-Funktion.
 */

import { getInvoiceByJobId, isInvoiceRepositoryHydrated } from '../invoices/invoiceStore'
import { transitionInvoiceStatus } from '../invoices/invoiceEngine'
import {
  buildInvoiceSnapshot,
  type LineItemVatOverride,
} from '../invoices/invoiceSnapshotBuilder'
import {
  resolveDefaultServicePeriod,
  normalizeServicePeriod,
} from '../invoices/invoiceServicePeriodResolver'
import { validateInvoiceSnapshotComplete } from '../invoices/invoiceValidation'
import type { InvoiceServicePeriod } from '../invoices/types'
import { getInvoiceRepository } from '../invoices/repository'
import { ensureTimelineEvent } from '../timeline'
import { logWarning } from '../observability'
import { getJobs, getJobById } from '../jobs'
import { getOfferById, getAcceptedOfferByJobId } from '../offers'
import { getChangeOrdersByJobId } from '../changeOrders'
import { getSupplementaryPaymentsByJobId } from '../payments/supplementary'
import { getMyProviderProfile } from '../providers/providerProfileService'
import { getCustomerBillingForInvoice } from '../customer/customerBillingProfileService'
import { getScheduleForJob } from '../operations'
import { formatEuro } from '../shared/formatters'
import { persistInvoiceArtifact, updateInvoiceArtifactPhase } from '../messages/threadArtifactService'
import { sendMessageWorkflow } from './chatWorkflow'

export type IssueInvoiceWithSnapshotInput = {
  /** Vom IssueSheet bestätigter / angepasster Leistungszeitraum. */
  servicePeriod?: InvoiceServicePeriod
  /** Optional: pro Position Override für Kategorie und Steuersatz. */
  lineItemOverrides?: LineItemVatOverride[]
}

/**
 * Legacy / engine-thin issue path. Lässt die Engine mit Baseline-Validation
 * laufen. Production sollte stattdessen `issueInvoiceWithSnapshotWorkflow`
 * aufrufen.
 *
 * Idempotent: returns silently if the invoice is already issued.
 *
 * Throws if:
 * - No invoice exists for the job
 * - Engine baseline precondition fails (placeholder / incomplete data, etc.)
 *
 * Returns silently when the invoice repository is not yet hydrated.
 */
export async function issueInvoiceWorkflow(jobId: string): Promise<void> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.issue.skipped_unhydrated', { jobId })
    return
  }

  const invoice = getInvoiceByJobId(jobId)
  if (!invoice) {
    throw new Error(`issueInvoiceWorkflow: no invoice found for job "${jobId}"`)
  }

  // Idempotency: if already issued, this is a safe double-action.
  if (invoice.status === 'issued') {
    logWarning('invoice.issue.already_issued', { jobId })
    return
  }

  await getInvoiceRepository().update(invoice.id, (inv) =>
    transitionInvoiceStatus(inv, 'issued')
  )

  ensureTimelineEvent({ jobId, type: 'invoice_issued' })

  await emitInvoiceArtifactOnIssue(jobId)
}

/**
 * Block 7.1B3 — §14-konforme Issue-Transition. Pflicht-Pfad aus dem
 * IssueInvoiceSheet.
 */
export async function issueInvoiceWithSnapshotWorkflow(
  jobId: string,
  input: IssueInvoiceWithSnapshotInput = {},
): Promise<void> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.issueWithSnapshot.skipped_unhydrated', { jobId })
    return
  }

  const invoice = getInvoiceByJobId(jobId)
  if (!invoice) {
    throw new Error(
      `issueInvoiceWithSnapshotWorkflow: no invoice found for job "${jobId}"`,
    )
  }
  if (invoice.status === 'issued') {
    logWarning('invoice.issueWithSnapshot.already_issued', { jobId })
    return
  }

  const job = getJobs().find((j) => j.id === jobId)
  if (!job) {
    throw new Error(
      `issueInvoiceWithSnapshotWorkflow: job "${jobId}" not found while issuing invoice.`,
    )
  }

  // ── Domain-Daten für Snapshot laden ────────────────────────────────────────
  const offer = job.sourceOfferId
    ? getOfferById(job.sourceOfferId) ?? null
    : getAcceptedOfferByJobId(job.id) ?? null

  const acceptedChangeOrders = getChangeOrdersByJobId(job.id).filter(
    (co) => co.status === 'accepted',
  )
  const supplementaryPayments = getSupplementaryPaymentsByJobId(job.id)

  const providerProfile = await getMyProviderProfile()
  if (!providerProfile) {
    throw new Error(
      'Invoice cannot be issued: provider profile not found. ' +
        'Lege zuerst dein Betriebsprofil an.',
    )
  }

  const customerBilling = await getCustomerBillingForInvoice(job.id)

  const schedule = getScheduleForJob(job.id) ?? null
  const defaultPeriod = resolveDefaultServicePeriod({ job, schedule })
  const servicePeriod = input.servicePeriod
    ? normalizeServicePeriod(input.servicePeriod)
    : defaultPeriod

  // ── Snapshot bauen ─────────────────────────────────────────────────────────
  const snapshot = buildInvoiceSnapshot({
    job,
    offer,
    acceptedChangeOrders,
    supplementaryPayments,
    provider: {
      providerId: providerProfile.id,
      companyName: providerProfile.companyName,
      businessAddress: providerProfile.businessAddress,
      taxNumber: providerProfile.taxProfile.taxNumber,
      vatId: providerProfile.taxProfile.vatId,
      legalForm: providerProfile.taxProfile.legalForm,
      isKleinunternehmer: providerProfile.taxProfile.isKleinunternehmer,
      defaultVatRate: providerProfile.taxProfile.defaultVatRate,
      iban: providerProfile.taxProfile.iban,
      bic: providerProfile.taxProfile.bic,
    },
    customer: customerBilling
      ? {
          userId: customerBilling.userId,
          billingName: customerBilling.billingName,
          billingAddressLine1: customerBilling.billingAddressLine1,
          billingAddressLine2: customerBilling.billingAddressLine2,
          billingPostalCode: customerBilling.billingPostalCode,
          billingCity: customerBilling.billingCity,
          billingCountry: customerBilling.billingCountry,
          billingEmail: customerBilling.billingEmail,
          billingPhone: customerBilling.billingPhone,
          isBusiness: customerBilling.isBusiness,
          businessName: customerBilling.businessName,
          vatId: customerBilling.vatId,
        }
      : null,
    servicePeriod,
    lineItemOverrides: input.lineItemOverrides,
  })

  // ── Snapshot + Status atomisch speichern ───────────────────────────────────
  await getInvoiceRepository().update(invoice.id, (current) => {
    const withSnapshot = {
      ...current,
      parties: snapshot.parties,
      lineItems: snapshot.lineItems,
      amounts: snapshot.amounts,
      servicePeriod: snapshot.servicePeriod,
      taxBreakdown: snapshot.taxBreakdown,
      taxNote: snapshot.taxNote,
      providerSnapshot: snapshot.providerSnapshot,
      customerSnapshot: snapshot.customerSnapshot,
      sourceOfferId: snapshot.sourceOfferId,
      sourceChangeOrderIds: snapshot.sourceChangeOrderIds,
      sourceSupplementaryPaymentIds: snapshot.sourceSupplementaryPaymentIds,
    }
    // Volle B3-Hard-Gates inkl. Tax-Konsistenz.
    validateInvoiceSnapshotComplete(withSnapshot)
    return transitionInvoiceStatus(withSnapshot, 'issued')
  })

  ensureTimelineEvent({ jobId, type: 'invoice_issued' })

  await emitInvoiceArtifactOnIssue(jobId)
}

/**
 * Wraps emitInvoiceArtifactToThread so a card-delivery failure can never fail
 * the (already-committed) issue transition. Emitting on ISSUE — not on "mark
 * sent" — because the send path is unreliable: payment sync can auto-advance
 * issued→sent (mapPaymentStateToInvoiceStatus maps escrow states → 'sent'),
 * which hides the craftsman's "Versenden" button (gated on status==='issued')
 * before they ever tap it, so the sent-triggered emit would never fire. Issue
 * is the definitive, always-once, craftsman-authored moment.
 */
async function emitInvoiceArtifactOnIssue(jobId: string): Promise<void> {
  try {
    await emitInvoiceArtifactToThread(jobId)
  } catch (err) {
    logWarning('invoice.issue.artifact_emit_failed', { jobId, error: String(err) })
  }
}

/**
 * Marks an issued invoice as sent to the customer.
 *
 * Sets sentAt (via the engine) so the timestamp records when the craftsman
 * explicitly confirmed dispatch. This is the primary sentAt-setting path —
 * syncInvoiceWithPayment may also drive issued → sent for non-draft invoices
 * as a fallback when the payment state advances ahead of explicit craftsman action.
 *
 * Idempotent: returns silently if the invoice is already sent.
 *
 * Throws if:
 * - No invoice exists for the job
 * - The invoice is not in 'issued' or 'sent' status (engine blocks illegal transitions)
 *
 * Returns silently when the invoice repository is not yet hydrated.
 */
export async function markInvoiceSentWorkflow(jobId: string): Promise<void> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.sent.skipped_unhydrated', { jobId })
    return
  }

  const invoice = getInvoiceByJobId(jobId)
  if (!invoice) {
    throw new Error(`markInvoiceSentWorkflow: no invoice found for job "${jobId}"`)
  }

  // Idempotency: if already sent, this is a safe double-action.
  // Any other status that can't transition to 'sent' is a programming error —
  // let the engine throw.
  if (invoice.status === 'sent') {
    logWarning('invoice.sent.already_sent', { jobId })
    return
  }

  await getInvoiceRepository().update(invoice.id, (inv) =>
    transitionInvoiceStatus(inv, 'sent')
  )

  ensureTimelineEvent({ jobId, type: 'invoice_sent' })

  // The Rechnung card is emitted at ISSUE time (emitInvoiceArtifactOnIssue).
  // Here we only advance the thread_artifacts snapshot to 'sent' so the
  // customer's snapshot-fallback card reflects dispatch before its live entity
  // lazy-loads. Best-effort — never fails the send.
  try {
    await updateInvoiceArtifactPhase(invoice.id, 'sent', {
      snapshotPhaseLabel: 'Rechnung versendet',
    })
  } catch (err) {
    logWarning('invoice.sent.artifact_phase_update_failed', { jobId, error: String(err) })
  }
}

/**
 * Emits the invoice (Rechnung) artifact into the customer↔craftsman message
 * thread. Two coordinated writes, each best-effort and independently logged so
 * a failure in one aborts neither the other nor the caller:
 *   1. persistInvoiceArtifact — the party-scoped thread_artifacts snapshot
 *      record (deterministic id `ta_inv_<id>`, reload-stable, RLS-scoped).
 *   2. sendMessageWorkflow(artifactType='Invoice') — the real artifact_card
 *      chat message that places the card chronologically in the stream and is
 *      rendered by ChatArtifactCardCompact (same producer model as Project).
 *
 * The card RENDERS from write #2 (the chat message); write #1 only supplies
 * snapshot fallback DATA for that card. So if #2 fails (caught + logged) while
 * #1 succeeds, no card renders — the snapshot is not an independent render path.
 * At issue time #2 is reliable (craftsman is a resolved thread participant).
 *
 * Idempotent: the deterministic `ta_inv_<id>` record (upsert) + the
 * `inv-card-<id>` clientMessageId (chat dedup) collapse repeat calls to one card.
 *
 * Thread resolution uses ONLY job.sourceConversationId — the canonical
 * chat_threads id (mirrors the funding/offer producers). The legacy
 * getConversationByProjectId path returns a conversations.id, which
 * sendMessageWorkflow (chat_threads-targeted) cannot resolve, so it is not used.
 * The craftsman is the author; currentUserId is passed for the customer-channel
 * block-check only (the DB authors the row from the session uid).
 */
async function emitInvoiceArtifactToThread(jobId: string): Promise<void> {
  const invoice = getInvoiceByJobId(jobId)
  if (!invoice) return

  const job = getJobById(jobId)
  if (!job) return

  const threadId = job.sourceConversationId
  if (!threadId) {
    logWarning('invoice.artifact_no_thread', { jobId, invoiceId: invoice.id })
    return
  }

  const amountLabel = formatEuro(invoice.amounts?.grossAmount ?? 0)
  const phaseLabel =
    invoice.status === 'sent' ? 'Rechnung versendet'
      : invoice.status === 'paid' ? 'Rechnung bezahlt'
      : invoice.status === 'cancelled' ? 'Rechnung storniert'
      : 'Rechnung gestellt'

  try {
    await persistInvoiceArtifact({
      conversationId: threadId,
      invoiceId: invoice.id,
      jobId,
      phase: invoice.status,
      customerUserId: job.customerUserId,
      craftsmanUserId: job.craftsmanUserId,
      snapshotAmount: amountLabel,
      snapshotInvoiceNumber: invoice.invoiceNumber,
      snapshotPhaseLabel: phaseLabel,
    })
  } catch (err) {
    logWarning('invoice.artifact_persist_failed', {
      invoiceId: invoice.id,
      threadId,
      error: String(err),
    })
  }

  try {
    await sendMessageWorkflow({
      threadId,
      artifactType: 'Invoice',
      artifactId: invoice.id,
      clientMessageId: `inv-card-${invoice.id}`,
      callerRole: 'craftsman',
      currentUserId: job.craftsmanUserId ?? null,
    })
  } catch (err) {
    logWarning('invoice.artifact_card_send_failed', {
      invoiceId: invoice.id,
      threadId,
      error: String(err),
    })
  }
}
