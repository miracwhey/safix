import type { Job } from '../../jobs/types'
import { syncInvoiceWithPayment } from '../../invoices'
import { ensureTimelineEvent } from '../../timeline'
import { createInAppNotification } from '../../inAppNotifications'
import { incrementCompletedJobsCount } from '../../craftsman/craftsmanProfileService'
import { recordAnalyticsEvent } from '../../analytics'
import { logError } from '../../observability'
import { getCalendarEntryByJobId, updateCalendarStatus } from '../../calendar'
import { sendPaymentReleasedEmail } from '../../notifications/delivery'

export type PaymentReleasedContext = {
  jobId: string
  /**
   * Fully resolved Job snapshot from the caller — captured before the
   * transition so the hook never reads stale store state.
   */
  job: Job
}

/**
 * Side effects to run after a successful payment:released transition.
 *
 * This is the single canonical source for all "payment released" side effects.
 * Both the simple escrow release path (paymentWorkflow.ts) and the tranche-
 * based full-plan release path (releaseOperations.ts) call this function.
 *
 * CONTRACT
 * --------
 * - Must only be called AFTER the domain mutations are committed:
 *     payment.state = 'released', job.status = 'completed'
 * - Never throws. All errors are caught and logged internally.
 * - Context must be fully resolved by the caller — no store reads inside.
 *
 * Error handling tiers:
 *   Timeline events       — try/catch, logError, execution continues.
 *   syncInvoiceWithPayment— try/catch, logError (critical — Invoice must
 *                           reflect payment truth, but not at the cost of
 *                           blocking the workflow return value).
 *   Analytics             — direct call (non-throwing by convention).
 *   incrementCompleted    — fire-and-forget, .catch(logError).
 *   createInAppNotification — direct call (non-throwing by convention).
 */
export async function runPaymentReleasedSideEffects(
  ctx: PaymentReleasedContext
): Promise<void> {
  const { jobId, job } = ctx

  // ── Calendar sync: mark appointment as fully completed ───────────────────
  try {
    const calendarEntry = getCalendarEntryByJobId(jobId)
    if (calendarEntry) {
      updateCalendarStatus(calendarEntry.id, 'completed')
    }
  } catch (err) {
    logError('hook.payment_released.calendar_sync_failed', err, { jobId })
  }

  // ── Timeline (idempotent) ─────────────────────────────────────────────────
  try {
    ensureTimelineEvent({ jobId, type: 'payment_released' })
    ensureTimelineEvent({ jobId, type: 'job_completed' })
  } catch (err) {
    logError('hook.payment_released.timeline_failed', err, { jobId })
  }

  // ── Invoice sync (critical: Invoice state must reflect payment truth) ─────
  try {
    await syncInvoiceWithPayment(jobId)
  } catch (err) {
    logError('hook.payment_released.invoice_sync_failed', err, { jobId })
  }

  // ── Analytics (non-critical, non-throwing by convention) ─────────────────
  recordAnalyticsEvent({
    eventType: 'payment_released',
    entityType: 'payment',
    entityId: jobId,
  })

  // ── Craftsman-gated effects (non-critical) ────────────────────────────────
  if (job.craftsmanUserId) {
    incrementCompletedJobsCount(job.craftsmanUserId).catch((err: unknown) => {
      logError('hook.payment_released.increment_jobs_failed', err, {
        jobId,
        craftsmanUserId: job.craftsmanUserId ?? undefined,
      })
    })

    createInAppNotification({
      id: `notif-payment-released-${jobId}`,
      userId: job.craftsmanUserId,
      type: 'payment_released',
      entityType: 'payment',
      entityId: jobId,
      title: 'Zahlung freigegeben',
      message: `Die gesamte Zahlung für "${job.title}" wurde freigegeben.`,
      isRead: false,
      createdAt: Date.now(),
    })

    sendPaymentReleasedEmail(jobId, job.craftsmanUserId, { jobTitle: job.title })
  }
}

// ── payment:refunded ──────────────────────────────────────────────────────────

export type PaymentRefundedContext = {
  jobId: string
  /**
   * Fully resolved Job snapshot from the caller — captured before the
   * transition so the hook never reads stale store state.
   */
  job: Job
}

/**
 * Side effects to run after a successful payment:refunded transition.
 *
 * Canonical source for all "payment refunded" side effects.
 * Called by refundEscrowWorkflow in paymentWorkflow.ts.
 *
 * Intentionally narrower than runPaymentReleasedSideEffects:
 *   - No incrementCompletedJobsCount — refund is not a successful job completion
 *     that counts toward the craftsman's track record.
 *   - No createInAppNotification for craftsman — a refund is not positive news
 *     for the craftsman; no existing notification was present before this hook.
 *
 * CONTRACT
 * --------
 * - Must only be called AFTER domain mutations are committed:
 *     payment.state = 'refunded', job.status = 'completed'
 * - Never throws. All errors are caught and logged internally.
 * - Context must be fully resolved by the caller — no store reads inside.
 *
 * Error handling tiers:
 *   Timeline events        — try/catch, logError, execution continues.
 *   syncInvoiceWithPayment — try/catch, logError (critical).
 *   Analytics              — direct call (non-throwing by convention).
 */
export async function runPaymentRefundedSideEffects(
  ctx: PaymentRefundedContext
): Promise<void> {
  const { jobId } = ctx

  // ── Calendar sync: mark appointment as fully completed ───────────────────
  try {
    const calendarEntry = getCalendarEntryByJobId(jobId)
    if (calendarEntry) {
      updateCalendarStatus(calendarEntry.id, 'completed')
    }
  } catch (err) {
    logError('hook.payment_refunded.calendar_sync_failed', err, { jobId })
  }

  // ── Timeline (idempotent) ─────────────────────────────────────────────────
  try {
    ensureTimelineEvent({ jobId, type: 'payment_refunded' })
    ensureTimelineEvent({ jobId, type: 'job_completed' })
  } catch (err) {
    logError('hook.payment_refunded.timeline_failed', err, { jobId })
  }

  // ── Invoice sync (critical: Invoice state must reflect payment truth) ─────
  try {
    await syncInvoiceWithPayment(jobId)
  } catch (err) {
    logError('hook.payment_refunded.invoice_sync_failed', err, { jobId })
  }

  // ── Analytics (non-critical, non-throwing by convention) ─────────────────
  recordAnalyticsEvent({
    eventType: 'payment_refunded',
    entityType: 'payment',
    entityId: jobId,
  })
}
