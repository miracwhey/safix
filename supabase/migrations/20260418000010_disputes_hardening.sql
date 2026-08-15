-- =============================================================================
-- Migration: Disputes – DB-level hardening for release standard
-- =============================================================================
-- 1. Add missing columns (settlement_status, context_snapshot) that the
--    SupabaseDisputeRepository expects but may not exist in older deployments.
-- 2. Add UNIQUE partial index so only one ACTIVE dispute can exist per job
--    at any given time.  Resolved disputes do not count toward the limit.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add missing columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS settlement_status text,
  ADD COLUMN IF NOT EXISTS context_snapshot  jsonb;

COMMENT ON COLUMN public.disputes.settlement_status IS
  'Financial settlement state for terminal disputes. '
  'pending = decision made, money action not yet completed. '
  'settled = money action confirmed. NULL for non-terminal disputes.';

COMMENT ON COLUMN public.disputes.context_snapshot IS
  'JSONB snapshot of job/payment state captured at dispute-open time. '
  'Used to reconstruct the dispute context for review and resolution. '
  'Null for disputes opened before this column was added.';

-- ---------------------------------------------------------------------------
-- 2. UNIQUE partial index — one active dispute per job
--
-- Covers only the lifecycle statuses where a dispute is "in flight".
-- Resolved or rejected disputes are excluded so historical records are
-- preserved and a new dispute can be opened if circumstances change.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_job_active_unique
  ON public.disputes (job_id)
  WHERE status IN ('open', 'awaiting_evidence', 'under_review');

COMMENT ON INDEX idx_disputes_job_active_unique IS
  'Prevents concurrent active disputes for the same job. '
  'Resolved/rejected disputes are excluded to allow historical records and future re-opening.';
