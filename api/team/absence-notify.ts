/**
 * Absence notification fan-out endpoint — Block 3.
 *
 * Workflow-internal: called by `reportAbsenceWorkflow` / `cancelAbsenceWorkflow`
 * after the absence row lands in Postgres. Orchestrates four independent
 * channels in parallel with fail-soft semantics:
 *
 *   1. Email — Resend transactional email to the provider's owner.
 *   2. In-App — system message into the office/team thread (also surfaces in
 *      both Worker and Owner chat as a centered SystemMessageBubble).
 *   3. Bot-Chat — same INSERT as in-app (the system message IS the bot-chat
 *      payload); kept as a single channel to avoid double-posting.
 *   4. Push — APNs via the shared notify-push edge function (display-only,
 *      no inline actions).
 *
 * ── Required env vars (Vercel project settings) ───────────────────────
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (bypasses RLS)
 *   RESEND_API_KEY            — Resend API key (optional; degrades gracefully)
 *   NOTIFICATION_FROM_EMAIL   — sender address (optional; degrades gracefully)
 *   NOTIFY_PUSH_URL           — edge-function URL (mirror of vault notify_push.url)
 *   NOTIFY_PUSH_SHARED_SECRET — shared secret (mirror of vault notify_push.shared_secret)
 *
 * ── Auth ──────────────────────────────────────────────────────────────
 * `requireAuth` (Bearer JWT). Defense-in-depth: we additionally verify that
 * the caller is either the absent member's worker OR the provider's owner.
 *
 * Push is fail-soft: a missing env, a missing token, or an APNs error does
 * NOT mark the absence as failed. The absence row is the source of truth;
 * channels are derived signals.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from '../_cors.js'
import { requireAuth } from '../_auth.js'
import { getSupabaseAdminWithStatus } from '../_supabase.js'
import { logError, logInfo, logWarning } from '../_observability.js'
import { applyRateLimit } from '../_rateLimit.js'

type NotifyKind = 'reported' | 'cancelled'

type ChannelStatus = 'sent' | 'failed' | 'skipped'

type Body = {
  absenceId?: string
  kind?: NotifyKind
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const auth = await requireAuth(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'critical', auth.userId)) return

  const body = (req.body ?? {}) as Body
  const absenceId = typeof body.absenceId === 'string' ? body.absenceId : null
  const kind: NotifyKind = body.kind === 'cancelled' ? 'cancelled' : 'reported'
  if (!absenceId) {
    res.status(400).json({ error: 'absenceId required' })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    res.status(500).json({ error: 'supabase_admin_unavailable', missing: adminResult.missing })
    return
  }
  const admin = adminResult.client

  // ─── Load absence + member + provider (single round-trip) ───────────────
  const { data: absRow, error: absErr } = await admin
    .from('absences')
    .select('id, provider_id, member_id, type, start_date, end_date, reason_note, status')
    .eq('id', absenceId)
    .maybeSingle()

  if (absErr) {
    logError('absenceNotify.load_failed', absErr, { absenceId })
    res.status(500).json({ error: 'absence_load_failed' })
    return
  }
  if (!absRow) {
    res.status(404).json({ error: 'absence_not_found' })
    return
  }

  const { data: memberRow, error: memberErr } = await admin
    .from('team_members')
    .select('id, full_name, name, profile_id')
    .eq('id', absRow.member_id)
    .maybeSingle()
  if (memberErr || !memberRow) {
    logError('absenceNotify.member_load_failed', memberErr ?? new Error('member_not_found'), {
      absenceId,
      memberId: absRow.member_id,
    })
    res.status(500).json({ error: 'member_load_failed' })
    return
  }

  const { data: providerRow, error: providerErr } = await admin
    .from('providers')
    .select('id, profile_id, business_name')
    .eq('id', absRow.provider_id)
    .maybeSingle()
  if (providerErr || !providerRow) {
    logError('absenceNotify.provider_load_failed', providerErr ?? new Error('provider_not_found'), {
      absenceId,
      providerId: absRow.provider_id,
    })
    res.status(500).json({ error: 'provider_load_failed' })
    return
  }

  // Defense-in-depth caller-check: must be the worker themselves or the owner.
  const callerOk =
    memberRow.profile_id === auth.userId || providerRow.profile_id === auth.userId
  if (!callerOk) {
    logWarning('absenceNotify.caller_not_authorised', {
      absenceId,
      callerUid: auth.userId,
    })
    res.status(403).json({ error: 'forbidden' })
    return
  }

  const memberName = (memberRow.full_name as string | null) || (memberRow.name as string | null) || 'Mitarbeiter'
  const ownerUserId = providerRow.profile_id as string

  // ─── Channel 1: bot-chat (system message in office/team thread) ─────────
  let chatStatus: ChannelStatus = 'skipped'
  try {
    const threadId = await resolveOrCreateOfficeThread(admin, providerRow.id as string)
    const messageBody = renderChatBody(kind, memberName, absRow as AbsenceRowSlim)
    const { error } = await admin.from('internal_messages').insert({
      thread_id: threadId,
      sender_team_member_id: null,
      sender_kind: 'system',
      body: messageBody,
      message_kind: 'text',
    })
    if (error) {
      logError('absenceNotify.chat_failed', error, { absenceId, threadId })
      chatStatus = 'failed'
    } else {
      chatStatus = 'sent'
    }
  } catch (err) {
    logError('absenceNotify.chat_exception', err as Error, { absenceId })
    chatStatus = 'failed'
  }

  // ─── Channel 2: email to owner (Resend) ─────────────────────────────────
  let emailStatus: ChannelStatus = 'skipped'
  try {
    const resendKey = process.env.RESEND_API_KEY
    const fromAddress = process.env.NOTIFICATION_FROM_EMAIL
    if (resendKey && fromAddress) {
      const ownerEmail = await resolveOwnerEmail(admin, ownerUserId)
      if (ownerEmail) {
        const emailBody = renderEmailBody(kind, memberName, absRow as AbsenceRowSlim)
        const sent = await sendViaResend({
          apiKey: resendKey,
          from: fromAddress,
          to: ownerEmail,
          subject: kind === 'reported' ? `${memberName} hat sich krankgemeldet` : `${memberName}: Krankmeldung zurückgenommen`,
          html: `<p>${emailBody}</p>`,
          text: emailBody,
        })
        emailStatus = sent ? 'sent' : 'failed'
      } else {
        emailStatus = 'skipped'
      }
    }
  } catch (err) {
    logError('absenceNotify.email_exception', err as Error, { absenceId })
    emailStatus = 'failed'
  }

  // ─── Channel 3: APNs push via notify-push edge function ─────────────────
  let pushStatus: ChannelStatus = 'skipped'
  try {
    const pushUrl = process.env.NOTIFY_PUSH_URL
    const pushSecret = process.env.NOTIFY_PUSH_SHARED_SECRET
    if (pushUrl && pushSecret) {
      const tokens = await resolvePushTokens(admin, ownerUserId)
      if (tokens.length > 0) {
        const title = kind === 'reported' ? 'Krankmeldung' : 'Krankmeldung zurückgenommen'
        const pushBody = renderPushBody(kind, memberName, absRow as AbsenceRowSlim)
        const pushes = tokens.map((token) => ({
          token,
          title,
          body: pushBody,
          data: { kind: kind === 'reported' ? 'absence_reported' : 'absence_cancelled', absenceId, memberId: absRow.member_id },
        }))
        const response = await fetch(pushUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fixup-trigger-secret': pushSecret,
          },
          body: JSON.stringify({ pushes }),
        })
        pushStatus = response.ok ? 'sent' : 'failed'
        if (!response.ok) {
          logWarning('absenceNotify.push_non_2xx', {
            absenceId,
            httpStatus: response.status,
          })
        }
      } else {
        pushStatus = 'skipped'
      }
    }
  } catch (err) {
    logError('absenceNotify.push_exception', err as Error, { absenceId })
    pushStatus = 'failed'
  }

  logInfo('absenceNotify.complete', {
    absenceId,
    kind,
    chat: chatStatus,
    email: emailStatus,
    push: pushStatus,
  })

  res.status(200).json({
    ok: true,
    channels: { chat: chatStatus, email: emailStatus, push: pushStatus },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type AbsenceRowSlim = {
  id: string
  member_id: string
  provider_id: string
  type: 'sick' | 'vacation' | 'other'
  start_date: string
  end_date: string
  reason_note: string | null
  status: 'active' | 'cancelled'
}

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolves the office thread for the provider, creating one if it doesn't
 * exist yet. Race-safe via the `uq_office_team_threads` unique partial index
 * (already in prod) — concurrent creators converge on a single row.
 */
async function resolveOrCreateOfficeThread(
  admin: SupabaseClient,
  providerId: string,
): Promise<string> {
  const { data: existing, error: selErr } = await admin
    .from('message_threads')
    .select('id')
    .eq('provider_id', providerId)
    .eq('thread_type', 'office')
    .maybeSingle()
  if (selErr) {
    logError('absenceNotify.thread_select_failed', selErr, { providerId })
    throw selErr
  }
  if (existing?.id) return existing.id as string

  // Need a created_by_team_member_id — pick any active member of the provider.
  // Owner-as-member is preferred, but any active member works for system-only
  // threads. The thread participants are what gate visibility, not the
  // creator id.
  const { data: anyMember } = await admin
    .from('team_members')
    .select('id')
    .eq('provider_id', providerId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  const createdByTmId = (anyMember?.id as string | undefined) ?? providerId

  const { data: inserted, error: insErr } = await admin
    .from('message_threads')
    .insert({
      provider_id: providerId,
      thread_type: 'office',
      created_by_team_member_id: createdByTmId,
    })
    .select('id')
    .single()
  if (insErr) {
    // Race: someone else created it between our SELECT and INSERT — re-fetch.
    if ((insErr as { code?: string }).code === '23505') {
      const { data: retry } = await admin
        .from('message_threads')
        .select('id')
        .eq('provider_id', providerId)
        .eq('thread_type', 'office')
        .maybeSingle()
      if (retry?.id) return retry.id as string
    }
    logError('absenceNotify.thread_insert_failed', insErr, { providerId })
    throw insErr
  }
  return inserted.id as string
}

async function resolveOwnerEmail(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error || !data?.user?.email) return null
  return data.user.email
}

async function resolvePushTokens(admin: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('notification_device_tokens')
    .select('token')
    .eq('user_id', userId)
  if (error || !data) return []
  return data
    .map((row) => (row as { token: string }).token)
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
}

function formatDate(key: string): string {
  const [yyyy, mm, dd] = key.split('-')
  if (!yyyy || !mm || !dd) return key
  return `${dd}.${mm}.${yyyy}`
}

function renderChatBody(kind: NotifyKind, name: string, abs: AbsenceRowSlim): string {
  if (kind === 'cancelled') {
    return `${name} hat die Krankmeldung zurückgenommen.`
  }
  const start = formatDate(abs.start_date)
  const end = formatDate(abs.end_date)
  const range = abs.start_date === abs.end_date ? `am ${start}` : `vom ${start} bis ${end}`
  const reason = abs.reason_note ? ` Grund: ${abs.reason_note}` : ''
  return `${name} hat sich ${range} krankgemeldet.${reason}`
}

function renderEmailBody(kind: NotifyKind, name: string, abs: AbsenceRowSlim): string {
  return renderChatBody(kind, name, abs)
}

function renderPushBody(kind: NotifyKind, name: string, abs: AbsenceRowSlim): string {
  if (kind === 'cancelled') return `${name} ist wieder verfügbar.`
  const end = formatDate(abs.end_date)
  return `${name} krank bis ${end}`
}

async function sendViaResend(params: {
  apiKey: string
  from: string
  to: string
  subject: string
  html: string
  text: string
}): Promise<boolean> {
  try {
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
    return response.ok
  } catch {
    return false
  }
}
