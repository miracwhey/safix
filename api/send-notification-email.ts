/**
 * Server-side notification email delivery endpoint.
 *
 * Accepts a NotificationDeliveryPayload, resolves the recipient's email via the
 * Supabase admin client, builds the email content using the delivery templates,
 * sends via Resend (transactional email), and logs the delivery attempt to the
 * email_delivery_log table.
 *
 * Required environment variables (set in Vercel project settings):
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service-role JWT (bypasses RLS)
 *   RESEND_API_KEY            — Resend API key for transactional email
 *   NOTIFICATION_FROM_EMAIL   — Sender address (e.g. "SaFix <no-reply@example.com>")
 *
 * If RESEND_API_KEY is absent the endpoint degrades gracefully: it logs the
 * delivery attempt and returns success=false so workflows are not interrupted.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getSupabaseAdmin } from './_supabase.js'
import { applyCors } from './_cors.js'
import { requireAuth } from './_auth.js'
import { logWarning } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import { buildEmailContent } from '../src/lib/notifications/delivery/templates.js'
import {
  VALID_DELIVERY_TYPES,
} from '../src/lib/notifications/delivery/types.js'
import type { NotificationDeliveryPayload, NotificationDeliveryType, DeliveryResult } from '../src/lib/notifications/delivery/types.js'

const VALID_RECIPIENT_ROLES = ['customer', 'craftsman'] as const

// ---------------------------------------------------------------------------
// Resend REST API (no npm package — raw fetch to avoid extra dependency)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Delivery logging (best-effort, non-blocking)
// ---------------------------------------------------------------------------

async function logDeliveryAttempt(params: {
  jobId: string
  type: string
  recipientUserId: string
  recipientRole: string
  recipientEmail: string | null
  success: boolean
  error?: string
  messageId?: string
}): Promise<void> {
  const admin = getSupabaseAdmin()
  if (!admin) return

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
  } catch (_err: unknown) {
    // Best-effort: never let delivery logging interrupt the response
    console.error('send-notification-email: failed to write delivery log', _err)
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method Not Allowed. Use POST.' } satisfies DeliveryResult)
    return
  }

  // Authenticate — reject requests without a valid Supabase session.
  // Prevents this endpoint from being abused as a public email relay.
  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const body = (req.body ?? {}) as Partial<NotificationDeliveryPayload>
  const { type, jobId, recipientUserId, recipientRole, context } = body

  // Basic presence validation
  if (!type || !jobId || !recipientUserId || !recipientRole) {
    res.status(400).json({
      success: false,
      error: 'Missing required fields: type, jobId, recipientUserId, recipientRole',
    } satisfies DeliveryResult)
    return
  }

  // Validate type is a known delivery type
  if (!(VALID_DELIVERY_TYPES as readonly string[]).includes(type)) {
    console.warn(`send-notification-email: unknown notification type '${type}'`)
    res.status(400).json({
      success: false,
      error: `Unknown notification type: ${type}`,
    } satisfies DeliveryResult)
    return
  }

  // Validate recipientRole is a known role
  if (!(VALID_RECIPIENT_ROLES as readonly string[]).includes(recipientRole)) {
    console.warn(`send-notification-email: invalid recipientRole '${recipientRole}'`)
    res.status(400).json({
      success: false,
      error: `Invalid recipientRole: must be 'customer' or 'craftsman'`,
    } satisfies DeliveryResult)
    return
  }

  // Cast to validated types after guards
  const validatedType = type as NotificationDeliveryType

  // Authorization: verify the authenticated caller is a participant in the
  // job identified by jobId (either the customer or the craftsman).
  // This prevents any authenticated user from triggering notification emails
  // about jobs they are not party to, which would be an email spoofing vector.
  const admin = getSupabaseAdmin()
  if (admin) {
    const { data: jobRows, error: jobError } = await admin
      .from('jobs')
      .select('customer_user_id, craftsman_user_id')
      .eq('id', jobId)
      .limit(1)

    if (jobError) {
      logWarning('api.notification_email.job_lookup_failed', {
        jobId,
        reason: jobError.message,
      })
      res.status(500).json({
        success: false,
        error: 'Server error: could not verify job ownership.',
      } satisfies DeliveryResult)
      return
    }

    const jobRow = (jobRows ?? [])[0] as
      | { customer_user_id: string | null; craftsman_user_id: string | null }
      | undefined

    if (!jobRow) {
      logWarning('api.notification_email.job_not_found', { jobId, userId: auth.userId })
      res.status(404).json({
        success: false,
        error: 'Job not found.',
      } satisfies DeliveryResult)
      return
    }

    // The two human parties on a job are identified by their auth user ids:
    // customer_user_id and craftsman_user_id (jobs.provider_id is providers.id,
    // a DB pointer — never an auth uid — so it is not a valid caller/recipient
    // identity here).
    const callerIsCustomer = jobRow.customer_user_id === auth.userId
    const callerIsCraftsman = jobRow.craftsman_user_id === auth.userId

    if (!callerIsCustomer && !callerIsCraftsman) {
      logWarning('api.notification_email.authorization_failed', {
        jobId,
        userId: auth.userId,
        reason: 'caller_not_job_participant',
      })
      res.status(403).json({
        success: false,
        error: 'Forbidden: you are not a participant in this job.',
      } satisfies DeliveryResult)
      return
    }

    // Recipient lockdown: the email may only be sent to the caller's counterparty
    // on this job. Without this, any participant could direct notification emails
    // (with client-controlled content) at arbitrary users — a phishing/spam vector.
    const expectedRecipientUserId = callerIsCustomer
      ? jobRow.craftsman_user_id
      : jobRow.customer_user_id

    if (!expectedRecipientUserId || recipientUserId !== expectedRecipientUserId) {
      logWarning('api.notification_email.authorization_failed', {
        jobId,
        userId: auth.userId,
        reason: 'recipient_not_job_counterparty',
      })
      res.status(403).json({
        success: false,
        error: 'Forbidden: recipient is not the counterparty for this job.',
      } satisfies DeliveryResult)
      return
    }
  }

  // Resolve recipient email from Supabase Auth
  let recipientEmail: string | null = null

  if (admin) {
    try {
      const { data, error } = await admin.auth.admin.getUserById(recipientUserId)
      if (error) {
        console.error('send-notification-email: failed to resolve recipient email', error.message)
      } else {
        recipientEmail = data?.user?.email ?? null
      }
    } catch (err: unknown) {
      console.error('send-notification-email: unexpected error resolving recipient', err)
    }
  }

  if (!recipientEmail) {
    await logDeliveryAttempt({
      jobId,
      type: validatedType,
      recipientUserId,
      recipientRole,
      recipientEmail: null,
      success: false,
      error: 'recipient_email_not_found',
    })
    res.status(200).json({ success: false, error: 'recipient_email_not_found' } satisfies DeliveryResult)
    return
  }

  // Build email content from a whitelisted context. The templates only consume
  // `jobTitle` and `recipientRole`; forwarding the raw client `context` would let
  // a caller inject arbitrary content into the email. Drop every unknown key,
  // cap the title length, and force the role to the already-validated value.
  const safeContext: Record<string, unknown> = { recipientRole }
  if (typeof context?.jobTitle === 'string' && context.jobTitle.trim() !== '') {
    safeContext.jobTitle = context.jobTitle.slice(0, 200)
  }
  const emailContent = buildEmailContent(validatedType, safeContext)

  // Send via Resend
  const apiKey = process.env.RESEND_API_KEY
  const fromAddress = process.env.NOTIFICATION_FROM_EMAIL ?? 'SaFix <no-reply@safix.digital>'

  if (!apiKey) {
    console.warn('send-notification-email: RESEND_API_KEY not set — skipping send')
    await logDeliveryAttempt({
      jobId,
      type: validatedType,
      recipientUserId,
      recipientRole,
      recipientEmail,
      success: false,
      error: 'resend_api_key_not_configured',
    })
    res.status(200).json({
      success: false,
      error: 'resend_api_key_not_configured',
    } satisfies DeliveryResult)
    return
  }

  const sendResult = await sendViaResend({
    apiKey,
    from: fromAddress,
    to: recipientEmail,
    subject: emailContent.subject,
    html: emailContent.html,
    text: emailContent.text,
  })

  await logDeliveryAttempt({
    jobId,
    type: validatedType,
    recipientUserId,
    recipientRole,
    recipientEmail,
    success: sendResult.success,
    error: sendResult.error,
    messageId: sendResult.messageId,
  })

  if (sendResult.success) {
    res.status(200).json({ success: true } satisfies DeliveryResult)
  } else {
    console.error(
      `send-notification-email: Resend delivery failed [type=${validatedType} job=${jobId}]`,
      sendResult.error,
    )
    res.status(200).json({ success: false, error: sendResult.error } satisfies DeliveryResult)
  }
}
