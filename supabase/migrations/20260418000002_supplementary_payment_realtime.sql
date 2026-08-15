-- Enable Supabase Realtime for supplementary_payment_requests
--
-- Required so that webhook-driven status transitions (e.g. payment_intent.succeeded
-- → status 'funded') are delivered to open client sessions via the Realtime channel
-- in SupabaseSupplementaryPaymentRepository.  Without this, server-confirming
-- recovery in SupplementaryFundingScreen depends only on manual reload.
--
-- Idempotent: checks pg_publication_tables before altering the publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'supplementary_payment_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.supplementary_payment_requests;
  END IF;
END;
$$;
