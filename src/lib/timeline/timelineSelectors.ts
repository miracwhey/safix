import type { CalendarEntry } from '../calendar/calendarTypes'
import type { Invoice } from '../invoices/types'
import type { Job } from '../jobs/types'
import type { Payment } from '../payments/types'
import { getTimelineSignalsForJob } from './timelineStore'
import type {
  ProjectTimelineEvent,
  ProjectTimelineEventType,
  ProjectTimelineSignal,
  TimelineEventAccent,
} from './types'

function formatDateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function getTimelineEventLabel(
  type: ProjectTimelineEventType
): string {
  if (type === 'job_created') return 'Auftrag'
  if (type === 'scheduled') return 'Termin'
  if (type === 'work_started') return 'Start'
  if (type === 'waiting_payment') return 'Zahlung'
  if (type === 'photo_added') return 'Dokumentation'
  if (type === 'artifact_attached') return 'Anhang'
  if (type === 'dispute_evidence_attached') return 'Beweismittel'
  if (type === 'invoice_created') return 'Rechnung'
  if (type === 'invoice_issued') return 'Ausgestellt'
  if (type === 'invoice_sent') return 'Gesendet'
  if (type === 'invoice_cancelled') return 'Storno'
  if (type === 'invoice_credit_note_issued') return 'Gutschrift'
  if (type === 'deposit_paid') return 'Einzahlung'
  if (type === 'escrow_locked') return 'Escrow'
  if (type === 'release_requested') return 'Freigabe'
  if (type === 'payment_released') return 'Auszahlung'
  if (type === 'dispute_opened') return 'Dispute'
  if (type === 'dispute_resolved') return 'Einigung'
  if (type === 'dispute_resolved_release') return 'Freigabe'
  if (type === 'dispute_resolved_refund') return 'Erstattung'
  if (type === 'dispute_resolved_split') return 'Teilung'
  if (type === 'dispute_default_refund_applied') return 'Erstattung'
  if (type === 'dispute_rejected') return 'Abgelehnt'
  if (type === 'dispute_under_review') return 'Prüfung'
  if (type === 'dispute_evidence_requested') return 'Belege'
  if (type === 'payment_refunded') return 'Erstattung'
  if (type === 'job_scheduled') return 'Planung'
  if (type === 'schedule_updated') return 'Aktualisierung'
  if (type === 'schedule_confirmed') return 'Bestätigung'
  if (type === 'schedule_rescheduled') return 'Umplanung'
  if (type === 'schedule_cancelled') return 'Abgesagt'
  if (type === 'execution_started') return 'Ausführung'
  if (type === 'execution_completed') return 'Fertig'
  if (type === 'proposal_sent') return 'Angebot'
  if (type === 'proposal_accepted') return 'Akzeptiert'
  if (type === 'work_completed') return 'Fertig'
  if (type === 'job_completed') return 'Abschluss'
  if (type === 'execution_ready') return 'Bereit'
  if (type === 'funding_requested') return 'Zahlungsaufforderung'
  if (type === 'tranche_25_eligible') return 'Teilfreigabe'
  if (type === 'tranche_75_eligible') return 'Restfreigabe'
  if (type === 'tranche_released') return 'Freigabe'
  if (type === 'release_blocked') return 'Blockiert'
  if (type === 'payout_handoff_initiated') return 'Auszahlung'
  if (type === 'payout_handoff_failed') return 'Fehler'
  if (type === 'payout_completed') return 'Auf Konto'
  if (type === 'payout_failed') return 'Fehler'
  if (type === 'transfer_reversed') return 'Transfer storniert'
  if (type === 'offer_sent') return 'Angebot'
  if (type === 'offer_accepted') return 'Angebot'
  if (type === 'change_order_sent') return 'Nachtrag'
  if (type === 'change_order_accepted') return 'Nachtrag'
  if (type === 'change_order_declined') return 'Nachtrag'
  if (type === 'change_order_cancelled') return 'Nachtrag'
  if (type === 'supplementary_payment_required') return 'Nachzahlung'
  if (type === 'supplementary_acknowledged') return 'Nachzahlung'
  if (type === 'supplementary_funding_initiated') return 'Nachzahlung'
  if (type === 'supplementary_funded') return 'Nachzahlung'
  if (type === 'supplementary_released') return 'Auszahlung'
  if (type === 'supplementary_paid') return 'Nachzahlung'
  if (type === 'supplementary_waived') return 'Nachzahlung'
  return 'Abschluss'
}

export function getTimelineEventAccent(
  type: ProjectTimelineEventType
): TimelineEventAccent {
  if (type === 'job_created') return 'slate'
  if (type === 'scheduled') return 'blue'
  if (type === 'work_started') return 'blue'
  if (type === 'waiting_payment') return 'amber'
  if (type === 'photo_added') return 'violet'
  if (type === 'artifact_attached') return 'violet'
  if (type === 'dispute_evidence_attached') return 'rose'
  if (type === 'invoice_created') return 'violet'
  if (type === 'invoice_issued') return 'violet'
  if (type === 'invoice_sent') return 'emerald'
  if (type === 'invoice_cancelled') return 'rose'
  if (type === 'invoice_credit_note_issued') return 'amber'
  if (type === 'deposit_paid') return 'emerald'
  if (type === 'escrow_locked') return 'amber'
  if (type === 'release_requested') return 'amber'
  if (type === 'payment_released') return 'emerald'
  if (type === 'dispute_opened') return 'rose'
  if (type === 'dispute_resolved') return 'emerald'
  if (type === 'dispute_resolved_release') return 'emerald'
  if (type === 'dispute_resolved_refund') return 'rose'
  if (type === 'dispute_resolved_split') return 'amber'
  if (type === 'dispute_default_refund_applied') return 'amber'
  if (type === 'dispute_rejected') return 'slate'
  if (type === 'dispute_under_review') return 'amber'
  if (type === 'dispute_evidence_requested') return 'rose'
  if (type === 'payment_refunded') return 'rose'
  if (type === 'job_scheduled') return 'blue'
  if (type === 'schedule_updated') return 'blue'
  if (type === 'schedule_confirmed') return 'emerald'
  if (type === 'schedule_rescheduled') return 'amber'
  if (type === 'schedule_cancelled') return 'rose'
  if (type === 'execution_started') return 'violet'
  if (type === 'execution_completed') return 'emerald'
  if (type === 'proposal_sent') return 'blue'
  if (type === 'proposal_accepted') return 'emerald'
  if (type === 'work_completed') return 'violet'
  if (type === 'job_completed') return 'emerald'
  if (type === 'execution_ready') return 'blue'
  if (type === 'funding_requested') return 'amber'
  if (type === 'tranche_25_eligible') return 'emerald'
  if (type === 'tranche_75_eligible') return 'emerald'
  if (type === 'tranche_released') return 'emerald'
  if (type === 'release_blocked') return 'amber'
  if (type === 'payout_handoff_initiated') return 'blue'
  if (type === 'payout_handoff_failed') return 'rose'
  if (type === 'payout_completed') return 'emerald'
  if (type === 'payout_failed') return 'rose'
  if (type === 'transfer_reversed') return 'amber'
  if (type === 'offer_sent') return 'blue'
  if (type === 'offer_accepted') return 'emerald'
  if (type === 'change_order_sent') return 'amber'
  if (type === 'change_order_accepted') return 'emerald'
  if (type === 'change_order_declined') return 'rose'
  if (type === 'change_order_cancelled') return 'slate'
  if (type === 'supplementary_payment_required') return 'amber'
  if (type === 'supplementary_acknowledged') return 'amber'
  if (type === 'supplementary_funding_initiated') return 'amber'
  if (type === 'supplementary_funded') return 'emerald'
  if (type === 'supplementary_released') return 'emerald'
  if (type === 'supplementary_paid') return 'emerald'
  if (type === 'supplementary_waived') return 'slate'
  return 'emerald'
}

function getTimelineEventDescription(params: {
  signal: ProjectTimelineSignal
  job: Job
  calendarEntry?: CalendarEntry
  invoice?: Invoice
  payment?: Payment
}): string {
  const { signal, job, calendarEntry, invoice } = params

  if (signal.type === 'job_created') {
    return `${job.title} wurde angelegt und dem Betrieb zugeordnet.`
  }

  if (signal.type === 'scheduled') {
    if (calendarEntry) {
      return `Einsatz in ${calendarEntry.location} von ${calendarEntry.startsAtLabel} bis ${calendarEntry.endsAtLabel}.`
    }

    return `Für ${job.title} wurde ein Termin eingeplant.`
  }

  if (signal.type === 'work_started') {
    return 'Der Handwerker hat die Durchführung begonnen.'
  }

  if (signal.type === 'waiting_payment') {
    return 'Der Auftrag wurde operativ abgeschlossen und wartet auf Zahlungsfreigabe.'
  }

  if (signal.type === 'photo_added') {
    return 'Ein neues Foto wurde zur Dokumentation hinzugefügt.'
  }

  if (signal.type === 'artifact_attached') {
    return 'Ein Medienanhang oder Beweisdokument wurde dem Auftrag beigefügt.'
  }

  if (signal.type === 'dispute_evidence_attached') {
    return 'Ein Beweismittel wurde dem Streitfall beigefügt.'
  }

  if (signal.type === 'invoice_created') {
    if (invoice) {
      return `Rechnung ${invoice.invoiceNumber} wurde vorbereitet.`
    }

    return 'Eine Rechnung wurde für den Auftrag vorbereitet.'
  }

  if (signal.type === 'invoice_issued') {
    if (invoice) {
      return `Rechnung ${invoice.invoiceNumber} wurde ausgestellt.`
    }

    return 'Die Rechnung wurde ausgestellt.'
  }

  if (signal.type === 'invoice_sent') {
    if (invoice) {
      return `Rechnung ${invoice.invoiceNumber} wurde an den Kunden übermittelt.`
    }

    return 'Die Rechnung wurde an den Kunden übermittelt.'
  }

  if (signal.type === 'invoice_cancelled') {
    if (invoice) {
      return `Stornorechnung ${invoice.invoiceNumber} wurde ausgestellt und macht die Originalrechnung buchhalterisch nichtig.`
    }
    return 'Eine Stornorechnung wurde ausgestellt.'
  }

  if (signal.type === 'invoice_credit_note_issued') {
    if (invoice) {
      return `Gutschrift ${invoice.invoiceNumber} wurde ausgestellt und mindert die Forderung der Originalrechnung.`
    }
    return 'Eine Gutschrift wurde ausgestellt.'
  }

  if (signal.type === 'deposit_paid') {
    return 'Die Zahlung wurde bestätigt und im System erfasst.'
  }

  if (signal.type === 'payment_released') {
    return 'Die Auszahlung an den Betrieb wurde freigegeben.'
  }

  if (signal.type === 'dispute_opened') {
    return 'Der Zahlungsfall wurde in Klärung gesetzt.'
  }

  if (signal.type === 'dispute_under_review') {
    return 'SaFix hat den Streitfall zur eingehenden Prüfung aufgenommen.'
  }

  if (signal.type === 'dispute_evidence_requested') {
    return 'SaFix hat die Einreichung weiterer Belege angefordert.'
  }

  if (signal.type === 'escrow_locked') {
    return 'Der Zahlungsbetrag wurde über Stripe abgesichert und wartet auf Freigabe.'
  }

  if (signal.type === 'release_requested') {
    return 'Die Freigabe des Zahlungsbetrags wurde beantragt und wartet auf Bestätigung.'
  }

  if (signal.type === 'dispute_resolved') {
    return 'Der Konflikt wurde abgeschlossen und der Zahlungsfall final entschieden.'
  }

  if (signal.type === 'dispute_resolved_release') {
    return 'SaFix hat die Zahlung nach Prüfung an den Betrieb freigegeben. Der Fall ist abgeschlossen.'
  }

  if (signal.type === 'dispute_resolved_refund') {
    return 'SaFix hat eine vollständige Rückerstattung an den Kunden angeordnet. Der Fall ist abgeschlossen.'
  }

  if (signal.type === 'dispute_resolved_split') {
    return 'SaFix hat den Betrag anteilig aufgeteilt. Beide Parteien erhalten ihren zugesprochenen Anteil.'
  }

  if (signal.type === 'dispute_default_refund_applied') {
    return 'Der noch gesicherte Restbetrag wurde dem Kunden vorläufig teilerstattet. Die Entscheidung erfolgte unter Vorbehalt; der Rechtsweg bleibt für beide Parteien offen.'
  }

  if (signal.type === 'dispute_rejected') {
    return 'Der Einspruch wurde von SaFix abgelehnt. Die ursprüngliche Zahlungsvereinbarung bleibt bestehen.'
  }

  if (signal.type === 'payment_refunded') {
    return 'Der Zahlungsfall wurde zurückerstattet.'
  }

  if (signal.type === 'job_scheduled') {
    return `Für ${job.title} wurde ein Ausführungsfenster geplant.`
  }

  if (signal.type === 'schedule_updated') {
    return `Der Zeitplan für ${job.title} wurde aktualisiert.`
  }

  if (signal.type === 'schedule_confirmed') {
    return `Der Termin für ${job.title} wurde bestätigt und ist verbindlich.`
  }

  if (signal.type === 'schedule_rescheduled') {
    return `Der Termin für ${job.title} wurde auf einen neuen Zeitpunkt verschoben.`
  }

  if (signal.type === 'schedule_cancelled') {
    return `Der geplante Termin für ${job.title} wurde abgesagt.`
  }

  if (signal.type === 'execution_started') {
    return 'Die geplante Ausführung des Auftrags hat begonnen.'
  }

  if (signal.type === 'execution_completed') {
    return 'Die Ausführung des Auftrags wurde planmäßig abgeschlossen.'
  }

  if (signal.type === 'proposal_sent') {
    return `Ein Angebot für ${job.title} wurde an den Kunden übermittelt.`
  }

  if (signal.type === 'proposal_accepted') {
    return `Der Kunde hat das Angebot für ${job.title} angenommen. Das Projekt kann jetzt geplant werden.`
  }

  if (signal.type === 'work_completed') {
    return `Der Handwerker hat die Arbeit an ${job.title} als abgeschlossen markiert. Der Kunde kann den Abschluss bestätigen und den bereits über Stripe abgesicherten Betrag freigeben.`
  }

  if (signal.type === 'job_completed') {
    return `${job.title} wurde vollständig abgeschlossen und der Zahlungsfall final entschieden.`
  }

  if (signal.type === 'execution_ready') {
    return `Die Ausführungsvorbereitung für ${job.title} wurde gestartet. Termin und Ressourcen können jetzt eingeplant werden.`
  }

  if (signal.type === 'funding_requested') {
    return `Der Handwerker hat eine Zahlungsaufforderung für ${job.title} gesendet. Der Kunde kann jetzt die Zahlung vornehmen.`
  }

  if (signal.type === 'tranche_25_eligible') {
    return `Die 25%-Tranche (Arbeitsbeginn) für ${job.title} ist jetzt freigabefähig.`
  }

  if (signal.type === 'tranche_75_eligible') {
    return `Die 75%-Tranche (Arbeitsabschluss) für ${job.title} ist jetzt freigabefähig.`
  }

  if (signal.type === 'tranche_released') {
    return `Eine Tranche für ${job.title} wurde freigegeben und die Auszahlung an den Betrieb eingeleitet.`
  }

  if (signal.type === 'release_blocked') {
    return `Die Freigabe einer Tranche für ${job.title} ist blockiert. Bitte prüfe die Auszahlungsbereitschaft des Betriebs.`
  }

  if (signal.type === 'payout_handoff_initiated') {
    return `Die Auszahlung für ${job.title} wurde an den Zahlungsdienstleister übergeben.`
  }

  if (signal.type === 'payout_handoff_failed') {
    return `Die Auszahlung für ${job.title} konnte nicht an den Zahlungsdienstleister übergeben werden. Bitte prüfe den Fall.`
  }

  if (signal.type === 'payout_completed') {
    return `Die Auszahlung für ${job.title} ist auf deinem Bankkonto eingegangen.`
  }

  if (signal.type === 'payout_failed') {
    return `Die Auszahlung für ${job.title} an dein Bankkonto ist fehlgeschlagen. SaFix prüft den Fall.`
  }

  if (signal.type === 'transfer_reversed') {
    return `Der Stripe-Transfer für ${job.title} wurde storniert. Die Mittel sind zurück auf dem Plattform-Konto. Manuelle Klärung erforderlich.`
  }

  if (signal.type === 'supplementary_payment_required') {
    return `Ein angenommener Nachtrag erzeugt einen zusätzlichen Zahlungsbedarf für ${job.title}. Der ursprüngliche Zahlungsplan ist bereits gesichert — der Nachtragsbetrag muss separat beglichen werden.`
  }

  if (signal.type === 'supplementary_acknowledged') {
    return `Der Kunde hat den zusätzlichen Zahlungsbedarf für ${job.title} bestätigt.`
  }

  if (signal.type === 'supplementary_funding_initiated') {
    return `Die Nachzahlung für ${job.title} wurde an den Zahlungsdienstleister übergeben. Der Kunde schließt die Zahlung ab.`
  }

  if (signal.type === 'supplementary_funded') {
    return `Die Nachzahlung für ${job.title} wurde erfolgreich über die Plattform bezahlt.`
  }

  if (signal.type === 'supplementary_released') {
    return `Der Nachtragsbetrag für ${job.title} wurde an den Betrieb ausgezahlt.`
  }

  if (signal.type === 'supplementary_paid') {
    return `Der Handwerker hat den Erhalt der Nachzahlung für ${job.title} bestätigt.`
  }

  if (signal.type === 'supplementary_waived') {
    return `Der Handwerker hat auf die Nachzahlung für ${job.title} verzichtet.`
  }

  return 'Der Auftrag wurde vollständig abgeschlossen.'
}

function getTimelineEventTitle(type: ProjectTimelineEventType): string {
  if (type === 'job_created') return 'Auftrag erstellt'
  if (type === 'scheduled') return 'Termin geplant'
  if (type === 'work_started') return 'Arbeit gestartet'
  if (type === 'waiting_payment') return 'Wartet auf Zahlung'
  if (type === 'photo_added') return 'Foto hinzugefügt'
  if (type === 'artifact_attached') return 'Anhang beigefügt'
  if (type === 'dispute_evidence_attached') return 'Beweismittel beigefügt'
  if (type === 'invoice_created') return 'Rechnung erstellt'
  if (type === 'invoice_issued') return 'Rechnung ausgestellt'
  if (type === 'invoice_sent') return 'Rechnung gesendet'
  if (type === 'invoice_cancelled') return 'Stornorechnung ausgestellt'
  if (type === 'invoice_credit_note_issued') return 'Gutschrift ausgestellt'
  if (type === 'deposit_paid') return 'Zahlung bestätigt'
  if (type === 'payment_released') return 'Zahlung freigegeben'
  if (type === 'dispute_opened') return 'Konflikt eröffnet'
  if (type === 'escrow_locked') return 'Zahlung gesichert'
  if (type === 'release_requested') return 'Freigabe beantragt'
  if (type === 'dispute_resolved') return 'Konflikt abgeschlossen'
  if (type === 'dispute_resolved_release') return 'Zahlung freigegeben (Dispute)'
  if (type === 'dispute_resolved_refund') return 'Rückerstattung angeordnet'
  if (type === 'dispute_resolved_split') return 'Betrag aufgeteilt'
  if (type === 'dispute_default_refund_applied') return 'Vorläufige Teilerstattung'
  if (type === 'dispute_rejected') return 'Einspruch abgelehnt'
  if (type === 'dispute_under_review') return 'Konflikt in Prüfung'
  if (type === 'dispute_evidence_requested') return 'Belege angefordert'
  if (type === 'payment_refunded') return 'Zahlung erstattet'
  if (type === 'job_scheduled') return 'Auftrag eingeplant'
  if (type === 'schedule_updated') return 'Zeitplan aktualisiert'
  if (type === 'schedule_confirmed') return 'Termin bestätigt'
  if (type === 'schedule_rescheduled') return 'Termin verschoben'
  if (type === 'schedule_cancelled') return 'Termin abgesagt'
  if (type === 'execution_started') return 'Ausführung gestartet'
  if (type === 'execution_completed') return 'Ausführung abgeschlossen'
  if (type === 'proposal_sent') return 'Angebot gesendet'
  if (type === 'proposal_accepted') return 'Angebot angenommen'
  if (type === 'work_completed') return 'Arbeit abgeschlossen'
  if (type === 'job_completed') return 'Auftrag abgeschlossen'
  if (type === 'execution_ready') return 'Ausführung bereit'
  if (type === 'funding_requested') return 'Zahlungsaufforderung gesendet'
  if (type === 'tranche_25_eligible') return '25%-Tranche freigabefähig'
  if (type === 'tranche_75_eligible') return '75%-Tranche freigabefähig'
  if (type === 'tranche_released') return 'Tranche freigegeben'
  if (type === 'release_blocked') return 'Freigabe blockiert'
  if (type === 'payout_handoff_initiated') return 'Auszahlung eingeleitet'
  if (type === 'payout_handoff_failed') return 'Auszahlung fehlgeschlagen'
  if (type === 'payout_completed') return 'Auf deinem Konto'
  if (type === 'payout_failed') return 'Auszahlung fehlgeschlagen'
  if (type === 'transfer_reversed') return 'Transfer storniert — Klärung erforderlich'
  if (type === 'offer_sent') return 'Angebot gesendet'
  if (type === 'offer_accepted') return 'Angebot angenommen'
  if (type === 'change_order_sent') return 'Nachtrag gesendet'
  if (type === 'change_order_accepted') return 'Nachtrag angenommen'
  if (type === 'change_order_declined') return 'Nachtrag abgelehnt'
  if (type === 'change_order_cancelled') return 'Nachtrag zurückgezogen'
  if (type === 'supplementary_payment_required') return 'Nachzahlung erforderlich'
  if (type === 'supplementary_acknowledged') return 'Nachzahlung bestätigt'
  if (type === 'supplementary_funding_initiated') return 'Nachzahlung gestartet'
  if (type === 'supplementary_funded') return 'Nachzahlung bezahlt'
  if (type === 'supplementary_released') return 'Nachzahlung ausgezahlt'
  if (type === 'supplementary_paid') return 'Nachzahlung erhalten'
  if (type === 'supplementary_waived') return 'Nachzahlung erlassen'
  return 'Auftrag abgeschlossen'
}

export function mapSignalToTimelineEvent(params: {
  signal: ProjectTimelineSignal
  job: Job
  calendarEntry?: CalendarEntry
  invoice?: Invoice
  payment?: Payment
}): ProjectTimelineEvent {
  const { signal, job, calendarEntry, invoice, payment } = params

  return {
    id: signal.id,
    jobId: signal.jobId,
    type: signal.type,
    title: getTimelineEventTitle(signal.type),
    description: getTimelineEventDescription({
      signal,
      job,
      calendarEntry,
      invoice,
      payment,
    }),
    label: getTimelineEventLabel(signal.type),
    accent: getTimelineEventAccent(signal.type),
    dateLabel: formatDateLabel(signal.occurredAt),
    createdAt: signal.occurredAt,
  }
}

export function buildProjectTimeline(params: {
  job: Job
  calendarEntry?: CalendarEntry
  invoice?: Invoice
  payment?: Payment
}): ProjectTimelineEvent[] {
  const { job, calendarEntry, invoice, payment } = params

  return getTimelineSignalsForJob(job.id).map((signal) =>
    mapSignalToTimelineEvent({
      signal,
      job,
      calendarEntry,
      invoice,
      payment,
    })
  )
}
