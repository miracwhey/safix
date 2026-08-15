-- ─────────────────────────────────────────────────────────────────────────
-- Block N13.NOTIFY-Server-Push — push fan-out trigger
--
-- Wires `notification_signals` inserts into the `notify-push` Edge Function
-- via pg_net. Behaviour:
--   • Only signals with priority IN ('action','alert') trigger pushes —
--     informational pings stay inbox-only to avoid notification fatigue.
--   • Resolves the recipient user id from (jobs, recipient_role):
--       'customer'  → jobs.customer_user_id::text
--       'craftsman' → jobs.craftsman_user_id   (already text)
--   • Looks up active device tokens from notification_device_tokens.
--   • If no tokens, the trigger silently no-ops (the inbox row still exists).
--   • The HTTP call is async (pg_net) — failures never roll back the
--     originating insert.
--
-- ── Dependencies ────────────────────────────────────────────────────────
--   • Extension `pg_net` (already installed: v0.19.5).
--   • Extension `supabase_vault` (already installed: v0.3.1).
--   • Vault secrets:
--       notify_push.url               — full URL of the Edge Function
--       notify_push.shared_secret     — value of x-fixup-trigger-secret
--   • The Edge Function `notify-push` deployed with verify_jwt=false.
--
-- The vault rows are seeded by a follow-up admin step (out of band), not
-- by this migration — secrets must never live in the SQL history.
-- ─────────────────────────────────────────────────────────────────────────

-- Title/body mapping per signal.type. Keep in sync with the email template
-- catalogue in src/lib/notifications/delivery/templates.ts (German copy).
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
      ELSE 'Bitte in der App prüfen.'
    END
$$;

COMMENT ON FUNCTION public.notification_push_copy(text) IS
  'N13.NOTIFY — German title/body strings for APNs alerts. Mirror of the '
  'email template catalogue. Add new types here when extending '
  'notificationConfig.NOTIFICATION_EVENT_CONFIG.';

-- ─────────────────────────────────────────────────────────────────────────
-- Resolves a recipient user_id from (job_id, recipient_role).
-- Returns NULL when the role does not map to a party of the job.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notification_push_recipient(
  p_job_id        uuid,
  p_recipient_role text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id text;
BEGIN
  IF p_job_id IS NULL OR p_recipient_role IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_recipient_role = 'customer' THEN
    SELECT customer_user_id::text INTO v_user_id
    FROM public.jobs WHERE id = p_job_id;
  ELSIF p_recipient_role = 'craftsman' THEN
    SELECT craftsman_user_id INTO v_user_id
    FROM public.jobs WHERE id = p_job_id;
  ELSE
    RETURN NULL;
  END IF;
  RETURN v_user_id;
END;
$$;

COMMENT ON FUNCTION public.notification_push_recipient(uuid, text) IS
  'N13.NOTIFY — resolves a notification_signals.recipient_role + job_id pair '
  'to the receiving user_id. SECURITY DEFINER because the trigger runs as '
  'the inserting user, who may not have read access to the counterparty.';

-- ─────────────────────────────────────────────────────────────────────────
-- AFTER INSERT trigger — fire push.
--
-- Behaviour:
--   • Skips silently for priority IN ('low','info').
--   • Resolves recipient user_id; NULL → return.
--   • Looks up active tokens; empty → return.
--   • Reads URL + shared secret from vault; missing → log NOTICE + return.
--   • Builds pushes payload + pg_net.http_post (fire-and-forget).
--
-- All errors caught — the trigger never rolls back the originating insert.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notification_signals_dispatch_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_recipient text;
  v_url       text;
  v_secret    text;
  v_title     text;
  v_body      text;
  v_pushes    jsonb;
  v_token_count int;
BEGIN
  -- 1. Skip low-priority signals.
  IF NEW.priority NOT IN ('action', 'alert') THEN
    RETURN NEW;
  END IF;

  -- 2. Resolve recipient user_id.
  v_recipient := public.notification_push_recipient(NEW.job_id, NEW.recipient_role);
  IF v_recipient IS NULL THEN
    RETURN NEW;
  END IF;

  -- 3. Vault lookup. Missing secrets → no-op (the trigger must not break
  --    notification_signals inserts during initial bring-up before the
  --    secrets have been seeded).
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'notify_push.url';
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'notify_push.shared_secret';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'notify_push: vault unavailable — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'notify_push: vault entries notify_push.url or notify_push.shared_secret missing — skipping';
    RETURN NEW;
  END IF;

  -- 4. Build pushes payload.
  SELECT title, body INTO v_title, v_body FROM public.notification_push_copy(NEW.type);

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'token', t.token,
        'title', v_title,
        'body',  v_body,
        'data',  jsonb_build_object(
          'jobId', NEW.job_id,
          'type',  NEW.type,
          'signalId', NEW.id,
          'priority', NEW.priority
        )
      )
    ),
    COUNT(*)
  INTO v_pushes, v_token_count
  FROM public.notification_device_tokens t
  WHERE t.user_id = v_recipient;

  IF v_token_count = 0 OR v_pushes IS NULL THEN
    RETURN NEW;
  END IF;

  -- 5. Fire async HTTP. pg_net returns a request_id immediately; we don't
  --    await the response. Failures are logged in net._http_response.
  BEGIN
    PERFORM net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body    := jsonb_build_object('pushes', v_pushes),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'notify_push: pg_net.http_post failed (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notification_signals_dispatch_push() IS
  'N13.NOTIFY — fan-out trigger. AFTER INSERT on notification_signals, '
  'resolves the recipient, reads tokens, and posts to the notify-push '
  'Edge Function via pg_net. Fire-and-forget; never blocks the insert.';

DROP TRIGGER IF EXISTS notification_signals_dispatch_push_tg
  ON public.notification_signals;
CREATE TRIGGER notification_signals_dispatch_push_tg
  AFTER INSERT ON public.notification_signals
  FOR EACH ROW
  EXECUTE FUNCTION public.notification_signals_dispatch_push();

-- Index supporting the recipient → token lookup. PK already covers
-- (user_id, token) in this order, but a plain user_id index speeds up
-- COUNT-style scans by skipping the second key column. Skip if it
-- already exists.
CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_user_id
  ON public.notification_device_tokens (user_id);
