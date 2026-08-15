-- R4 — live invoice status. Add `invoices` to the supabase_realtime publication
-- so a status transition (issued→sent→paid→cancelled) reaches the watching
-- customer/craftsman without a reload. Realtime respects RLS, so each subscriber
-- only receives invoice rows they may SELECT.
--
-- Default replica identity (PK) is sufficient: the INSERT/UPDATE handlers read
-- payload.new (the full row); we do not filter on OLD or on non-PK DELETEs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'invoices'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoices;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
