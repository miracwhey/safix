-- ===========================================================================
-- A.2 — notification_signals inline-action meta columns
-- ===========================================================================
-- Block A (PR #868) added the Defense-in-Depth gate in notify-push v4:
-- `aps.category` is only set when hasInlineActionPayloadFields() returns
-- true — i.e. all six fields are present in `data`. This means Lockscreen
-- action buttons are currently blocked for every notification because the
-- trigger emits only {jobId, type, signalId, priority}.
--
-- A.2 adds the six missing columns to notification_signals (all nullable),
-- updates the trigger passthrough, and lets the app populate them for
-- `correction_created` (the only type with a registered iOS category today).
--
-- Column semantics:
--   entity_id       — domain entity UUID the action targets (e.g. correction.id)
--   entity_type     — domain type string ('correction', 'dispute', …)
--   action_type     — logical action class ('decision', 'response', …)
--   role_target     — recipient role ('craftsman', 'customer', …)
--   expected_status — entity status at action time ('open', 'pending', …)
--   expires_at      — Unix timestamp (ms) after which the action is stale;
--                     stored as bigint so the trigger passes through unchanged
--                     (no epoch-extraction step needed — avoids ms/s mismatch
--                     with the client-side dispatcher Date.now() check)
-- ===========================================================================

alter table public.notification_signals
  add column if not exists entity_id       text,
  add column if not exists entity_type     text,
  add column if not exists action_type     text,
  add column if not exists role_target     text,
  add column if not exists expected_status text,
  add column if not exists expires_at      bigint;

comment on column public.notification_signals.entity_id       is 'A.2 — domain entity UUID targeted by an inline push action (correction id, dispute id, …). NULL = no action button.';
comment on column public.notification_signals.entity_type     is 'A.2 — domain type of entity_id (e.g. ''correction'').';
comment on column public.notification_signals.action_type     is 'A.2 — logical class of the inline action (e.g. ''decision'').';
comment on column public.notification_signals.role_target     is 'A.2 — expected recipient role at action execution time.';
comment on column public.notification_signals.expected_status is 'A.2 — expected entity status; dispatcher drops if stale.';
comment on column public.notification_signals.expires_at      is 'A.2 — Unix ms timestamp after which the lockscreen buttons should not be shown. Client-side dispatcher enforces expiresAt > Date.now().';

-- ===========================================================================
-- Update the push-dispatch trigger to pass the new fields through.
-- Existing rows have NULL values → hasInlineActionPayloadFields() stays false
-- → aps.category is not set → no behaviour change for historical signals.
-- ===========================================================================

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

  -- 3. Vault lookup.
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
  --    A.2: inline-action fields are passed through from the new columns.
  --    NULL values are included as JSON null — Edge-Fn gate (hasInlineActionPayloadFields)
  --    requires typeof === 'string', so null columns = no aps.category rendered.
  SELECT title, body INTO v_title, v_body FROM public.notification_push_copy(NEW.type);

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'token', t.token,
        'title', v_title,
        'body',  v_body,
        'data',  jsonb_build_object(
          'jobId',          NEW.job_id,
          'type',           NEW.type,
          'signalId',       NEW.id,
          'priority',       NEW.priority,
          'entityId',       NEW.entity_id,
          'entityType',     NEW.entity_type,
          'actionType',     NEW.action_type,
          'roleTarget',     NEW.role_target,
          'expectedStatus', NEW.expected_status,
          'expiresAt',      NEW.expires_at
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

  -- 5. Fire async HTTP.
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

-- Rollback reference (manual):
--   alter table public.notification_signals
--     drop column if exists entity_id,
--     drop column if exists entity_type,
--     drop column if exists action_type,
--     drop column if exists role_target,
--     drop column if exists expected_status,
--     drop column if exists expires_at;
--   (then restore the previous trigger function from 20260503000003)
