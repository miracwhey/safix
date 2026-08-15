-- ===========================================================================
-- Block A · M1 — correction_resolved Push-Copy
-- ===========================================================================
-- Adds title + body strings for `correction_resolved` to notification_push_copy.
-- The signal type is emitted by approveCorrectionWorkflow (Worker-side push
-- after Owner approves), but the original migration `20260503000003` did not
-- include it — workers therefore receive the trigger fan-out without a
-- localized title/body and the push falls back to "Neue Benachrichtigung /
-- Bitte in der App prüfen.", which masks the actual outcome.
--
-- This migration replaces the function with a complete body that mirrors
-- the original cases plus the new `correction_resolved` strings. CREATE OR
-- REPLACE keeps the trigger wiring intact — no DROP / re-attach.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.notification_push_copy(p_type text)
RETURNS TABLE (title text, body text)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE p_type
      WHEN 'dispute_opened'              THEN 'Streitfall eröffnet'
      WHEN 'dispute_resolved'            THEN 'Streitfall entschieden'
      WHEN 'dispute_under_review'        THEN 'Streitfall in Prüfung'
      WHEN 'dispute_evidence_attached'   THEN 'Neue Belege im Streitfall'
      WHEN 'dispute_evidence_requested'  THEN 'Belege angefordert'
      WHEN 'dispute_response_required'   THEN 'Antwort erforderlich'
      WHEN 'release_requested'           THEN 'Freigabe angefragt'
      WHEN 'release_blocked'             THEN 'Freigabe blockiert'
      WHEN 'work_completed'              THEN 'Arbeit abgeschlossen'
      WHEN 'worker_marked_complete'      THEN 'Mitarbeiter meldet Abschluss'
      WHEN 'admin_confirmed_complete'    THEN 'Abschluss bestätigt'
      WHEN 'admin_rejected_completion'   THEN 'Abschluss abgelehnt'
      WHEN 'acceptance_reminder_24h'     THEN 'Erinnerung: Abnahme'
      WHEN 'acceptance_reminder_60h'     THEN 'Letzte Erinnerung: Abnahme'
      WHEN 'funding_requested'           THEN 'Zahlung angefragt'
      WHEN 'invoice_cancelled'           THEN 'Rechnung storniert'
      WHEN 'payment_refunded'            THEN 'Zahlung zurückerstattet'
      WHEN 'payout_handoff_failed'       THEN 'Auszahlung fehlgeschlagen'
      WHEN 'payout_failed'               THEN 'Auszahlung fehlgeschlagen'
      WHEN 'transfer_reversed'           THEN 'Buchung zurückgenommen'
      WHEN 'schedule_rescheduled'        THEN 'Termin geändert'
      WHEN 'schedule_cancelled'          THEN 'Termin abgesagt'
      WHEN 'proposal_accepted'           THEN 'Angebot angenommen'
      WHEN 'correction_created'          THEN 'Korrektur angefragt'
      WHEN 'correction_rejected'         THEN 'Korrektur abgelehnt'
      WHEN 'correction_resolved'         THEN 'Korrektur angenommen'
      ELSE 'Neue Benachrichtigung'
    END,
    CASE p_type
      WHEN 'dispute_opened'              THEN 'Ein Streitfall wurde eröffnet. Bitte in der App prüfen.'
      WHEN 'dispute_resolved'            THEN 'Eine Entscheidung wurde getroffen.'
      WHEN 'dispute_under_review'        THEN 'Wir prüfen die Unterlagen — Status in der App einsehbar.'
      WHEN 'dispute_evidence_attached'   THEN 'Es wurden neue Belege hochgeladen.'
      WHEN 'dispute_evidence_requested'  THEN 'Bitte reichen Sie weitere Belege ein.'
      WHEN 'dispute_response_required'   THEN 'Im Streitfall wird Ihre Stellungnahme erwartet.'
      WHEN 'release_requested'           THEN 'Eine Auszahlung wurde angefragt.'
      WHEN 'release_blocked'             THEN 'Eine Auszahlung ist blockiert — bitte prüfen.'
      WHEN 'work_completed'              THEN 'Die Arbeit wurde als abgeschlossen gemeldet.'
      WHEN 'worker_marked_complete'      THEN 'Ein Mitarbeiter hat den Abschluss gemeldet.'
      WHEN 'admin_confirmed_complete'    THEN 'Der Abschluss wurde bestätigt.'
      WHEN 'admin_rejected_completion'   THEN 'Der Abschluss wurde abgelehnt — bitte prüfen.'
      WHEN 'acceptance_reminder_24h'     THEN 'Bitte schließen Sie die Abnahme ab.'
      WHEN 'acceptance_reminder_60h'     THEN 'Letzte Erinnerung — bitte Abnahme abschließen.'
      WHEN 'funding_requested'           THEN 'Bitte hinterlegen Sie die Zahlung in der App.'
      WHEN 'invoice_cancelled'           THEN 'Eine Rechnung wurde storniert.'
      WHEN 'payment_refunded'            THEN 'Eine Zahlung wurde zurückerstattet.'
      WHEN 'payout_handoff_failed'       THEN 'Die Auszahlung konnte nicht ausgelöst werden.'
      WHEN 'payout_failed'               THEN 'Eine Auszahlung ist fehlgeschlagen.'
      WHEN 'transfer_reversed'           THEN 'Eine Buchung wurde zurückgenommen.'
      WHEN 'schedule_rescheduled'        THEN 'Ein Termin wurde verschoben.'
      WHEN 'schedule_cancelled'          THEN 'Ein Termin wurde abgesagt.'
      WHEN 'proposal_accepted'           THEN 'Ein Angebot wurde angenommen.'
      WHEN 'correction_created'          THEN 'Eine Korrektur wurde angefragt.'
      WHEN 'correction_rejected'         THEN 'Eine Korrektur wurde abgelehnt.'
      WHEN 'correction_resolved'         THEN 'Eine Korrektur wurde angenommen.'
      ELSE 'Bitte in der App prüfen.'
    END
$$;

COMMENT ON FUNCTION public.notification_push_copy(text) IS
  'N13.NOTIFY — German title/body strings for APNs alerts. Mirror of the '
  'email template catalogue. Add new types here when extending '
  'notificationConfig.NOTIFICATION_EVENT_CONFIG. Block A: includes '
  'correction_resolved (worker-facing approval push).';
