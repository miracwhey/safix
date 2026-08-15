-- Block D Slice 2 M3 Hotfix Rollback — restore single-write trigger,
-- drop per-participant denorm columns.
--
-- This rollback is destructive — denormalized data is lost. Re-running the
-- forward migration restores them via backfill.

-- Restore original chat_threads-only trigger body
CREATE OR REPLACE FUNCTION public.fn_chat_update_thread_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.chat_threads
  SET
    last_message_id   = NEW.id,
    last_message_at   = NEW.created_at,
    last_message_body = CASE
                          WHEN NEW.deleted_at IS NOT NULL THEN NULL
                          WHEN NEW.message_type = 'image' THEN '[Bild]'
                          WHEN NEW.message_type = 'document' THEN '[Dokument]'
                          WHEN NEW.message_type = 'voice' THEN '[Sprachnachricht]'
                          WHEN NEW.message_type = 'video' THEN '[Video]'
                          WHEN NEW.message_type = 'system' THEN NEW.body
                          ELSE NEW.body
                        END,
    updated_at        = NEW.created_at
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_update_thread_last_message() FROM PUBLIC, anon, authenticated;

DROP INDEX IF EXISTS public.chat_participants_user_visible_at_idx;

ALTER TABLE public.chat_participants
  DROP COLUMN IF EXISTS last_visible_message_type,
  DROP COLUMN IF EXISTS last_visible_message_body,
  DROP COLUMN IF EXISTS last_visible_message_at,
  DROP COLUMN IF EXISTS last_visible_message_id;
