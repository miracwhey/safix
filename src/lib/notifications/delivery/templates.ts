/**
 * Email content templates for transactional notification delivery.
 *
 * Each builder returns a plain { subject, html, text } tuple for a given
 * delivery type and optional context.  Templates are intentionally simple and
 * transactional — no marketing language, no heavy templating engine.
 */

import type { NotificationDeliveryType } from './types.js'
import { formatEuro } from '../../shared/formatters.js'

export type EmailContent = {
  subject: string
  /** Plain-text fallback (always populated) */
  text: string
  /** Minimal HTML email body */
  html: string
}

type TemplateContext = Record<string, unknown>

// ---------------------------------------------------------------------------
// Individual template builders
// ---------------------------------------------------------------------------

function proposalReceived(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Angebot erhalten: ${jobTitle}`
  const body = `Sie haben ein neues Angebot für "${jobTitle}" erhalten. Bitte melden Sie sich in der App an, um die Details zu prüfen und zu antworten.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function scheduleCreated(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Termin vereinbart: ${jobTitle}`
  const body = `Für "${jobTitle}" wurde ein Termin eingetragen. Bitte prüfen Sie die Details in der App.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function scheduleUpdated(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Termin geändert: ${jobTitle}`
  const body = `Der Termin für "${jobTitle}" wurde aktualisiert. Bitte prüfen Sie die neuen Details in der App.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function workCompleted(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Arbeit abgeschlossen: ${jobTitle}`
  const body = `Die Arbeiten für "${jobTitle}" wurden als abgeschlossen markiert. Bitte prüfen Sie das Ergebnis in der App und bestätigen Sie den Abschluss, um die Zahlung freizugeben. Der Betrag ist bereits über Stripe abgesichert — es ist keine erneute Überweisung nötig.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function paymentReleaseRequested(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Zahlungsfreigabe angefordert: ${jobTitle}`
  const body = `Für "${jobTitle}" wurde eine Zahlungsfreigabe angefordert. Bitte melden Sie sich in der App an, um den aktuellen Stand einzusehen.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function disputeOpened(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Konflikt geöffnet: ${jobTitle}`
  const body = `Für "${jobTitle}" wurde ein Konfliktfall eröffnet. Bitte melden Sie sich in der App an, um weitere Details zu erhalten und ggf. Nachweise einzureichen.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

function disputeEvidenceRequested(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Nachweise angefordert: ${jobTitle}`
  const body = `Im Konfliktfall zu "${jobTitle}" wurden Nachweise von Ihnen angefordert. Bitte reichen Sie diese zeitnah in der App ein.`
  return {
    subject,
    text: body,
    html: wrapHtml(subject, body),
  }
}

// ── Block 3: Payment / Payout trust corridor ────────────────────────────────

function escrowLocked(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const role = String(ctx.recipientRole ?? 'customer')
  const subject = `Zahlung abgesichert: ${jobTitle}`
  const body = role === 'craftsman'
    ? `Die Zahlung für "${jobTitle}" ist über Stripe abgesichert. Sie können mit der Arbeit beginnen — die 25 %-Tranche wird bei Arbeitsbeginn automatisch freigegeben.`
    : `Ihre Zahlung für "${jobTitle}" ist über Stripe abgesichert. Der Betrag wird erst an den Handwerker freigegeben, wenn die Arbeit erledigt und von Ihnen bestätigt ist.`
  return { subject, text: body, html: wrapHtml(subject, body) }
}

function paymentReleased(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Zahlung freigegeben: ${jobTitle}`
  const body = `Die Zahlung für "${jobTitle}" wurde aus der abgesicherten Zahlung freigegeben und zur Auszahlung übergeben. Sobald das Geld auf Ihrem Bankkonto eingegangen ist, erhalten Sie eine Bestätigung.`
  return { subject, text: body, html: wrapHtml(subject, body) }
}

function payoutHandoffInitiated(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Zur Auszahlung übergeben: ${jobTitle}`
  const body = `Das Geld für "${jobTitle}" wurde an Ihren Zahlungsdienstleister übergeben. Die Auszahlung auf Ihr Bankkonto erfolgt gemäß Ihrem Stripe-Auszahlungsplan.`
  return { subject, text: body, html: wrapHtml(subject, body) }
}

function payoutCompleted(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Geld eingegangen: ${jobTitle}`
  const body = `Die Auszahlung für "${jobTitle}" ist auf Ihrem Bankkonto eingegangen. Der Auftrag ist vollständig abgeschlossen.`
  return { subject, text: body, html: wrapHtml(subject, body) }
}

function payoutFailed(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const subject = `Auszahlung fehlgeschlagen: ${jobTitle}`
  const body = `Die Auszahlung für "${jobTitle}" an Ihr Bankkonto ist fehlgeschlagen. SaFix prüft den Fall und meldet sich bei Ihnen — Sie müssen nichts weiter tun, Ihre Zahlung ist abgesichert.`
  return { subject, text: body, html: wrapHtml(subject, body) }
}

// ── Block P · Run 2: T+80 dispute-default-cut (provisional default refund) ───

function disputeDefaultRefundApplied(ctx: TemplateContext): EmailContent {
  const jobTitle = String(ctx.jobTitle ?? 'Ihr Auftrag')
  const role = String(ctx.recipientRole ?? 'customer')
  // Refunded held-remainder amount in MINOR units (EUR cents), threaded by the
  // worker. Rendered dynamically so the message is never silent on the split —
  // and never hardcodes 75/25. Absent/zero → omit the figure (held-zero case).
  const refundMinor = Number(ctx.refundAmountMinor ?? 0)
  const amountClause =
    Number.isFinite(refundMinor) && refundMinor > 0
      ? ` in Höhe von ${formatEuro(refundMinor / 100)}`
      : ''
  // Held-zero defensive case (refundMinor<=0): the secured remainder was already
  // fully paid out, so NOTHING is left to refund. Do not claim a refund was made
  // (display-truth) — effectively unreachable for the default path (releases are
  // frozen while a dispute is open) but guarded honestly.
  const hasRefund = Number.isFinite(refundMinor) && refundMinor > 0
  const subject = hasRefund
    ? `Vorläufige Rückerstattung veranlasst: ${jobTitle}`
    : `Konfliktfall abgeschlossen: ${jobTitle}`
  // Neutral, transactional copy. The T+80 default is a PARTIAL (anteilige)
  // refund of the still-HELD remainder — the already-paid-out share stays with
  // the craftsman (Option B / G6=B). Explicitly provisional ("vorläufig/
  // provisorisch") with an explicit right-of-recourse reservation ("unter dem
  // Vorbehalt des Rechtswegs"). Role-differentiated like escrowLocked: the
  // customer is the refund recipient, the craftsman keeps the paid-out share.
  let body: string
  if (!hasRefund) {
    body = role === 'craftsman'
      ? `Im Konfliktfall zu "${jobTitle}" wurde innerhalb der AGB-Frist von 80 Tagen weder eine Einigung erzielt noch eine Entscheidung getroffen. Der abgesicherte Betrag war zu diesem Zeitpunkt bereits vollständig an Sie ausgezahlt; es verbleibt kein einbehaltener Anteil, sodass keine Rückerstattung an den Kunden veranlasst wurde. Diese Feststellung erfolgt unter dem Vorbehalt des Rechtswegs: Ihre Ansprüche bleiben hiervon unberührt. Die Details sehen Sie in der App.`
      : `Im Konfliktfall zu "${jobTitle}" wurde innerhalb der AGB-Frist von 80 Tagen weder eine Einigung erzielt noch eine Entscheidung getroffen. Der abgesicherte Betrag war zu diesem Zeitpunkt bereits vollständig an den Betrieb ausgezahlt; es verbleibt kein einbehaltener Anteil, der an Sie zurückerstattet werden könnte. Diese Feststellung erfolgt unter dem Vorbehalt des Rechtswegs: Ihre Ansprüche bleiben hiervon unberührt und können weiterhin geltend gemacht werden. Die Details sehen Sie in der App.`
  } else {
    body = role === 'craftsman'
      ? `Im Konfliktfall zu "${jobTitle}" wurde innerhalb der AGB-Frist von 80 Tagen weder eine Einigung erzielt noch eine Entscheidung getroffen. Gemäß den AGB wurde daher eine vorläufige (provisorische) anteilige Rückerstattung des noch abgesicherten Betrags${amountClause} an den Kunden veranlasst. Der bereits an Sie ausgezahlte Anteil verbleibt bei Ihnen. Diese Maßnahme erfolgt unter dem Vorbehalt des Rechtswegs: Sie ist vorläufig und ersetzt keine rechtliche Klärung. Ihre Ansprüche bleiben hiervon unberührt und können weiterhin geltend gemacht werden. Die Details sehen Sie in der App.`
      : `Im Konfliktfall zu "${jobTitle}" wurde innerhalb der AGB-Frist von 80 Tagen weder eine Einigung erzielt noch eine Entscheidung getroffen. Gemäß den AGB wurde daher eine vorläufige (provisorische) anteilige Rückerstattung des noch abgesicherten Betrags${amountClause} an Sie veranlasst. Der bereits an den Betrieb ausgezahlte Anteil verbleibt beim Betrieb. Diese Rückerstattung erfolgt unter dem Vorbehalt des Rechtswegs: Sie ist vorläufig und ersetzt keine rechtliche Klärung der Angelegenheit. Die Gegenseite kann ihre Ansprüche weiterhin geltend machen. Die Details sehen Sie in der App.`
  }
  return { subject, text: body, html: wrapHtml(subject, body) }
}

// ---------------------------------------------------------------------------
// HTML wrapper
// ---------------------------------------------------------------------------

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1a1a1a;">
  <h2 style="margin-top:0;">${escapeHtml(title)}</h2>
  <p>${escapeHtml(body)}</p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
  <p style="font-size:12px;color:#6b7280;">Diese E-Mail wurde automatisch von SaFix gesendet. Bitte antworten Sie nicht auf diese Nachricht.</p>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

const TEMPLATE_MAP: Record<
  NotificationDeliveryType,
  (ctx: TemplateContext) => EmailContent
> = {
  proposal_received: proposalReceived,
  schedule_created: scheduleCreated,
  schedule_updated: scheduleUpdated,
  work_completed: workCompleted,
  payment_release_requested: paymentReleaseRequested,
  dispute_opened: disputeOpened,
  dispute_evidence_requested: disputeEvidenceRequested,
  escrow_locked: escrowLocked,
  payment_released: paymentReleased,
  payout_handoff_initiated: payoutHandoffInitiated,
  payout_completed: payoutCompleted,
  payout_failed: payoutFailed,
  dispute_default_refund_applied: disputeDefaultRefundApplied,
}

/**
 * Builds the email content for a given delivery type.
 * Returns subject, plain text body, and minimal HTML body.
 * Throws if `type` is not a recognised notification delivery type —
 * callers (especially the API handler) should validate `type` before calling.
 */
export function buildEmailContent(
  type: NotificationDeliveryType,
  context: TemplateContext = {}
): EmailContent {
  const builder = TEMPLATE_MAP[type]
  if (!builder) {
    throw new Error(`buildEmailContent: unknown notification type '${String(type)}'`)
  }
  return builder(context)
}
