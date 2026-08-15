-- @-Handle-System · Block H3.5 — Push-Dispatch für direct-Channel
--
-- Einzige Änderung ggü. der Live-Funktion: der Channel-Gate lässt jetzt auch
-- 'direct' durch (vorher NUR 'customer'). Recipient-Resolution, Block-/Mute-
-- Filter, Route-CASE (role='customer'→/messages, sonst /craftsman/messages)
-- und Copy sind channel-agnostisch — die direct-RPC seedet Teilnehmer-Rollen
-- 'customer'/'craftsman', daher greift die bestehende Route-Logik unverändert.
--
-- Vollständiger Backstop (EXCEPTION WHEN OTHERS → RETURN NEW) bleibt: ein
-- werfender AFTER-INSERT-Trigger würde sonst jeden Chat-Send fehlschlagen lassen.
-- Zustellung selbst ist dormant bis notification_device_tokens gefüllt sind
-- (Push Bug #1 / AppDelegate-Fix) — Device-Smoke verifiziert end-to-end.

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
  IF NEW.message_type = 'system' OR NEW.deleted_at IS NOT NULL OR NEW.redacted THEN
    RETURN NEW;
  END IF;

  SELECT ct.channel_type INTO v_channel
  FROM public.chat_threads ct WHERE ct.id = NEW.thread_id;
  -- Push für customer- UND direct-Channel. Alles andere (office/team/assignment/
  -- dispute) sowie NULL bleibt Inbox-only.
  IF v_channel IS NULL OR v_channel NOT IN ('customer', 'direct') THEN
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

  v_title := 'Neue Nachricht';
  v_body  := CASE
    WHEN v_sender_name IS NOT NULL AND length(btrim(v_sender_name)) > 0
      THEN btrim(v_sender_name) || ' hat Ihnen geschrieben.'
    ELSE 'Sie haben eine neue Nachricht erhalten.'
  END;

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
  RAISE NOTICE 'chat_push: dispatch failed — skipping (sqlstate=%, msg=%)', SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';
