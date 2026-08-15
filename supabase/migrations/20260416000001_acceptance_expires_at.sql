-- =============================================================================
-- Migration: Add expires_at to acceptances for 72h auto-release deadline
-- =============================================================================
-- When a craftsman marks work complete, the acceptance is created with
-- expires_at = created_at + 72 hours. If the customer does not confirm
-- within this window, the system auto-releases the final payment tranche.
--
-- The index on (status, expires_at) supports the cron query:
--   SELECT * FROM acceptances
--   WHERE status = 'pending' AND expires_at <= now()
-- =============================================================================

ALTER TABLE public.acceptances
  ADD COLUMN IF NOT EXISTS expires_at bigint;

COMMENT ON COLUMN public.acceptances.expires_at IS
  'Unix timestamp (ms) when the acceptance deadline expires. '
  'Set to created_at + 72h at work completion. '
  'After expiry, cron auto-releases the final payment tranche.';

-- Partial index for efficient cron query: only pending acceptances with a deadline
CREATE INDEX IF NOT EXISTS idx_acceptances_pending_expires
  ON public.acceptances (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL;
