-- =============================================================================
-- chat last-message preview: handle artifact_card messages
-- =============================================================================
--
-- Context: the chat project-attach feature (#995) sends artifact_card chat
-- messages with body = NULL. fn_chat_update_thread_last_message denormalizes a
-- preview string into chat_threads.last_message_body and
-- chat_participants.last_visible_message_body via a CASE that handles
-- image/document/voice/video/system but falls through to `ELSE NEW.body` for
-- artifact_card. With body NULL the preview becomes NULL, so the thread-list
-- row renders an empty last-message line whenever a project card is the latest
-- message.
--
-- Fix: add an artifact_card branch that emits a German type label, mirroring
-- ChatArtifactCardCompact's TYPE_LABEL (Project→Projekt, OfferPayment→Angebot,
-- FundingStep→Zahlung, ChangeOrder→Nachtrag), with a generic '[Anhang]'
-- fallback for any future artifact_type. The OfferPayment/FundingStep/
-- ChangeOrder labels are forward-compatible — those producers do not exist yet.
--
-- Everything else in the function is reproduced byte-for-byte from the live prod
-- definition (verified via pg_get_functiondef, NOT the drifted migration files):
-- SECURITY DEFINER, search_path '', both UPDATEs, and the user_blocks
-- per-participant suppression are unchanged.
--
-- Idempotent: CREATE OR REPLACE. Rollback = re-create without the artifact_card
-- branch (preview reverts to NULL for artifact cards).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_chat_update_thread_last_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_preview_body text;
BEGIN
  v_preview_body := CASE
    WHEN NEW.deleted_at IS NOT NULL    THEN NULL
    WHEN NEW.message_type = 'image'    THEN '[Bild]'
    WHEN NEW.message_type = 'document' THEN '[Dokument]'
    WHEN NEW.message_type = 'voice'    THEN '[Sprachnachricht]'
    WHEN NEW.message_type = 'video'    THEN '[Video]'
    WHEN NEW.message_type = 'artifact_card' THEN
      CASE NEW.artifact_type
        WHEN 'Project'      THEN '[Projekt]'
        WHEN 'OfferPayment' THEN '[Angebot]'
        WHEN 'FundingStep'  THEN '[Zahlung]'
        WHEN 'ChangeOrder'  THEN '[Nachtrag]'
        ELSE '[Anhang]'
      END
    WHEN NEW.message_type = 'system'   THEN NEW.body
    ELSE NEW.body
  END;

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
