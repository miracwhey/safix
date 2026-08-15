import { getJobs, type Job } from '../jobs'
import { getOfferById, getAcceptedOfferByJobId, isOfferRepositoryHydrated } from '../offers'
import { getPaymentForJob } from '../payments'
import { logWarning } from '../observability'
import { ensureTimelineEvent } from '../timeline/timelineService'
import { createInvoiceFromJob, transitionInvoiceStatus } from './invoiceEngine'
import { mapPaymentStateToInvoiceStatus } from './paymentInvoiceSync'
import { KNOWN_PLACEHOLDER_ISSUER_NAMES, KNOWN_PLACEHOLDER_ISSUER_ADDRESSES } from './invoiceValidation'
import { getInvoiceRepository } from './repository'
import { getInvoiceByJobId, isInvoiceRepositoryHydrated } from './invoiceStore'
import type { Invoice, InvoiceStatus } from './types'

export async function ensureInvoiceForJob(
  job: Job,
  issuerData?: { issuerName: string; issuerAddress: string }
): Promise<Invoice> {
  const existing = getInvoiceByJobId(job.id)
  if (existing) {
    // If better issuerData has arrived and the invoice is still a draft with
    // placeholder values, refresh the issuer fields. Drafts created before
    // profile data was available would otherwise stay permanently stuck.
    // Real issuer data (non-placeholder) is never overwritten — this preserves
    // the idempotency guarantee for drafts that already have valid data.
    if (issuerData && existing.status === 'draft') {
      const hasPlaceholderName = KNOWN_PLACEHOLDER_ISSUER_NAMES.has(existing.parties.issuerName)
      const hasPlaceholderAddress = KNOWN_PLACEHOLDER_ISSUER_ADDRESSES.has(existing.parties.issuerAddress)
      if (hasPlaceholderName || hasPlaceholderAddress) {
        await getInvoiceRepository().update(existing.id, (inv) => ({
          ...inv,
          parties: {
            ...inv.parties,
            issuerName: issuerData.issuerName,
            issuerAddress: issuerData.issuerAddress,
          },
        }))
        return getInvoiceByJobId(job.id) ?? existing
      }
    }
    return existing
  }

  // If the job references an Offer, prefer it as the authoritative commercial
  // source. But a referenced offer may be legitimately gone: when a counterparty
  // deletes their account, their offers are CASCADE-deleted while the job and its
  // escrow plan are RETAINED (migration 20260622010000). We must not strand the
  // invoice forever in that case.
  let offer = undefined
  if (job.sourceOfferId) {
    offer = getOfferById(job.sourceOfferId)
    if (!offer) {
      // Not loadable. If the offers repo is not hydrated yet this is transient —
      // fail loudly so the caller retries with real data (falling through here
      // would risk building against an unverified amount). If the repo IS
      // hydrated, the offer is genuinely absent (deleted) → fall through to the
      // canonical/accepted-offer path; the surviving escrow plan carries the
      // authoritative amount.
      if (!isOfferRepositoryHydrated()) {
        throw new Error(
          `Invoice cannot be created for job "${job.id}": referenced offer ` +
          `"${job.sourceOfferId}" not loadable and offers are not hydrated. Retry once loaded.`
        )
      }
      logWarning('invoice.source_offer_deleted_fallback', {
        jobId: job.id,
        sourceOfferId: job.sourceOfferId,
      })
      offer = getAcceptedOfferByJobId(job.id)
    }
  } else {
    // Reverse lookup for accepted offers on jobs that predate sourceOfferId backfill.
    offer = getAcceptedOfferByJobId(job.id)
  }

  const created = createInvoiceFromJob(job, offer, issuerData)

  await getInvoiceRepository().add(created)

  return created
}

export async function ensureInvoiceForJobId(
  jobId: string,
  issuerData?: { issuerName: string; issuerAddress: string }
): Promise<Invoice | undefined> {
  const job = getJobs().find((j) => j.id === jobId)

  if (!job) return undefined

  return ensureInvoiceForJob(job, issuerData)
}

export async function updateInvoiceStatus(
  invoiceId: string,
  nextStatus: InvoiceStatus
): Promise<void> {
  await getInvoiceRepository().update(invoiceId, (invoice) =>
    transitionInvoiceStatus(invoice, nextStatus),
  )
}

/**
 * Advances an invoice status to match the current payment state.
 *
 * Hard draft guard: draft invoices are NEVER advanced by this function.
 * Issuance is a deliberate craftsman action (issueInvoiceWorkflow) — payment
 * events must not auto-issue a draft. This guard is independent of the
 * mapping in mapPaymentStateToInvoiceStatus: even if that mapping were
 * changed, the draft guard here ensures the invariant holds.
 *
 * Non-draft invoices are advanced monotonically through the step-order
 * ['draft', 'issued', 'sent', 'paid']. Retrograde transitions are blocked
 * by the step-order guard (targetIdx <= currentIdx).
 *
 * Note on sentAt: when the sync advances a non-draft invoice to 'sent',
 * transitionInvoiceStatus sets sentAt = Date.now(). This is a known
 * fallback path — the primary sentAt-setting path is markInvoiceSentWorkflow.
 * In practice, if a craftsman issues manually (issueInvoiceWorkflow) and then
 * the payment progresses, the sync will drive issued → sent with a valid sentAt.
 */
export async function syncInvoiceWithPayment(jobId: string): Promise<void> {
  if (!isInvoiceRepositoryHydrated()) {
    logWarning('invoice.sync.skipped_unhydrated', { jobId })
    return
  }

  let invoice = getInvoiceByJobId(jobId)

  // Cache-miss robustness: a provider invoice can sit outside the initial
  // 200-row window, so a by-jobId miss is not proof of absence. Lazy-load by
  // jobId once, then re-read, before giving up.
  if (!invoice) {
    await getInvoiceRepository().ensureLoadedByJobId(jobId)
    invoice = getInvoiceByJobId(jobId)
    if (!invoice) return
  }

  // Hard guard: draft invoices are never advanced by payment sync.
  // Issuance requires explicit craftsman action via issueInvoiceWorkflow.
  if (invoice.status === 'draft') return

  const payment = getPaymentForJob(jobId)

  if (!payment) return

  const targetStatus = mapPaymentStateToInvoiceStatus(payment.state)

  if (invoice.status === targetStatus) return

  const stepOrder: InvoiceStatus[] = ['draft', 'issued', 'sent', 'paid']
  const currentIdx = stepOrder.indexOf(invoice.status)
  const rawTargetIdx = stepOrder.indexOf(targetStatus)

  // R3 single-writer boundary: when a server settle path owns invoice→'paid'
  // (the Supabase trigger on payments), the client must NOT attempt the →'paid'
  // write — it is provider-RLS / due_at_label-immutability rejected, and 'paid'
  // arrives via realtime instead. Clamp the client advance at 'sent'. In-memory
  // / mock mode (no server) keeps driving all the way to 'paid'. This is the
  // architectural boundary, not an error-swallow.
  const sentIdx = stepOrder.indexOf('sent')
  const targetIdx = getInvoiceRepository().serverDrivesPaidStatus()
    ? Math.min(rawTargetIdx, sentIdx)
    : rawTargetIdx

  if (currentIdx === -1 || rawTargetIdx === -1 || targetIdx <= currentIdx) return

  // Capture sentAt before the update so we can detect if the sync drove the
  // invoice through 'sent' (sentAt changes from 0 to >0 on issued → sent).
  const prevSentAt = invoice.sentAt

  await getInvoiceRepository().update(invoice.id, (current) => {
    let stepped: Invoice = current
    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      try {
        stepped = transitionInvoiceStatus(stepped, stepOrder[i])
      } catch {
        // Transition blocked (e.g. terminal status reached) — stop advancing
        break
      }
    }
    return stepped
  })

  // Emit invoice_sent if the sync drove the invoice through the 'sent' state.
  // sentAt transitions from 0 to >0 exclusively on issued → sent, covering both
  // issued → sent (final) and issued → sent → paid (step-through) paths.
  // ensureTimelineEvent is idempotent — no duplicate event if already emitted
  // by markInvoiceSentWorkflow on the explicit craftsman-action path.
  if (prevSentAt === 0) {
    const afterUpdate = getInvoiceByJobId(jobId)
    if (afterUpdate && afterUpdate.sentAt > 0) {
      ensureTimelineEvent({ jobId, type: 'invoice_sent' })
    }
  }
}
