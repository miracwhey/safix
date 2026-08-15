-- Block D Slice 2 M3 Hotfix — Per-Participant Last-Visible-Message Denorm
--
-- Background:
--   M3 added silent-drop via RLS on chat_messages, but chat_threads.last_message_*
--   keeps advancing globally (SECURITY DEFINER trigger), causing leaks in:
--     - Inbox preview (blocker sees text from blocked sender)
--     - Thread sort-order (blocked-sender bumps thread to top)
--     - Unread badge (last_message_at > last_read_at)
--   See ~/.claude/plans/chat-architecture-block-d-slice-2-m3-silent-block-drop.md
--   risk-flag follow-up and PR #905 review finding.
--
-- Strategy (Option B — per-participant denorm):
--   Each chat_participants row carries its own last_visible_message_*.
--   Trigger fans out to all participants of the thread, skipping those who
--   have blocked the sender. chat_threads.last_message_* is kept (server
--   truth, may be used by other tooling) but the client no longer reads it
--   for preview / sort / unread.

-- =============================================================================
-- 1) Add denormalized columns to chat_participants
-- =============================================================================

ALTER TABLE public.chat_participants
  ADD COLUMN IF NOT EXISTS last_visible_message_id   uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_visible_message_at   bigint,
  ADD COLUMN IF NOT EXISTS last_visible_message_body text,
  ADD COLUMN IF NOT EXISTS last_visible_message_type text;

COMMENT ON COLUMN public.chat_participants.last_visible_message_at IS
  'Per-participant denormalized timestamp of the most recent message visible to this user (after applying user_blocks filter). Used for thread-list preview, sort, and unread count. See M3 Hotfix.';

-- Sort index for thread-list ORDER BY (per user_id, by visible-at DESC)
CREATE INDEX IF NOT EXISTS chat_participants_user_visible_at_idx
  ON public.chat_participants (user_id, last_visible_message_at DESC NULLS LAST)
  WHERE left_at IS NULL;

-- =============================================================================
-- 2) Backfill: for each existing (thread_id, user_id), pick most-recent message
--    NOT sent by a blocked user
-- =============================================================================

UPDATE public.chat_participants cp
SET
  last_visible_message_id   = lvm.id,
  last_visible_message_at   = lvm.created_at,
  last_visible_message_body = CASE
    WHEN lvm.deleted_at IS NOT NULL THEN NULL
    WHEN lvm.message_type = 'image'    THEN '[Bild]'
    WHEN lvm.message_type = 'document' THEN '[Dokument]'
    WHEN lvm.message_type = 'voice'    THEN '[Sprachnachricht]'
    WHEN lvm.message_type = 'video'    THEN '[Video]'
    WHEN lvm.message_type = 'system'   THEN lvm.body
    ELSE lvm.body
  END,
  last_visible_message_type = lvm.message_type
FROM (
  SELECT DISTINCT ON (cp_inner.thread_id, cp_inner.user_id)
    cp_inner.thread_id,
    cp_inner.user_id,
    cm.id,
    cm.body,
    cm.message_type,
    cm.created_at,
    cm.deleted_at
  FROM public.chat_participants cp_inner
  JOIN public.chat_messages cm ON cm.thread_id = cp_inner.thread_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE ub.blocker_id = cp_inner.user_id
      AND ub.blocked_id = cm.sender_user_id
  )
  ORDER BY cp_inner.thread_id, cp_inner.user_id, cm.created_at DESC
) lvm
WHERE cp.thread_id = lvm.thread_id
  AND cp.user_id   = lvm.user_id;

-- =============================================================================
-- 3) Replace trigger fn — extend with per-participant fan-out
--    KEEP chat_threads.last_message_* write (server truth, other tools may use)
--    ADD set-based UPDATE on chat_participants filtered by user_blocks
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_chat_update_thread_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_preview_body text;
BEGIN
  -- Compute the preview body once (used for both chat_threads and chat_participants).
  v_preview_body := CASE
    WHEN NEW.deleted_at IS NOT NULL    THEN NULL
    WHEN NEW.message_type = 'image'    THEN '[Bild]'
    WHEN NEW.message_type = 'document' THEN '[Dokument]'
    WHEN NEW.message_type = 'voice'    THEN '[Sprachnachricht]'
    WHEN NEW.message_type = 'video'    THEN '[Video]'
    WHEN NEW.message_type = 'system'   THEN NEW.body
    ELSE NEW.body
  END;

  -- 1) chat_threads global truth (server-side, may be used by other tooling)
  UPDATE public.chat_threads
  SET
    last_message_id   = NEW.id,
    last_message_at   = NEW.created_at,
    last_message_body = v_preview_body,
    updated_at        = NEW.created_at
  WHERE id = NEW.thread_id;

  -- 2) chat_participants per-participant fan-out — skip blockers
  --    Set-based UPDATE, point-lookups via blocks_unique_pair index.
  --    A participant who has blocked NEW.sender_user_id keeps their previous
  --    last_visible_* values (no bump, no unread increment).
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
$$;

REVOKE EXECUTE ON FUNCTION public.fn_chat_update_thread_last_message() FROM PUBLIC, anon, authenticated;

-- Trigger itself is unchanged — fn signature stays the same, only body extended.
-- chat_messages AFTER INSERT trigger continues to call this fn.
