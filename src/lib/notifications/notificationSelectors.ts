import type { ProjectTimelineEventType } from '../timeline'
import type { AttentionRole, NotificationItem, NotificationSignal } from './types'
import { getNotificationRoleRelevance } from './notificationConfig'

const NOTIFICATION_TITLES: Record<ProjectTimelineEventType, string> = {
  job_created: 'Auftrag erstellt',
  scheduled: 'Auftrag geplant',
  work_started: 'Arbeit begonnen',
  waiting_payment: 'Wartet auf Zahlung',
  photo_added: 'Foto hinzugefügt',
  artifact_attached: 'Anhang beigefügt',
  dispute_evidence_attached: 'Beweismittel beigefügt',
  invoice_created: 'Rechnung erstellt',
  invoice_issued: 'Rechnung ausgestellt',
  invoice_sent: 'Rechnung gesendet',
  invoice_cancelled: 'Stornorechnung ausgestellt',
  invoice_credit_note_issued: 'Gutschrift ausgestellt',
  offer_sent: 'Angebot erhalten',
  offer_accepted: 'Angebot akzeptiert',
  deposit_paid: 'Zahlung bestätigt',
  escrow_locked: 'Betrag hinterlegt',
  release_requested: 'Freigabe angefordert',
  payment_released: 'Zahlung freigegeben',
  dispute_opened: 'Streitfall eröffnet',
  dispute_resolved: 'Streitfall gelöst',
  dispute_resolved_release: 'Zahlung nach Streit freigegeben',
  dispute_resolved_refund: 'Rückerstattung nach Streit',
  dispute_resolved_split: 'Betrag aufgeteilt',
  dispute_default_refund_applied: 'Vorläufige Teilerstattung',
  dispute_rejected: 'Streitfall abgelehnt',
  dispute_under_review: 'Streitfall in Prüfung',
  dispute_evidence_requested: 'Belege angefordert',
  payment_refunded: 'Zahlung erstattet',
  job_completed: 'Auftrag abgeschlossen',
  job_scheduled: 'Auftrag eingeplant',
  schedule_updated: 'Zeitplan aktualisiert',
  schedule_confirmed: 'Termin bestätigt',
  schedule_rescheduled: 'Termin verschoben',
  schedule_cancelled: 'Termin abgesagt',
  execution_started: 'Ausführung gestartet',
  execution_completed: 'Ausführung abgeschlossen',
  proposal_sent: 'Angebot gesendet',
  proposal_accepted: 'Angebot angenommen',
  execution_ready: 'Ausführung bereit',
  work_completed: 'Arbeit abgeschlossen',
  funding_requested: 'Zahlungsaufforderung gesendet',
  tranche_25_eligible: '25%-Tranche freigabefähig',
  tranche_75_eligible: '75%-Tranche freigabefähig',
  tranche_released: 'Tranche freigegeben',
  release_blocked: 'Freigabe blockiert',
  payout_handoff_initiated: 'Auszahlung eingeleitet',
  payout_handoff_failed: 'Auszahlung fehlgeschlagen',
  payout_completed: 'Geld eingegangen',
  payout_failed: 'Auszahlung fehlgeschlagen',
  transfer_reversed: 'Transfer storniert',
  change_order_sent: 'Nachtragsangebot gesendet',
  change_order_accepted: 'Nachtragsangebot angenommen',
  change_order_declined: 'Nachtragsangebot abgelehnt',
  change_order_cancelled: 'Nachtragsangebot zurückgezogen',
  supplementary_payment_required: 'Nachzahlung erforderlich',
  supplementary_acknowledged: 'Nachzahlung bestätigt',
  supplementary_funding_initiated: 'Nachzahlung gestartet',
  supplementary_funded: 'Nachzahlung bezahlt',
  supplementary_released: 'Nachzahlung ausgezahlt',
  supplementary_paid: 'Nachzahlung erhalten',
  supplementary_waived: 'Nachzahlung erlassen',
  worker_marked_complete: 'Arbeit gemeldet',
  admin_confirmed_complete: 'Arbeit bestätigt',
  admin_rejected_completion: 'Bestätigung abgelehnt',
  acceptance_reminder_24h: '48 Stunden verbleiben',
  acceptance_reminder_60h: 'Letzte 12 Stunden',
  acceptance_customer_released: 'Kunde hat freigegeben',
  acceptance_auto_released: 'Frist abgelaufen',
  correction_created: 'Neue Korrektur-Anfrage',
  correction_resolved: 'Korrektur übernommen',
  correction_rejected: 'Korrektur abgelehnt',
  presales_converted: 'Projekt aus Aufmaß angelegt',
  spatial_shared_with_customer: 'Aufmaß freigegeben',
}

const NOTIFICATION_DESCRIPTIONS: Record<ProjectTimelineEventType, string> = {
  job_created: 'Ein neuer Auftrag wurde angelegt.',
  scheduled: 'Der Auftrag wurde im Kalender eingetragen.',
  work_started: 'Der Handwerker hat mit der Arbeit begonnen.',
  waiting_payment: 'Der Auftrag wartet auf eine Zahlung.',
  photo_added: 'Ein neues Foto wurde zum Auftrag hinzugefügt.',
  artifact_attached: 'Ein Medienanhang oder Beweisdokument wurde dem Auftrag beigefügt.',
  dispute_evidence_attached: 'Ein Beweismittel wurde dem Streitfall beigefügt.',
  invoice_created: 'Für diesen Auftrag wurde eine Rechnung erstellt.',
  invoice_issued: 'Die Rechnung wurde offiziell ausgestellt.',
  invoice_sent: 'Die Rechnung wurde an den Kunden gesendet.',
  invoice_cancelled: 'Eine Stornorechnung wurde ausgestellt und macht die Originalrechnung buchhalterisch nichtig.',
  invoice_credit_note_issued: 'Eine Gutschrift wurde ausgestellt und mindert die Forderung der Originalrechnung.',
  offer_sent: 'Der Handwerker hat dir ein Angebot zum Aufmaß gesendet.',
  offer_accepted: 'Das Angebot wurde vom Kunden akzeptiert.',
  deposit_paid: 'Die Zahlung wurde erfolgreich bestätigt.',
  escrow_locked: 'Der Betrag wurde sicher hinterlegt.',
  release_requested: 'Der Handwerker hat die Freigabe der Zahlung beantragt.',
  payment_released: 'Die Zahlung wurde aus der abgesicherten Zahlung freigegeben. Die Auszahlung folgt gemäß Stripe-Auszahlungsplan.',
  dispute_opened: 'Ein Streitfall wurde für diesen Auftrag eröffnet.',
  dispute_resolved: 'Der Streitfall wurde abschließend gelöst.',
  dispute_resolved_release: 'SaFix hat die Zahlung nach Prüfung an den Betrieb freigegeben.',
  dispute_resolved_refund: 'SaFix hat eine vollständige Rückerstattung an den Kunden angeordnet.',
  dispute_resolved_split: 'SaFix hat den Betrag anteilig aufgeteilt.',
  dispute_default_refund_applied:
    'Der noch abgesicherte, nicht ausgezahlte Restbetrag wurde dem Kunden vorläufig erstattet — unter Vorbehalt des Rechtswegs. Der bereits ausgezahlte Abschlag bleibt.',
  dispute_rejected: 'Der Einspruch wurde von SaFix abgelehnt.',
  dispute_under_review: 'SaFix hat den Streitfall zur Prüfung aufgenommen.',
  dispute_evidence_requested: 'SaFix hat die Einreichung weiterer Belege angefordert.',
  payment_refunded: 'Die Zahlung wurde an den Auftraggeber erstattet.',
  job_completed: 'Der Auftrag wurde erfolgreich abgeschlossen.',
  job_scheduled: 'Ein Ausführungsfenster wurde für den Auftrag geplant.',
  schedule_updated: 'Der Zeitplan für den Auftrag wurde aktualisiert.',
  schedule_confirmed: 'Der Termin für den Auftrag wurde verbindlich bestätigt.',
  schedule_rescheduled: 'Der Termin für den Auftrag wurde auf einen neuen Zeitpunkt verschoben.',
  schedule_cancelled: 'Der geplante Termin für den Auftrag wurde abgesagt.',
  execution_started: 'Die geplante Ausführung des Auftrags hat begonnen.',
  execution_completed: 'Die Ausführung des Auftrags wurde planmäßig abgeschlossen.',
  proposal_sent: 'Ein Angebot wurde an den Kunden übermittelt.',
  proposal_accepted: 'Der Kunde hat das Angebot angenommen. Das Projekt kann jetzt geplant werden.',
  execution_ready: 'Die Ausführungsvorbereitung wurde gestartet. Termin und Ressourcen können jetzt eingeplant werden.',
  work_completed: 'Der Handwerker hat die Arbeit als abgeschlossen markiert. Der Kunde kann den Abschluss bestätigen und den bereits über Stripe abgesicherten Betrag freigeben.',
  funding_requested: 'Der Handwerker hat eine Zahlungsaufforderung gesendet. Der Kunde kann jetzt die Zahlung vornehmen.',
  tranche_25_eligible: 'Die 25%-Tranche (Arbeitsbeginn) ist jetzt freigabefähig.',
  tranche_75_eligible: 'Die 75%-Tranche (Arbeitsabschluss) ist jetzt freigabefähig.',
  tranche_released: 'Eine Tranche wurde freigegeben und die Auszahlung eingeleitet.',
  release_blocked: 'Die Freigabe ist blockiert. Bitte prüfe die Auszahlungsbereitschaft.',
  payout_handoff_initiated: 'Die Auszahlung wurde an den Zahlungsdienstleister übergeben.',
  payout_handoff_failed: 'Die Auszahlung konnte nicht an den Zahlungsdienstleister übergeben werden.',
  payout_completed: 'Die Auszahlung ist auf deinem Bankkonto eingegangen.',
  payout_failed: 'Stripe konnte deine Auszahlung nicht abschließen. Prüfe deine Bankdaten, damit zukünftige Auszahlungen funktionieren.',
  transfer_reversed: 'Der Stripe-Transfer wurde storniert. Die Mittel sind zurück auf dem Plattform-Konto. Manuelle Klärung erforderlich.',
  change_order_sent: 'Ein Nachtragsangebot wurde an den Kunden gesendet.',
  change_order_accepted: 'Der Kunde hat das Nachtragsangebot angenommen.',
  change_order_declined: 'Der Kunde hat das Nachtragsangebot abgelehnt.',
  change_order_cancelled: 'Das Nachtragsangebot wurde zurückgezogen.',
  supplementary_payment_required: 'Ein angenommener Nachtrag erzeugt eine zusätzliche Zahlungspflicht.',
  supplementary_acknowledged: 'Der Kunde hat den zusätzlichen Zahlungsbedarf bestätigt.',
  supplementary_funding_initiated: 'Die Nachzahlung wurde an den Zahlungsdienstleister übergeben.',
  supplementary_funded: 'Die Nachzahlung wurde erfolgreich über die Plattform bezahlt.',
  supplementary_released: 'Der Nachtragsbetrag wurde an den Betrieb ausgezahlt.',
  supplementary_paid: 'Der Handwerker hat den Erhalt der Nachzahlung bestätigt.',
  supplementary_waived: 'Der Handwerker hat auf die Nachzahlung verzichtet.',
  worker_marked_complete: 'Ein Mitarbeiter hat die Arbeit als fertig gemeldet — bitte bestätigen, damit die Abnahme beim Kunden öffnet.',
  admin_confirmed_complete: 'Der Betrieb hat die Arbeit bestätigt. Du hast jetzt 72 Stunden, um die Freigabe oder einen Mangel zu melden.',
  admin_rejected_completion: 'Der Betrieb hat deine Fertigmeldung zurückgegeben. Bitte prüfe und melde erneut, sobald die Arbeit wirklich abgeschlossen ist.',
  acceptance_reminder_24h: 'Du kannst die Arbeit jetzt freigeben oder einen Mangel melden. Sonst läuft die Freigabe nach 72 Stunden automatisch.',
  acceptance_reminder_60h: 'Letzte 12 Stunden vor der automatischen Freigabe. Bitte jetzt prüfen und freigeben oder einen Mangel melden.',
  acceptance_customer_released: 'Der Kunde hat die Arbeit freigegeben. Die Auszahlung wird jetzt eingeleitet.',
  acceptance_auto_released: 'Die 72-Stunden-Frist ist abgelaufen. Die Auszahlung läuft automatisch.',
  correction_created: 'Ein Mitarbeiter hat eine Korrektur-Anfrage eingereicht. Bitte prüfen und übernehmen oder ablehnen.',
  correction_resolved: 'Der Betrieb hat deine Korrektur-Anfrage übernommen.',
  correction_rejected: 'Der Betrieb hat deine Korrektur-Anfrage abgelehnt. Details findest du in der Begründung.',
  presales_converted: 'Aus deinem Aufmaß wurde ein Kunden-Projekt angelegt.',
  spatial_shared_with_customer:
    'Dein Handwerker hat dir das 3D-Aufmaß freigegeben — du kannst es jetzt ansehen.',
}

const NOTIFICATION_LABELS: Record<ProjectTimelineEventType, string> = {
  job_created: 'Neu',
  scheduled: 'Geplant',
  work_started: 'In Arbeit',
  waiting_payment: 'Zahlung',
  photo_added: 'Foto',
  artifact_attached: 'Anhang',
  dispute_evidence_attached: 'Beweis',
  invoice_created: 'Rechnung',
  invoice_issued: 'Ausgestellt',
  invoice_sent: 'Gesendet',
  invoice_cancelled: 'Storno',
  invoice_credit_note_issued: 'Gutschrift',
  offer_sent: 'Neu',
  offer_accepted: 'Akzeptiert',
  deposit_paid: 'Einzahlung',
  escrow_locked: 'Hinterlegt',
  release_requested: 'Freigabe',
  payment_released: 'Freigegeben',
  dispute_opened: 'Streit',
  dispute_resolved: 'Gelöst',
  dispute_resolved_release: 'Freigabe',
  dispute_resolved_refund: 'Erstattung',
  dispute_resolved_split: 'Teilung',
  dispute_default_refund_applied: 'Erstattung',
  dispute_rejected: 'Abgelehnt',
  dispute_under_review: 'Prüfung',
  dispute_evidence_requested: 'Belege',
  payment_refunded: 'Erstattet',
  job_completed: 'Abgeschlossen',
  job_scheduled: 'Eingeplant',
  schedule_updated: 'Aktualisiert',
  schedule_confirmed: 'Bestätigt',
  schedule_rescheduled: 'Verschoben',
  schedule_cancelled: 'Abgesagt',
  execution_started: 'Gestartet',
  execution_completed: 'Abgeschlossen',
  proposal_sent: 'Angebot',
  proposal_accepted: 'Akzeptiert',
  execution_ready: 'Bereit',
  work_completed: 'Abgeschlossen',
  funding_requested: 'Zahlung',
  tranche_25_eligible: 'Freigabe',
  tranche_75_eligible: 'Freigabe',
  tranche_released: 'Freigegeben',
  release_blocked: 'Blockiert',
  payout_handoff_initiated: 'Auszahlung',
  payout_handoff_failed: 'Fehler',
  payout_completed: 'Auszahlung',
  payout_failed: 'Fehler',
  transfer_reversed: 'Storniert',
  change_order_sent: 'Nachtrag',
  change_order_accepted: 'Angenommen',
  change_order_declined: 'Abgelehnt',
  change_order_cancelled: 'Zurückgezogen',
  supplementary_payment_required: 'Nachzahlung',
  supplementary_acknowledged: 'Bestätigt',
  supplementary_funding_initiated: 'Gestartet',
  supplementary_funded: 'Bezahlt',
  supplementary_released: 'Ausgezahlt',
  supplementary_paid: 'Erhalten',
  supplementary_waived: 'Erlassen',
  worker_marked_complete: 'Gemeldet',
  admin_confirmed_complete: 'Bestätigt',
  admin_rejected_completion: 'Zurück',
  acceptance_reminder_24h: 'Erinnerung',
  acceptance_reminder_60h: 'Letzte Frist',
  acceptance_customer_released: 'Freigegeben',
  acceptance_auto_released: 'Auto-Freigabe',
  correction_created: 'Korrektur',
  correction_resolved: 'Übernommen',
  correction_rejected: 'Abgelehnt',
  presales_converted: 'Auftrag erstellt',
  spatial_shared_with_customer: 'Freigegeben',
}

export function mapSignalToNotificationItem(
  signal: NotificationSignal
): NotificationItem {
  return {
    ...signal,
    title: NOTIFICATION_TITLES[signal.type],
    description: NOTIFICATION_DESCRIPTIONS[signal.type],
    label: NOTIFICATION_LABELS[signal.type],
  }
}

export function buildNotificationItems(
  signals: NotificationSignal[]
): NotificationItem[] {
  return signals.map(mapSignalToNotificationItem)
}

/**
 * Returns notification items filtered to those relevant for the given role.
 * Items without explicit role scoping are included for all roles.
 */
export function buildNotificationItemsForRole(
  signals: NotificationSignal[],
  role: AttentionRole
): NotificationItem[] {
  return signals
    .filter((signal) => {
      if (role === 'customer' || role === 'craftsman') {
        if (signal.recipientRole !== role) return false
      }
      const roles = getNotificationRoleRelevance(signal.type)
      return !roles || roles.includes(role)
    })
    .map(mapSignalToNotificationItem)
}

/**
 * Returns notification items grouped by priority for display in sections.
 */
export function groupNotificationsByPriority(items: NotificationItem[]): {
  alerts: NotificationItem[]
  actions: NotificationItem[]
  infos: NotificationItem[]
} {
  return {
    alerts: items.filter((i) => i.priority === 'alert'),
    actions: items.filter((i) => i.priority === 'action'),
    infos: items.filter((i) => i.priority === 'info'),
  }
}
