-- Lane 3 Block 1 follow-up: Add scans to Realtime publication
-- Needed for Block 2 (HW-Toggle UI) to receive UPDATE events filtered by shared_with_customer.
-- REPLICA IDENTITY FULL was set in Block 1 Migration 1 so OLD row carries full data
-- for filtered-Realtime subscriptions.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'scans'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.scans;
  END IF;
END $$;
