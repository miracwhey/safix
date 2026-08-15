-- Chat — message deletion (Block 3 of the chat-artifact redesign, TEIL B).
--
-- Two delete modes, mirroring iOS-style unsend:
--   • 'all'  ("Für alle löschen") — sender-only, within a 15-minute window.
--            The row is *redacted* (body cleared, redacted=true) but NOT
--            soft-deleted (deleted_at stays NULL) so the read paths keep
--            returning it and the client renders a tombstone. Attachments are
--            soft-deleted so their blobs drop from view + get cleaned up.
--   • 'self' ("Für mich löschen") — any participant hides a message for
--            themselves only, via a per-user chat_message_hidden row. The
--            counterpart is untouched, no tombstone.
--
-- Why redacted-only (no deleted_at) for 'all': the read paths filter
-- `.is('deleted_at', null)` and the realtime UPDATE handler keeps redacted
-- rows — exactly the visibility a tombstone needs. The thread-preview denorm
-- (fn_chat_after_update_thread_last_message) already treats redacted=true as
-- invisible and recomputes the last *visible* message, and the push dispatch
-- trigger is AFTER INSERT only, so a redact never re-pushes. The columns
-- (redacted / redacted_at / redacted_reason) already exist (moderation path).

-- ── Per-user hide table ("Für mich") ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_message_hidden (
  user_id    uuid   NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  message_id uuid   NOT NULL REFERENCES public.chat_messages(id)  ON DELETE CASCADE,
  hidden_at  bigint NOT NULL DEFAULT public.epoch_ms(),
  PRIMARY KEY (user_id, message_id)
);

-- FK-cascade support on the message side (PK is user_id-leading).
CREATE INDEX IF NOT EXISTS chat_message_hidden_message_id_idx
  ON public.chat_message_hidden (message_id);

ALTER TABLE public.chat_message_hidden ENABLE ROW LEVEL SECURITY;

-- Self-scoped read; writes go exclusively through the SECDEF RPC below
-- (no INSERT/UPDATE/DELETE policy → direct client writes are default-denied).
DROP POLICY IF EXISTS chat_message_hidden_select_own ON public.chat_message_hidden;
CREATE POLICY chat_message_hidden_select_own
  ON public.chat_message_hidden
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Revoke writes from authenticated too: Supabase's stock default privileges
-- GRANT ALL on new public tables directly to the `authenticated` role (not via
-- PUBLIC), so revoking only PUBLIC+anon would leave latent INSERT/UPDATE/DELETE.
-- Writes go exclusively through the SECDEF RPC; reads are RLS-gated SELECT.
REVOKE ALL ON public.chat_message_hidden FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.chat_message_hidden TO authenticated;

-- ── Delete RPC ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_delete_chat_message(
  p_message_id uuid,
  p_mode       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid        uuid := (SELECT auth.uid());
  v_thread_id  uuid;
  v_sender     uuid;
  v_created_at bigint;
  v_window_ms  constant bigint := 15 * 60 * 1000;  -- 15 minutes
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF p_mode NOT IN ('all', 'self') THEN
    RAISE EXCEPTION 'invalid_mode: %', p_mode USING ERRCODE = '23514';
  END IF;

  SELECT thread_id, sender_user_id, created_at
    INTO v_thread_id, v_sender, v_created_at
    FROM public.chat_messages
    WHERE id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'message_not_found' USING ERRCODE = '23514';
  END IF;

  -- Caller must be an active participant of the message's thread (SECDEF
  -- bypasses RLS, so the membership gate is explicit).
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_participants cp
    WHERE cp.thread_id = v_thread_id
      AND cp.user_id   = v_uid
      AND cp.left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not_a_participant' USING ERRCODE = '42501';
  END IF;

  -- ── "Für mich" — per-user hide, idempotent ──
  IF p_mode = 'self' THEN
    INSERT INTO public.chat_message_hidden (user_id, message_id)
      VALUES (v_uid, p_message_id)
      ON CONFLICT (user_id, message_id) DO NOTHING;
    RETURN jsonb_build_object('ok', true, 'mode', 'self', 'message_id', p_message_id);
  END IF;

  -- ── "Für alle" — sender-only, 15-min window, redact in place ──
  IF v_sender <> v_uid THEN
    RAISE EXCEPTION 'not_sender' USING ERRCODE = '42501';
  END IF;

  IF v_created_at < public.epoch_ms() - v_window_ms THEN
    -- Business reject (window passed): classifies as non-retryable, no
    -- send-queue retry loop. Client surfaces "Zeitfenster abgelaufen".
    RAISE EXCEPTION 'unsend_window_expired' USING ERRCODE = '23514';
  END IF;

  UPDATE public.chat_messages
    SET redacted        = true,
        redacted_at     = public.epoch_ms(),
        redacted_reason = 'sender_unsend',
        body            = NULL
    WHERE id = p_message_id;

  -- Drop attachments from view + flag their blobs for cleanup. Mirrors the
  -- read paths' `.is('deleted_at', null)` attachment filter + the realtime
  -- attachment-delete handler.
  UPDATE public.chat_attachments
    SET deleted_at = public.epoch_ms()
    WHERE message_id = p_message_id
      AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'mode', 'all', 'message_id', p_message_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_delete_chat_message(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_delete_chat_message(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
