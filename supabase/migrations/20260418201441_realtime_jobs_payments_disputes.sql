-- Enable Supabase Realtime for all client-subscribed tables.
--
-- Required so that webhook-driven state transitions propagate to open client
-- sessions via Realtime channels in SupabaseJobRepository,
-- SupabasePaymentRepository, SupabaseDisputeRepository,
-- SupabaseMessageRepository, SupabaseTimelineRepository, and
-- SupabaseNotificationRepository without requiring a manual reload.
--
-- Idempotent: each table is only added when it is not already a member of the
-- supabase_realtime publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.jobs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'payments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'disputes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.disputes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'timeline_signals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.timeline_signals;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notification_signals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_signals;
  END IF;
END$$;
