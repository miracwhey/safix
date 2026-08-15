import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from '../_cors.js'
import { requireOwner } from '../_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from '../_supabase.js'
import { applyRateLimit } from '../_rateLimit.js'
import { logError, logInfo, logWarning } from '../_observability.js'

/**
 * Sends the active company join code by email.
 *
 * Two recipient modes:
 *   1. Default — to the owner's account email (no body or `to` omitted).
 *   2. Stub — to a specific email address belonging to a stub team member
 *      of this owner's provider. Required for the Block 2 "Rotieren & Mail
 *      an Stub" combo-flow: only addresses that already exist on a
 *      `team_members` row (profile_id IS NULL) are accepted.
 *
 * Auth: requireOwner — caller must be authenticated craftsman owner.
 * Rate-limit: 'critical' tier (10/min standard) + a custom 3/h memory bucket
 *   per userId to discourage spam.
 *
 * The endpoint never returns the code in the response body — only the
 * delivery outcome plus a masked email so the UI can show "Code wurde an
 * o***@example.com geschickt".
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MEMORY_BUCKET = new Map<string, number[]>()
const HOURLY_LIMIT = 3
const HOURLY_WINDOW_MS = 60 * 60 * 1000

function applyHourlyMemoryLimit(userId: string, now: number): boolean {
  const cutoff = now - HOURLY_WINDOW_MS
  const previous = MEMORY_BUCKET.get(userId) ?? []
  const recent = previous.filter((ts) => ts > cutoff)
  if (recent.length >= HOURLY_LIMIT) {
    MEMORY_BUCKET.set(userId, recent)
    return true
  }
  recent.push(now)
  MEMORY_BUCKET.set(userId, recent)
  return false
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  if (!local || !domain) return email
  if (local.length <= 1) return `${local}***@${domain}`
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`
}

async function sendCodeEmailViaResend(
  apiKey: string,
  from: string,
  to: string,
  code: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const subject = 'Dein SaFix Team-Code'
  const html = `
    <p>Hallo,</p>
    <p>hier ist dein aktueller SaFix Team-Code:</p>
    <p style="font-size:24px;font-weight:bold;letter-spacing:2px;font-family:monospace;">${code}</p>
    <p>Mit diesem Code können Mitarbeiter deinem Betrieb beitreten. Du kannst den Code jederzeit über die Team-Einstellungen rotieren — vorhandene Mitarbeiter bleiben dabei im Team.</p>
    <p>— SaFix</p>
  `.trim()
  const text = [
    'Hallo,',
    '',
    'hier ist dein aktueller SaFix Team-Code:',
    '',
    `  ${code}`,
    '',
    'Mit diesem Code können Mitarbeiter deinem Betrieb beitreten. Du kannst den Code jederzeit über die Team-Einstellungen rotieren — vorhandene Mitarbeiter bleiben dabei im Team.',
    '',
    '— SaFix',
  ].join('\n')

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  })

  const data = (await response.json()) as
    | { id: string }
    | { error: { name: string; message: string } }

  if (!response.ok) {
    const err = data as { error: { name: string; message: string } }
    return { success: false, error: err.error?.message ?? `HTTP ${response.status}` }
  }
  const ok = data as { id: string }
  return { success: true, messageId: ok.id }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res)) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const auth = await requireOwner(req, res)
  if (!auth) return

  if (await applyRateLimit(res, 'critical', auth.userId)) return

  if (applyHourlyMemoryLimit(auth.userId, Date.now())) {
    logWarning('api.team_code_email.hourly_limit_exceeded', { userId: auth.userId })
    res.setHeader('Retry-After', String(60 * 60))
    res.status(429).json({
      error: 'Limit von 3 E-Mails pro Stunde erreicht.',
      code: 'rate_limit_exceeded',
    })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  // Use an explicit false comparison: Vercel's per-function TypeScript
  // compilation does not enable strict null checks, which otherwise prevents
  // discriminated-union narrowing for `!adminResult.ok`.
  if (adminResult.ok === false) {
    logError('api.team_code_email.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({ error: formatAdminUnavailable(adminResult.missing) })
    return
  }
  const admin = adminResult.client

  // Resolve provider for the caller
  const { data: provider, error: provErr } = await admin
    .from('providers')
    .select('id')
    .eq('profile_id', auth.userId)
    .maybeSingle()

  if (provErr || !provider) {
    logError(
      'api.team_code_email.provider_lookup_failed',
      provErr instanceof Error ? provErr : undefined,
      { userId: auth.userId },
    )
    res.status(404).json({ error: 'Betriebsprofil nicht gefunden.' })
    return
  }

  const { data: codeRow, error: codeErr } = await admin
    .from('company_join_codes')
    .select('code')
    .eq('provider_id', provider.id)
    .eq('status', 'active')
    .maybeSingle()

  if (codeErr || !codeRow) {
    res.status(404).json({ error: 'Kein aktiver Team-Code gefunden.' })
    return
  }

  // Optional `to` body: caller asks to deliver to a specific stub-member's email.
  // We accept the override only when the address matches an existing stub on
  // this provider — never to arbitrary addresses (anti-abuse).
  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
    to?: unknown
  }
  const requestedTo =
    typeof body.to === 'string' && body.to.trim().length > 0 ? body.to.trim().toLowerCase() : null

  let recipientEmail: string | null = null

  if (requestedTo) {
    if (!EMAIL_REGEX.test(requestedTo)) {
      res.status(400).json({ error: 'Ungültige E-Mail-Adresse.', code: 'invalid_email' })
      return
    }
    // Fetch stub candidates and match in JS rather than via PostgREST `.ilike`:
    // ilike treats `_` and `%` in the user-supplied input as wildcards, so an
    // attacker could match more than one row with patterns like `a%@x.com`.
    // The provider scope keeps the pull small; explicit lowercase equality is
    // the safe comparison.
    const { data: stubRows, error: stubErr } = await admin
      .from('team_members')
      .select('email')
      .eq('provider_id', provider.id)
      .is('profile_id', null)
      .not('email', 'is', null)
      .limit(200)
    if (stubErr) {
      logError(
        'api.team_code_email.stub_lookup_failed',
        stubErr instanceof Error ? stubErr : undefined,
        { userId: auth.userId },
      )
      res.status(500).json({ error: 'Stub-Lookup fehlgeschlagen.' })
      return
    }
    const matched = (stubRows ?? []).find(
      (r) => typeof r.email === 'string' && r.email.trim().toLowerCase() === requestedTo,
    )
    if (!matched?.email) {
      res.status(404).json({
        error: 'Diese E-Mail gehört zu keinem wartenden Mitarbeiter.',
        code: 'stub_not_found',
      })
      return
    }
    recipientEmail = matched.email as string
  } else {
    // Default: owner's account email
    const { data: userRes, error: userErr } = await admin.auth.admin.getUserById(auth.userId)
    recipientEmail = userRes?.user?.email ?? null
    if (userErr || !recipientEmail) {
      logError(
        'api.team_code_email.recipient_lookup_failed',
        userErr instanceof Error ? userErr : undefined,
        { userId: auth.userId },
      )
      res.status(500).json({ error: 'E-Mail-Adresse nicht ermittelbar.' })
      return
    }
  }

  const resendKey = process.env.RESEND_API_KEY
  const fromAddress = process.env.NOTIFICATION_FROM_EMAIL

  if (!resendKey || !fromAddress) {
    logWarning('api.team_code_email.resend_unconfigured', { userId: auth.userId })
    res.status(500).json({ error: 'E-Mail-Versand nicht konfiguriert.' })
    return
  }

  const send = await sendCodeEmailViaResend(
    resendKey,
    fromAddress,
    recipientEmail,
    codeRow.code as string,
  )

  if (!send.success) {
    logError('api.team_code_email.send_failed', undefined, {
      userId: auth.userId,
      error: send.error,
    })
    res.status(502).json({ error: 'E-Mail konnte nicht zugestellt werden.' })
    return
  }

  logInfo('api.team_code_email.sent', {
    userId: auth.userId,
    providerId: provider.id,
    messageId: send.messageId,
  })

  res.status(200).json({ sent: true, maskedEmail: maskEmail(recipientEmail) })
}
