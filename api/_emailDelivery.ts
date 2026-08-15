/**
 * Server-internal email delivery helper.
 *
 * Shared core of the notification-email pipeline so that
 *   - the user-facing `/api/send-notification-email` endpoint (auth-gated)
 *   - the Stripe webhook (payout outcome fan-out; service-role)
 * can both emit transactional notifications through a single Resend path
 * and a single `email_delivery_log` write.
 *
 * The helper is auth-agnostic — callers are responsible for their own
 * authorisation checks before invoking it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logInfo, logWarning, logError } from './_observability.js'
import { buildEmailContent } from '../src/lib/notifications/delivery/templates.js'
import type {
  NotificationDeliveryPayload,
  DeliveryResult,
} from '../src/lib/notifications/delivery/types.js'

type ResendSendResult = { id: string } | { error: { name: string; message: string } }

async function sendViaResend(params: {
  apiKey: string
  from: string
  to: string
  subject: string
  html: string
  text: string
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
    }),
  })

  const data = await response.json() as ResendSendResult

  if (!response.ok) {
    const errData = data as { error: { name: string; message: string } }
    const msg = errData.error?.message ?? `HTTP ${response.status}`
    return { success: false, error: msg }
  }

  const okData = data as { id: string }
  return { success: true, messageId: okData.id }
}

async function logDeliveryAttempt(
  admin: SupabaseClient,
  params: {
    jobId: string
    type: string
    recipientUserId: string
    recipientRole: string
    recipientEmail: string | null
    success: boolean
    error?: string
    messageId?: string
  },
): Promise<void> {
  try {
    await admin.from('email_delivery_log').insert({
      job_id: params.jobId,
      notification_type: params.type,
      recipient_user_id: params.recipientUserId,
      recipient_role: params.recipientRole,
      recipient_email: params.recipientEmail,
      success: params.success,
      error_message: params.error ?? null,
      provider_message_id: params.messageId ?? null,
      sent_at: Date.now(),
    })
  } catch (err: unknown) {
    logWarning('email.delivery.log_failed', {
      jobId: params.jobId,
      type: params.type,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Sends a transactional notification email on behalf of the server.
 *
 * Returns `{ success: false }` for every non-fatal degradation (missing
 * Resend key, unknown recipient email, Resend error) — callers log the
 * result, they don't branch on it.
 */
export async function deliverNotificationEmailServer(
  admin: SupabaseClient,
  payload: NotificationDeliveryPayload,
): Promise<DeliveryResult> {
  const { type, jobId, recipientUserId, recipientRole, context } = payload

  if (!recipientUserId) {
    logInfo('email.delivery.skipped', { type, jobId, recipientRole, reason: 'no_recipient_user_id' })
    return { success: false, error: 'no_recipient_user_id' }
  }

  let recipientEmail: string | null = null
  try {
    const { data, error } = await admin.auth.admin.getUserById(recipientUserId)
    if (error) {
      logWarning('email.delivery.recipient_lookup_failed', {
        type, jobId, recipientUserId, reason: error.message,
      })
    } else {
      recipientEmail = data?.user?.email ?? null
    }
  } catch (err: unknown) {
    logError('email.delivery.recipient_lookup_exception', err, { type, jobId, recipientUserId })
  }

  if (!recipientEmail) {
    await logDeliveryAttempt(admin, {
      jobId, type, recipientUserId, recipientRole,
      recipientEmail: null, success: false, error: 'recipient_email_unknown',
    })
    return { success: false, error: 'recipient_email_unknown' }
  }

  const resendKey = process.env.RESEND_API_KEY
  const fromAddress = process.env.NOTIFICATION_FROM_EMAIL

  if (!resendKey || !fromAddress) {
    logWarning('email.delivery.resend_not_configured', { type, jobId, recipientRole })
    await logDeliveryAttempt(admin, {
      jobId, type, recipientUserId, recipientRole,
      recipientEmail, success: false, error: 'resend_not_configured',
    })
    return { success: false, error: 'resend_not_configured' }
  }

  const email = buildEmailContent(type, { ...(context ?? {}), recipientRole })

  let sendResult: { success: boolean; messageId?: string; error?: string }
  try {
    sendResult = await sendViaResend({
      apiKey: resendKey,
      from: fromAddress,
      to: recipientEmail,
      subject: email.subject,
      html: email.html,
      text: email.text,
    })
  } catch (err: unknown) {
    sendResult = { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  await logDeliveryAttempt(admin, {
    jobId, type, recipientUserId, recipientRole,
    recipientEmail, ...sendResult,
  })

  if (sendResult.success) {
    logInfo('email.delivery.sent', { type, jobId, recipientRole })
  } else {
    logWarning('email.delivery.send_failed', {
      type, jobId, recipientRole, reason: sendResult.error ?? 'unknown',
    })
  }

  return sendResult.success
    ? { success: true }
    : { success: false, error: sendResult.error ?? 'unknown' }
}
