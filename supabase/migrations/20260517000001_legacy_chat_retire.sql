-- Block D Slice 7 — Legacy Chat Retirement
-- Sets legacy messaging tables to read-only and disables the migrator cron.
-- Drop after 2026-06-11 (30-day safety window).

-- ── Read-only: conversations + messages ────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.conversations FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.messages      FROM authenticated, anon;

-- ── Read-only: internal_messages (exists in prod, was never used in app) ───────
REVOKE INSERT, UPDATE, DELETE ON public.internal_messages FROM authenticated, anon;

-- ── Archive comments ───────────────────────────────────────────────────────────
COMMENT ON TABLE public.conversations IS
  'ARCHIVED 2026-05-17: migrated to chat_threads. Read-only. Drop after 2026-06-17.';
COMMENT ON TABLE public.messages IS
  'ARCHIVED 2026-05-17: migrated to chat_messages. Read-only. Drop after 2026-06-17.';
COMMENT ON TABLE public.internal_messages IS
  'ARCHIVED 2026-05-17: internal_message_threads never shipped. Read-only. Drop after 2026-06-17.';

-- ── Deactivate migrator cron ───────────────────────────────────────────────────
SELECT cron.unschedule('chat-thread-migrator-batch');
