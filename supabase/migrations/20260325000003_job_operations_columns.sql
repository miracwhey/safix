-- ============================================================
-- Job Operations Columns
-- ============================================================
-- Adds operational lifecycle columns to the jobs table to support
-- real provider-side job operations: work-start, work-complete,
-- and funding request tracking.
--
-- These columns persist the operational state transitions that
-- were previously only tracked in-memory.
-- ============================================================

-- work_started_at: Unix timestamp (ms) when provider started work.
-- Separate from proposal_accepted_at — a job may be accepted but
-- work not yet started. Maps to escrow deposit_release eligibility.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS work_started_at bigint;

-- funding_requested_at: Unix timestamp (ms) when provider sent the
-- funding step card / funding request to the customer.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS funding_requested_at bigint;

-- source_offer_id: Links the job back to the accepted offer.
-- Already present in the in-memory model; this persists it to the DB.
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS source_offer_id text;

-- ── Indexes for operational queries ──────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_jobs_work_started_at
  ON public.jobs (work_started_at)
  WHERE work_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_source_offer_id
  ON public.jobs (source_offer_id)
  WHERE source_offer_id IS NOT NULL;
