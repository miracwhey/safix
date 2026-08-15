-- =============================================================================
-- Migration: conversations & messages – deterministic sort timestamps
-- =============================================================================
-- BLOCK 32 FINAL CLOSURE: Closes the remaining repository query discipline
-- gaps in the messaging domain by introducing proper bigint timestamps for
-- deterministic ordering.
--
-- BEFORE:
--   • conversations had no general-purpose sortable timestamp.  reviewed_at
--     and declined_at are conditional lifecycle fields, not creation times.
--   • messages only had created_at_label (a display string), making repository-
--     level ORDER BY impossible.
--
-- AFTER:
--   • conversations.created_at  bigint – epoch ms stamped when the inquiry
--     thread is first created.  Allows ORDER BY created_at DESC in the
--     repository so the most recently opened threads appear first on load.
--   • messages.created_at  bigint – epoch ms stamped when each message is sent.
--     Allows ORDER BY created_at ASC in the repository so messages within a
--     thread are always loaded in chronological order.
--
-- Convention: all timestamp columns in this app store Unix epoch milliseconds
-- as bigint (NOT NULL DEFAULT 0).  Zero is used as a safe sentinel for any
-- pre-existing rows that cannot be back-filled; the repository excludes them
-- from ordering assumptions by loading newest-first / oldest-first as needed.
--
-- All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS guards).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. conversations.created_at
-- ---------------------------------------------------------------------------

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT 0;

-- Index for ORDER BY created_at DESC in SupabaseMessageRepository.initialize()
CREATE INDEX IF NOT EXISTS idx_conversations_created_at
  ON public.conversations (created_at);

-- ---------------------------------------------------------------------------
-- 2. messages.created_at
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS created_at bigint NOT NULL DEFAULT 0;

-- Index for ORDER BY created_at ASC in SupabaseMessageRepository.initialize()
CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON public.messages (created_at);

-- =============================================================================
-- BLOCK 32 FINAL CLOSURE SUMMARY
-- =============================================================================
-- After this migration:
--   • SupabaseMessageRepository.initialize() can use
--       .order('created_at', { ascending: false }).limit(200) on conversations
--       .order('created_at', { ascending: true  }).limit(2000) on messages
--   • New conversations stamped at creation time via addConversation()
--   • New messages stamped at send time via addMessageAndUpdateConversation()
--   • Pre-existing rows retain DEFAULT 0 (safe sentinel – won't break reads)
--
-- NO RLS changes required.  The new columns are internal sort keys only;
-- they carry no ownership information and do not affect access control.
-- =============================================================================
