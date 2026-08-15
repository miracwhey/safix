import type { VercelRequest, VercelResponse } from '@vercel/node'
import { applyCors } from './_cors.js'
import { requireOwner } from './_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { applyRateLimit } from './_rateLimit.js'
import { logError, logInfo, logWarning } from './_observability.js'

/**
 * § 356a BGB Widerruf-Button — nimmt eine Widerrufserklärung zum SaFix-Pro-Abo
 * entgegen, schreibt sie append-only in `widerruf_requests` (service-role) und
 * sendet dem Nutzer unverzüglich eine Eingangsbestätigung per E-Mail. Die
 * E-Mail ist der nach § 356a Abs. 3 BGB geschuldete dauerhafte Datenträger.
 *
 * Auth: requireOwner — nur Handwerks-Inhaber haben das SaFix-Pro-Abo, also ist
 *   nur dieser Personenkreis Vertragspartner des kostenpflichtigen Abos.
 * Rate-limit: 'critical' Tier + ein zusätzliches Stunden-Memory-Bucket pro
 *   userId gegen Spam.
 *
 * Der Endpunkt gibt keine personenbezogenen Inhalte zurück — nur das Outcome
 * (received / confirmationSent) plus eine maskierte Empfänger-Adresse für die UI.
 */

// Grobe Formatprüfung; die eigentliche Zustellbarkeit prüft Resend beim Versand.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MEMORY_BUCKET = new Map<string, number[]>()
const HOURLY_LIMIT = 5
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

const SUBJECT_DEFAULT = 'SaFix Pro Abonnement'

async function sendConfirmationViaResend(
  apiKey: string,
  from: string,
  to: string,
  declaredAtIso: string,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const dateStr = new Date(declaredAtIso).toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const subject = 'Eingangsbestätigung Ihres Widerrufs — SaFix Pro'
  const lines = [
    'Guten Tag,',
    '',
    `wir bestätigen den Eingang Ihrer Widerrufserklärung zum SaFix-Pro-Abonnement am ${dateStr}.`,
    '',
    'Diese E-Mail ist Ihre Bestätigung auf einem dauerhaften Datenträger gemäß § 356a Abs. 3 BGB.',
    '',
    'Haben Sie verlangt, dass die Leistung bereits während der Widerrufsfrist beginnt, schulden Sie für die bis zum Widerruf erbrachte Leistung einen anteiligen Wertersatz. Etwaige Erstattungen erfolgen über das ursprünglich verwendete Zahlungsmittel.',
    '',
    'Hinweis: Die laufende Abrechnung des Abonnements wird über den App Store von Apple abgewickelt. Die Verwaltung und Kündigung des Abos ist zusätzlich jederzeit unter iOS-Einstellungen → Apple-ID → Abonnements möglich.',
    '',
    'Mit freundlichen Grüßen',
    'Leon Karim Valentin – SaFix',
    'Ihmepassage 6, 30449 Hannover',
  ]
  const text = lines.join('\n')
  const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;">
  <h2 style="margin-top:0;">Eingangsbestätigung Ihres Widerrufs</h2>
  <p>Guten Tag,</p>
  <p>wir bestätigen den Eingang Ihrer Widerrufserklärung zum SaFix-Pro-Abonnement am <strong>${dateStr}</strong>.</p>
  <p>Diese E-Mail ist Ihre Bestätigung auf einem dauerhaften Datenträger gemäß § 356a Abs. 3 BGB.</p>
  <p>Haben Sie verlangt, dass die Leistung bereits während der Widerrufsfrist beginnt, schulden Sie für die bis zum Widerruf erbrachte Leistung einen anteiligen Wertersatz. Etwaige Erstattungen erfolgen über das ursprünglich verwendete Zahlungsmittel.</p>
  <p>Hinweis: Die laufende Abrechnung des Abonnements wird über den App Store von Apple abgewickelt. Die Verwaltung und Kündigung des Abos ist zusätzlich jederzeit unter iOS-Einstellungen → Apple-ID → Abonnements möglich.</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="font-size:12px;color:#6b7280;">Leon Karim Valentin – SaFix, Ihmepassage 6, 30449 Hannover. Bitte antworten Sie nicht auf diese automatische Nachricht.</p>
</body>
</html>`

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
    logWarning('api.submit_widerruf.hourly_limit_exceeded', { userId: auth.userId })
    res.setHeader('Retry-After', String(60 * 60))
    res.status(429).json({
      error: 'Zu viele Anfragen. Bitte versuche es später erneut.',
      code: 'rate_limit_exceeded',
    })
    return
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
    contactEmail?: unknown
  }
  const contactEmail =
    typeof body.contactEmail === 'string' && body.contactEmail.trim().length > 0
      ? body.contactEmail.trim()
      : null

  if (!contactEmail || !EMAIL_REGEX.test(contactEmail)) {
    res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse an.', code: 'invalid_email' })
    return
  }

  // § 356a Abs. 3 BGB verlangt eine Eingangsbestätigung auf dauerhaftem
  // Datenträger (E-Mail). Ist der Versand nicht konfiguriert, dürfen wir den
  // Widerruf NICHT erfassen, ohne ihn bestätigen zu können — fail closed.
  const resendKey = process.env.RESEND_API_KEY
  const fromAddress = process.env.NOTIFICATION_FROM_EMAIL
  if (!resendKey || !fromAddress) {
    logError('api.submit_widerruf.resend_unconfigured', undefined, { userId: auth.userId })
    res.status(503).json({
      error: 'Der Widerruf kann derzeit nicht entgegengenommen werden. Bitte versuche es später erneut oder wende dich per E-Mail an uns.',
      code: 'confirmation_unavailable',
    })
    return
  }

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.submit_widerruf.admin_unavailable', undefined, {
      missing: adminResult.missing,
    })
    res.status(500).json({ error: formatAdminUnavailable(adminResult.missing) })
    return
  }
  const admin = adminResult.client

  const { data: inserted, error: insertErr } = await admin
    .from('widerruf_requests')
    .insert({
      user_id: auth.userId,
      subject: SUBJECT_DEFAULT,
      contact_email: contactEmail,
    })
    .select('id, declared_at')
    .single()

  if (insertErr || !inserted) {
    logError(
      'api.submit_widerruf.insert_failed',
      insertErr instanceof Error ? insertErr : undefined,
      { userId: auth.userId },
    )
    res.status(500).json({ error: 'Widerruf konnte nicht erfasst werden. Bitte versuche es erneut.' })
    return
  }

  // Eingangsbestätigung per E-Mail (dauerhafter Datenträger, § 356a Abs. 3).
  // Der Widerruf ist mit dem Row-Write erfasst; schlägt der Versand zur Laufzeit
  // fehl, melden wir confirmationSent=false (Ops kann erneut zustellen).
  let confirmationSent = false
  const send = await sendConfirmationViaResend(
    resendKey,
    fromAddress,
    contactEmail,
    inserted.declared_at as string,
  )
  if (send.success) {
    confirmationSent = true
    logInfo('api.submit_widerruf.confirmation_sent', {
      userId: auth.userId,
      requestId: inserted.id,
      messageId: send.messageId,
    })
  } else {
    logError('api.submit_widerruf.confirmation_failed', undefined, {
      userId: auth.userId,
      requestId: inserted.id,
      error: send.error,
    })
  }

  logInfo('api.submit_widerruf.received', {
    userId: auth.userId,
    requestId: inserted.id,
    confirmationSent,
  })

  res.status(200).json({
    received: true,
    confirmationSent,
    maskedEmail: maskEmail(contactEmail),
  })
}
