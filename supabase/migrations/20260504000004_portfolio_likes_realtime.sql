-- Enable Supabase Realtime for the provider_media_likes table.
--
-- The PortfolioLightbox player (M2.2) subscribes to postgres_changes on
-- provider_media_likes filtered by media_id so a like cast on one client
-- (e.g. customer's iPhone) shows up immediately on another device viewing
-- the same craftsman profile (e.g. the craftsman's owner profile, the
-- explore feed). Without this publication entry the subscription connects
-- but no row events flow — likes only appear after a hard refresh.
--
-- Idempotent: only adds the table when it is not already a member of the
-- supabase_realtime publication, so the migration is safe to apply more
-- than once.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_media_likes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_media_likes;
  END IF;
END$$;
