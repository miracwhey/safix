-- =============================================================================
-- Block D Slice 1 — chat_thread_migration_status Realtime
-- =============================================================================
-- Adds chat_thread_migration_status to the supabase_realtime publication so
-- the SupabaseChatRepository can react to status transitions
-- (not_migrated → migration_complete) without waiting for the next
-- loadForUser. Required for P1-2 fix from the post-foundation audit.
--
-- Also bumps REPLICA IDENTITY to FULL for filtered-DELETE-Realtime
-- consistency (the other 5 chat_* tables already do this).
-- =============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_thread_migration_status;
ALTER TABLE public.chat_thread_migration_status REPLICA IDENTITY FULL;

-- Reversal:
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_thread_migration_status;
--   ALTER TABLE public.chat_thread_migration_status REPLICA IDENTITY DEFAULT;
