-- Enable Supabase Realtime for escrow and funding tables.
--
-- SupabaseEscrowPlanRepository and SupabaseFundingRequestRepository subscribe
-- to postgres_changes on these tables. Without this publication entry the
-- subscriptions connect but never receive row changes — so webhook-driven
-- funding confirmation (confirm_funding_atomic RPC) does not propagate to
-- the craftsman's device, requiring a manual reload after each Stripe event.
--
-- Idempotent: each table is only added when it is not already a member of the
-- supabase_realtime publication, so the migration is safe to apply more than once.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'escrow_payment_plans'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.escrow_payment_plans;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'escrow_tranches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.escrow_tranches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'funding_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.funding_requests;
  END IF;
END$$;
