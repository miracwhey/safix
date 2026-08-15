-- 20260505000001_provider_media_realtime.sql
--
-- Adds `public.provider_media` to the `supabase_realtime` publication so the
-- Explore Item-Feed (M3.1) can subscribe to INSERT events and refresh when a
-- craftsman publishes a new portfolio item.
--
-- Idempotent: safe to re-run; ALTER PUBLICATION ADD TABLE errors on duplicate
-- membership, so we guard with a pg_publication_tables lookup first.
--
-- Pre-state verified live 2026-05-04 (project itdntawwuzqfwmcwnwjr):
--   pg_publication_tables WHERE pubname='supabase_realtime'
--     → ['provider_media_likes','provider_media_comments']
--   provider_media is NOT a member.
--
-- REPLICA IDENTITY for provider_media stays at the table default (`d`) — only
-- INSERT events are subscribed in M3.1, and the NEW row payload is fully
-- populated regardless of replica identity. M3.2/M3.3 may upgrade to FULL if
-- DELETE / UPDATE filtering on non-PK columns becomes needed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname    = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename  = 'provider_media'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media';
  END IF;
END;
$$;
