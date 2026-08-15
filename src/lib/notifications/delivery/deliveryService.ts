/**
 * Client-side notification delivery service.
 *
 * Provides fire-and-forget helper functions that POST to the server-side
 * /api/send-notification-email endpoint.  All functions are non-blocking:
 * they log delivery start/success/failure via observability but never throw
 * or interrupt the calling workflow.
 *
 * Architecture:
 *   workflow → deliveryService.sendXxxEmail(...)
 *            → POST /api/send-notification-email
 *              → resolves recipient email (Supabase admin)
 *              → sends via Resend
 *              → logs to email_delivery_log
 */

import { logInfo, logWarning, logError } from '../../observability/index.js'
import { supabase } from '../../supabase.js'
import { apiUrl } from '../../api/baseUrl.js'
import type {
  NotificationDeliveryPayload,
  NotificationDeliveryType,
  NotificationDeliveryRecipientRole,
  DeliveryResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Internal dispatcher
// ---------------------------------------------------------------------------

async function dispatch(payload: NotificationDeliveryPayload): Promise<void> {
  const { type, jobId, recipientUserId, recipientRole } = payload

  if (!recipientUserId) {
    logInfo('notification.delivery.skipped', {
      type,
      jobId,
      recipientRole,
      reason: 'no_recipient_user_id',
    })
    return
  }

  // Client-side only: relative fetch('/api/...') requires a browser context.
  // Skip silently in Node / SSR — server-side delivery uses the API directly.
  if (typeof window === 'undefined') {
    return
  }

  logInfo('notification.delivery.started', { type, jobId, recipientRole })

  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) {
      logWarning('notification.delivery.session_error', {
        type,
        jobId,
        recipientRole,
        reason: sessionError.message,
      })
    }
    const token = sessionData.session?.access_token
    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {}

    const response = await fetch(apiUrl('/api/send-notification-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
    })

    const result: DeliveryResult = await response.json() as DeliveryResult

    if (result.success) {
      logInfo('notification.delivery.sent', { type, jobId, recipientRole })
    } else {
      logWarning('notification.delivery.failed', {
        type,
        jobId,
        recipientRole,
        error: result.error ?? 'unknown',
      })
    }
  } catch (err: unknown) {
    logError('notification.delivery.failed', err, { type, jobId, recipientRole })
  }
}

// ---------------------------------------------------------------------------
// Public delivery helpers
// ---------------------------------------------------------------------------

/**
 * Notifies the customer that a proposal has been received for their job.
 * Triggered by `submitProposalWorkflow`.
 */
export function sendProposalReceivedEmail(
  jobId: string,
  customerUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!customerUserId) return
  void dispatch(buildPayload('proposal_received', jobId, customerUserId, 'customer', context))
}

/**
 * Notifies the customer that a schedule has been created for their job.
 * Triggered by `scheduleJob` in schedulingWorkflow.
 */
export function sendScheduleCreatedEmail(
  jobId: string,
  customerUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!customerUserId) return
  void dispatch(buildPayload('schedule_created', jobId, customerUserId, 'customer', context))
}

/**
 * Notifies the customer that a schedule has been updated for their job.
 * Triggered by `updateSchedule` in schedulingWorkflow.
 */
export function sendScheduleUpdatedEmail(
  jobId: string,
  customerUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!customerUserId) return
  void dispatch(buildPayload('schedule_updated', jobId, customerUserId, 'customer', context))
}

/**
 * Notifies the customer that work has been completed and payment release is
 * needed.  Triggered by `markWorkCompleteWorkflow`.
 */
export function sendWorkCompletedEmail(
  jobId: string,
  customerUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!customerUserId) return
  void dispatch(buildPayload('work_completed', jobId, customerUserId, 'customer', context))
}

/**
 * Notifies a party that payment release has been requested for the job.
 * Triggered by `requestReleaseWorkflow` in paymentWorkflow — fans out to
 * both customer (primary action: release the payment) and craftsman
 * (confirmation that the release request was sent).
 *
 * Returns a Promise so the caller can await delivery (errors are still logged
 * internally by dispatch and never propagate as rejections).
 */
export function sendPaymentReleaseRequestedEmail(
  jobId: string,
  recipientUserId: string | null | undefined,
  contextOrRole?: Record<string, unknown> | NotificationDeliveryRecipientRole,
  context?: Record<string, unknown>,
): Promise<void> {
  if (!recipientUserId) return Promise.resolve()
  // Backwards-compatible signature: legacy callers passed (jobId, userId, context)
  // expecting the craftsman role. New callers pass an explicit role as the
  // third argument plus a separate context object.
  let recipientRole: NotificationDeliveryRecipientRole = 'craftsman'
  let resolvedContext: Record<string, unknown> | undefined
  if (typeof contextOrRole === 'string') {
    recipientRole = contextOrRole
    resolvedContext = context
  } else {
    resolvedContext = contextOrRole
    const ctxRole = resolvedContext?.recipientRole
    if (ctxRole === 'customer' || ctxRole === 'craftsman') {
      recipientRole = ctxRole
    }
  }
  return dispatch(buildPayload(
    'payment_release_requested', jobId, recipientUserId, recipientRole, resolvedContext,
  ))
}

/**
 * Notifies a party that a dispute has been opened for a job.
 * Triggered by `openDisputeWorkflow`.
 * Call once per recipient role (customer and craftsman separately).
 */
export function sendDisputeOpenedEmail(
  jobId: string,
  recipientUserId: string | null | undefined,
  recipientRole: NotificationDeliveryRecipientRole,
  context?: Record<string, unknown>
): void {
  if (!recipientUserId) return
  void dispatch(buildPayload('dispute_opened', jobId, recipientUserId, recipientRole, context))
}

/**
 * Notifies a party that evidence has been requested in a dispute.
 * Triggered by `requestCustomerEvidenceWorkflow` / `requestProviderEvidenceWorkflow`.
 */
export function sendDisputeEvidenceRequestedEmail(
  jobId: string,
  recipientUserId: string | null | undefined,
  recipientRole: NotificationDeliveryRecipientRole,
  context?: Record<string, unknown>
): void {
  if (!recipientUserId) return
  void dispatch(
    buildPayload('dispute_evidence_requested', jobId, recipientUserId, recipientRole, context)
  )
}

// ── Block 3: Payment / payout trust corridor ────────────────────────────────

/**
 * Confirms to a participant that the customer's funds are now locked in
 * escrow. Triggered by `lockEscrowWorkflow` for both parties.
 */
export function sendEscrowLockedEmail(
  jobId: string,
  recipientUserId: string | null | undefined,
  recipientRole: NotificationDeliveryRecipientRole,
  context?: Record<string, unknown>
): void {
  if (!recipientUserId) return
  void dispatch(buildPayload(
    'escrow_locked', jobId, recipientUserId, recipientRole,
    { ...context, recipientRole },
  ))
}

/**
 * Informs the craftsman that the customer has released the full payment
 * from escrow. Triggered by the payment-released side-effect hook.
 */
export function sendPaymentReleasedEmail(
  jobId: string,
  craftsmanUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!craftsmanUserId) return
  void dispatch(buildPayload(
    'payment_released', jobId, craftsmanUserId, 'craftsman', context,
  ))
}

/**
 * Informs the craftsman that the Stripe Transfer to their Connected
 * Account was initiated — money is on its way to the bank. Triggered by
 * `applyLocalSideEffectsAfterServerRelease` after a successful tranche
 * release.
 */
export function sendPayoutHandoffInitiatedEmail(
  jobId: string,
  craftsmanUserId: string | null | undefined,
  context?: Record<string, unknown>
): void {
  if (!craftsmanUserId) return
  void dispatch(buildPayload(
    'payout_handoff_initiated', jobId, craftsmanUserId, 'craftsman', context,
  ))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPayload(
  type: NotificationDeliveryType,
  jobId: string,
  recipientUserId: string,
  recipientRole: NotificationDeliveryRecipientRole,
  context?: Record<string, unknown>
): NotificationDeliveryPayload {
  return { type, jobId, recipientUserId, recipientRole, context }
}
