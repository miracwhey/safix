-- =============================================================================
-- Migration: Add 'cost_estimate_tracking' to jobs.job_kind CHECK constraint
-- =============================================================================
--
-- Paket 1+ introduced 'cost_estimate' as a document type that creates a Job
-- for internal tracking purposes only — no payment, no escrow, no execution.
-- The corresponding job_kind value is 'cost_estimate_tracking'.
--
-- The existing CHECK constraint from migration 20260412000005 must be widened.
-- Using DROP + ADD to replace the constraint cleanly.
--
-- Applied: 2026-04-12 (Paket 1+ — cost_estimate_tracking job kind)
-- =============================================================================

ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_job_kind_check;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_job_kind_check
    CHECK (job_kind IS NULL OR job_kind IN (
      'standard',
      'estimate_tracking',
      'cost_estimate_tracking',
      'diagnosis'
    ));

COMMENT ON COLUMN public.jobs.job_kind IS
  'Commercial kind of this job — derived from the documentType of the Offer that created it (Paket 2+). '
  '''standard'' (binding_offer origin, full execution + escrow) | '
  '''estimate_tracking'' (estimate origin, tracking only) | '
  '''cost_estimate_tracking'' (cost_estimate origin, tracking only, no payment) | '
  '''diagnosis'' (diagnosis origin, own diagnosis instant-payment path). '
  'NULL = legacy pre-Paket-2 job, treated as ''standard''.';
