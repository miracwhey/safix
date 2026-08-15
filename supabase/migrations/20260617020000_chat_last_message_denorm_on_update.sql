-- =============================================================================
-- chat last-message denorm: also re-run on UPDATE (type promotion, soft-delete,
-- redaction), not only on INSERT
-- =============================================================================
--
-- Context: chat_messages had exactly one denorm trigger, chat_messages_after_insert
-- (AFTER INSERT -> fn_chat_update_thread_last_message), which copies a preview
-- into chat_threads.last_message_* and chat_participants.last_visible_message_*.
-- Because it only fires on INSERT it misses two mutation paths:
--
--   (1) Attachment messages. rpc_send_chat_message_with_attachments INSERTs the
--       message as message_type='text', body=NULL. The type is promoted to
--       image/document/voice/video AFTERWARD by chat_attachments_after_insert ->
--       fn_chat_set_message_type_on_attachment, which UPDATEs chat_messages. The
--       INSERT-only denorm never observes that promotion, so last_message_body /
--       last_visible_message_body stay NULL and last_visible_message_type stays
--       'text' -> blank inbox preview for any caption-less photo/doc/voice/video.
--
--   (2) Soft-delete (deleted_at) and redaction (redacted=true) are UPDATEs on
--       chat_messages -> no re-fire -> the denorm keeps the deleted/redacted text
--       (stale preview).
--
-- Fix: add an AFTER UPDATE trigger that recomputes the denorm from the latest
-- VISIBLE message (deleted_at IS NULL AND redacted = false), so a deleted/redacted
-- last message falls back to the prior visible one and a just-promoted attachment
-- refreshes both preview body and type. The INSERT path is left byte-for-byte
-- behaviourally identical (it is the hot path; NEW is always the latest visible
-- message, so a per-row recompute would only add cost). INSERT and UPDATE share
-- one preview helper (fn_chat_message_preview_body), and the UPDATE path delegates
-- to one dedicated recompute helper (fn_chat_recompute_thread_last_message).
--
-- The artifact_card preview branch added 2026-06-16
-- (20260616200000_chat_last_message_preview_artifact_card.sql) is preserved
-- verbatim, now living inside the shared preview helper.
--
-- RECURSION SAFETY: every function here writes ONLY public.chat_threads and
-- public.chat_participants, NEVER public.chat_messages. fn_chat_set_message_type_
-- on_attachment's UPDATE of chat_messages.message_type will now correctly fire
-- this AFTER-UPDATE trigger exactly once (the intended preview refresh); because
-- the recompute touches no chat_messages row it cannot re-enter this trigger and
-- cannot recurse.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS / CREATE TRIGGER.
-- Source of truth = live prod (pg_get_functiondef / pg_get_triggerdef), not the
-- drifted migration files. All columns verified against prod: created_at /
-- last_message_at / last_visible_message_at / deleted_at are bigint epoch_ms;
-- redacted is boolean NOT NULL default false.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Shared preview-body helper (pure). Centralizes the label CASE so the INSERT
--    trigger and the UPDATE recompute can never drift. Returns NULL for a
--    deleted or redacted message; otherwise the German type label (preserving the
--    artifact_card branch) or the raw body for text/system/other.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chat_message_preview_body(
  p_message_type  text,
  p_artifact_type text,
  p_body          text,
  p_deleted_at    bigint,
  p_redacted      boolean
)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_deleted_at IS NOT NULL      THEN NULL
    WHEN p_redacted                    THEN NULL
    WHEN p_message_type = 'image'      THEN '[Bild]'
    WHEN p_message_type = 'document'   THEN '[Dokument]'
    WHEN p_message_type = 'voice'      THEN '[Sprachnachricht]'
    WHEN p_message_type = 'video'      THEN '[Video]'
    WHEN p_message_type = 'mixed'      THEN '[Anhang]'
    WHEN p_message_type = 'artifact_card' THEN
      CASE p_artifact_type
        WHEN 'Project'      THEN '[Projekt]'
        WHEN 'OfferPayment' THEN '[Angebot]'
        WHEN 'FundingStep'  THEN '[Zahlung]'
        WHEN 'ChangeOrder'  THEN '[Nachtrag]'
        ELSE '[Anhang]'
      END
    WHEN p_message_type = 'system'     THEN p_body
    ELSE p_body
  END;
$function$;

-- -----------------------------------------------------------------------------
-- 2. INSERT trigger function (unchanged behaviour). Refactored only to call the
--    shared preview helper. On INSERT deleted_at is NULL and redacted is false,
--    so the helper returns exactly what the inline CASE returned before; the
--    artifact_card branch, both UPDATEs, the updated_at bump, and the per-
--    participant user_blocks suppression are all preserved verbatim.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chat_update_thread_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_preview_body text;
BEGIN
  v_preview_body := public.fn_chat_message_preview_body(
    NEW.message_type, NEW.artifact_type, NEW.body, NEW.deleted_at, NEW.redacted
  );

  UPDATE public.chat_threads
  SET
    last_message_id   = NEW.id,
    last_message_at   = NEW.created_at,
    last_message_body = v_preview_body,
    updated_at        = NEW.created_at
  WHERE id = NEW.thread_id;

  UPDATE public.chat_participants cp
  SET
    last_visible_message_id   = NEW.id,
    last_visible_message_at   = NEW.created_at,
    last_visible_message_body = v_preview_body,
    last_visible_message_type = NEW.message_type
  WHERE cp.thread_id = NEW.thread_id
    AND cp.left_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.user_blocks ub
      WHERE ub.blocker_id = cp.user_id
        AND ub.blocked_id = NEW.sender_user_id
    );

  RETURN NEW;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Recompute helper (UPDATE path). Rebuilds the denorm from the current latest
--    VISIBLE message. Writes ONLY chat_threads + chat_participants -> cannot
--    recurse into the chat_messages triggers.
--
--    * chat_threads: latest visible message in the thread (no per-user block
--      filter -- thread-level pointer). All NULL if the thread has no visible
--      message left (every message deleted/redacted).
--    * chat_participants: per active participant, the latest visible message from
--      a sender they have NOT blocked -- mirroring the INSERT path's user_blocks
--      suppression so a blocked sender's message never leaks into a blocker's
--      preview. The row-subquery assignment sets all four columns to NULL when no
--      such message exists.
--
--    updated_at is intentionally NOT touched here: on delete/redact the fallback
--    message is older, and lowering updated_at would reorder the inbox backwards.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chat_recompute_thread_last_message(p_thread_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id            uuid;
  v_at            bigint;
  v_type          text;
  v_artifact_type text;
  v_body          text;
BEGIN
  -- Serialize concurrent recomputes on the same thread so a later delete/redact
  -- re-reads the committed visible set (avoids a stale pointer to a now-hidden
  -- message under READ COMMITTED).
  PERFORM 1 FROM public.chat_threads WHERE id = p_thread_id FOR UPDATE;

  -- thread-level latest VISIBLE message
  SELECT m.id, m.created_at, m.message_type, m.artifact_type, m.body
    INTO v_id, v_at, v_type, v_artifact_type, v_body
  FROM public.chat_messages m
  WHERE m.thread_id = p_thread_id
    AND m.deleted_at IS NULL
    AND m.redacted = false
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1;

  UPDATE public.chat_threads t
  SET
    last_message_id   = v_id,
    last_message_at   = v_at,
    last_message_body = public.fn_chat_message_preview_body(v_type, v_artifact_type, v_body, NULL, false)
  WHERE t.id = p_thread_id;

  -- per-participant latest VISIBLE message from a non-blocked sender
  UPDATE public.chat_participants cp
  SET (
        last_visible_message_id,
        last_visible_message_at,
        last_visible_message_body,
        last_visible_message_type
      ) = (
        SELECT
          m.id,
          m.created_at,
          public.fn_chat_message_preview_body(m.message_type, m.artifact_type, m.body, NULL, false),
          m.message_type
        FROM public.chat_messages m
        WHERE m.thread_id = cp.thread_id
          AND m.deleted_at IS NULL
          AND m.redacted = false
          AND NOT EXISTS (
            SELECT 1 FROM public.user_blocks ub
            WHERE ub.blocker_id = cp.user_id
              AND ub.blocked_id = m.sender_user_id
          )
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      )
  WHERE cp.thread_id = p_thread_id
    AND cp.left_at IS NULL;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. AFTER UPDATE trigger function. Recomputes only when the updated message is
--    (or just became) preview-relevant, to avoid spurious no-op writes (and the
--    realtime events they would emit -- chat_threads + chat_participants are both
--    in the supabase_realtime publication). A message is relevant when it is the
--    thread's current last_message_id, OR any participant's current
--    last_visible_message_id (covers the blocked-sender case where a participant's
--    pointer differs from the thread pointer), OR it is now the latest visible
--    message in the thread (covers an un-delete / un-redact making it surface).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_chat_after_update_thread_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_relevant boolean;
BEGIN
  SELECT
    (NEW.id = t.last_message_id)
    OR EXISTS (
      SELECT 1 FROM public.chat_participants p
      WHERE p.thread_id = NEW.thread_id
        AND p.last_visible_message_id = NEW.id
    )
    OR (
      NEW.deleted_at IS NULL
      AND NEW.redacted = false
      AND NOT EXISTS (
        SELECT 1 FROM public.chat_messages m
        WHERE m.thread_id = NEW.thread_id
          AND m.deleted_at IS NULL
          AND m.redacted = false
          AND (m.created_at, m.id) > (NEW.created_at, NEW.id)
      )
    )
  INTO v_relevant
  FROM public.chat_threads t
  WHERE t.id = NEW.thread_id;

  IF COALESCE(v_relevant, false) THEN
    PERFORM public.fn_chat_recompute_thread_last_message(NEW.thread_id);
  END IF;

  RETURN NULL; -- AFTER trigger: return value ignored
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. The AFTER UPDATE trigger itself. WHEN restricts firing to the four columns
--    that can change the preview, so the hot read-cursor / status / delivered_at
--    updates never enter the function.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS chat_messages_after_update_last_message ON public.chat_messages;

CREATE TRIGGER chat_messages_after_update_last_message
  AFTER UPDATE ON public.chat_messages
  FOR EACH ROW
  WHEN (
    OLD.message_type IS DISTINCT FROM NEW.message_type
    OR OLD.body       IS DISTINCT FROM NEW.body
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.redacted   IS DISTINCT FROM NEW.redacted
  )
  EXECUTE FUNCTION public.fn_chat_after_update_thread_last_message();

-- -----------------------------------------------------------------------------
-- 6. Lock down the new functions. This DB has no default-privilege revoke, so a
--    fresh CREATE grants PUBLIC EXECUTE. fn_chat_recompute_thread_last_message is
--    PostgREST-exposed (void, single uuid arg) and SECURITY DEFINER, so without
--    this any anon/authenticated caller could POST /rpc and rewrite
--    chat_threads/chat_participants for arbitrary threads (RLS bypass + realtime
--    spam). Mirror the sibling chat push-dispatch migration: strip PUBLIC/anon/
--    authenticated, grant service_role. (The pre-existing
--    fn_chat_update_thread_last_message keeps its prod ACL — CREATE OR REPLACE
--    does not reset privileges.)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_chat_message_preview_body(text, text, text, bigint, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_chat_recompute_thread_last_message(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_chat_after_update_thread_last_message() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chat_recompute_thread_last_message(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. PostgREST schema cache reload.
-- -----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
