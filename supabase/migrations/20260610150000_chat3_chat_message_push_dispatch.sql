-- ============================================================================
-- CHAT-3 · Push-Dispatch für Chat-Nachrichten (Hannover-Kernloop)
-- ============================================================================
-- Prod-verifiziert 2026-06-10: chat_messages hat NUR chat_messages_after_insert
-- (Thread-Preview), KEINEN Push-Trigger. Muster-Spiegel der LIVE-Definition
-- public.notification_signals_dispatch_push (pg_get_functiondef-Dump):
-- Vault-Secrets notify_push.url / notify_push.shared_secret, pg_net http_post,
-- non-throwing (alle Fehler via RAISE NOTICE verschluckt — ein werfender
-- AFTER-INSERT-Trigger würde JEDEN Chat-Send killen).
--
-- Scope v1: channel_type = 'customer' (Customer↔Handwerker-Threads).
-- office/team-Threads rendern auf /craftsman/nachrichten/:id (anderes Surface)
-- und bekommen Push in einem Folge-Block mit eigenen Routen.
--
-- Daten-Payload ist PRE-ENRICHED (route/fallbackRoute/actionVersion), weil die
-- Edge-Function enrichPushDataWithRoute nur jobId-verankerte Types anreichert
-- und unbekannte Types unverändert durchreicht (verifiziert routeMap.ts).

CREATE OR REPLACE FUNCTION public.chat_messages_dispatch_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_channel     text;
  v_url         text;
  v_secret      text;
  v_sender_name text;
  v_title       text;
  v_body        text;
  v_pushes      jsonb;
  v_now         bigint;
BEGIN
  -- Nur echte, sichtbare User-Nachrichten pushen. System-Rows sind
  -- app-generierte Notizen (Erstklass-Events pushen bereits über
  -- notification_signals); gelöschte/redactete Rows dürfen nie leaken.
  IF NEW.message_type = 'system' OR NEW.deleted_at IS NOT NULL OR NEW.redacted THEN
    RETURN NEW;
  END IF;

  SELECT ct.channel_type INTO v_channel
  FROM public.chat_threads ct WHERE ct.id = NEW.thread_id;
  IF v_channel IS DISTINCT FROM 'customer' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'notify_push.url';
    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'notify_push.shared_secret';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'chat_push: vault unavailable — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'chat_push: vault entries notify_push.url or notify_push.shared_secret missing — skipping';
    RETURN NEW;
  END IF;

  v_now := public.epoch_ms();

  SELECT p.display_name INTO v_sender_name
  FROM public.profiles p WHERE p.id = NEW.sender_user_id;

  -- Generische Copy ohne Nachrichteninhalt (PII-arm, Muster notification_push_copy).
  v_title := 'Neue Nachricht';
  v_body  := CASE
    WHEN v_sender_name IS NOT NULL AND length(btrim(v_sender_name)) > 0
      THEN btrim(v_sender_name) || ' hat Ihnen geschrieben.'
    ELSE 'Sie haben eine neue Nachricht erhalten.'
  END;

  -- Empfänger = alle aktiven Thread-Teilnehmer AUSSER dem Sender:
  --   · left_at IS NULL (noch im Thread)
  --   · nicht gemutet (muted_until in ms, Vergleich gegen epoch_ms())
  --   · Empfänger hat den Sender nicht geblockt (Spiegel des user_blocks-
  --     Filters aus fn_chat_update_thread_last_message)
  -- Route per Teilnehmer-Rolle: customer → /messages/{threadId},
  -- Handwerker-Seite → /craftsman/messages/{threadId}. fallbackRoute = Listen-Tab.
  -- actionVersion = 1 (= PUSH_ROUTE_SCHEMA_VERSION — bei Schema-Bump mitziehen!).
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'token', t.token,
        'title', v_title,
        'body',  v_body,
        'data',  jsonb_build_object(
          'type',          'chat_message',
          'threadId',      NEW.thread_id,
          'messageId',     NEW.id,
          'route',         CASE WHEN cp.role = 'customer'
                             THEN '/messages/'           || NEW.thread_id
                             ELSE '/craftsman/messages/' || NEW.thread_id END,
          'fallbackRoute', CASE WHEN cp.role = 'customer'
                             THEN '/messages'
                             ELSE '/craftsman/messages' END,
          'actionVersion', 1
        )
      )
    )
  INTO v_pushes
  FROM public.chat_participants cp
  JOIN public.notification_device_tokens t
    ON t.user_id = cp.user_id::text
  WHERE cp.thread_id = NEW.thread_id
    AND cp.user_id <> NEW.sender_user_id
    AND cp.left_at IS NULL
    AND (cp.muted_until IS NULL OR cp.muted_until <= v_now)
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE ub.blocker_id = cp.user_id
        AND ub.blocked_id = NEW.sender_user_id
    );

  IF v_pushes IS NULL THEN
    RETURN NEW;
  END IF;

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
    RAISE NOTICE 'chat_push: pg_net.http_post failed (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Absoluter Backstop: ein werfender AFTER-INSERT-Trigger würde JEDEN
  -- Chat-Send fehlschlagen lassen. Niemals propagieren.
  RAISE NOTICE 'chat_push: dispatch failed — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chat_messages_dispatch_push() IS
  'CHAT-3: AFTER-INSERT Push-Dispatch für chat_messages (channel_type=customer) via pg_net → notify-push Edge Function. Non-throwing by design — Fehler dürfen den Chat-Send nie blockieren.';

-- ACL-Hygiene — Spiegel der Prod-ACL von notification_signals_dispatch_push
-- ({postgres=X,service_role=X}): Default-EXECUTE leakt sonst an PUBLIC/anon/authenticated.
REVOKE ALL ON FUNCTION public.chat_messages_dispatch_push() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_messages_dispatch_push() TO service_role;

DROP TRIGGER IF EXISTS chat_messages_dispatch_push_tg ON public.chat_messages;
CREATE TRIGGER chat_messages_dispatch_push_tg
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.chat_messages_dispatch_push();

-- Defensiv: PostgREST-Schema-Cache neu laden (stale-Cache-Muster).
NOTIFY pgrst, 'reload schema';
