-- =============================================================================
-- Migration: Job.jobKind — Paket 2 Commercial Document Policy
-- =============================================================================
--
-- Introduces `job_kind` column to the `jobs` table.
--
-- Background:
--   Paket 1 introduced `Offer.documentType` as the leading commercial typing
--   for pre-execution documents. However, the Job created on acceptance had no
--   field to record which kind of document created it. This meant execution and
--   payment guards could not enforce type policy at the Job level without
--   joining back to the Offer.
--
--   Paket 2 fixes this by stamping the Job with its commercial kind at
--   creation time (derived from the accepting Offer's documentType).
--
-- job_kind values:
--   'standard'          — Job created by binding_offer acceptance.
--                         Full payment/escrow/execution corridor active.
--   'estimate_tracking' — Job created by estimate acceptance.
--                         Tracking only. No payment, no escrow, no standard execution.
--   'diagnosis'         — Job created by diagnosis acceptance.
--                         Own diagnosis execution path only. No standard payment/escrow.
--
-- NULL handling:
--   Jobs created before this migration have no job_kind. The domain layer
--   treats NULL as 'standard' for backward compatibility (all pre-Paket-2
--   jobs were created from binding_offer acceptance).
--
-- Backfill:
--   Existing rows are backfilled via source offer join where possible.
--   Rows with no source_offer_id or where the offer has no document_type
--   default to 'standard' (safe: pre-Paket-1 offers were all binding).
--
-- Applied: 2026-04-12 (Paket 2 — Commercial Document Policy)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add job_kind column
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS job_kind text;

COMMENT ON COLUMN public.jobs.job_kind IS
  'Commercial kind of this job — derived from the documentType of the Offer that created it (Paket 2). '
  '''standard'' (binding_offer origin, full execution) | '
  '''estimate_tracking'' (estimate origin, tracking only) | '
  '''diagnosis'' (diagnosis origin, own diagnosis path). '
  'NULL = legacy pre-Paket-2 job, treated as ''standard''.';

-- ---------------------------------------------------------------------------
-- 2. Add CHECK constraint
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_job_kind_check
    CHECK (job_kind IS NULL OR job_kind IN ('standard', 'estimate_tracking', 'diagnosis'));

-- ---------------------------------------------------------------------------
-- 3. Backfill from source offer's document_type where possible
--
--    Priority:
--      a) Join to offers via source_offer_id and map document_type → job_kind
--      b) Rows without source_offer_id or with NULL document_type → 'standard'
-- ---------------------------------------------------------------------------
UPDATE public.jobs j
  SET job_kind = CASE o.document_type
    WHEN 'binding_offer' THEN 'standard'
    WHEN 'estimate'      THEN 'estimate_tracking'
    WHEN 'diagnosis'     THEN 'diagnosis'
    ELSE                      'standard'   -- unknown/NULL → standard (backward compat)
  END
  FROM public.offers o
  WHERE j.source_offer_id = o.id
    AND j.job_kind IS NULL;

-- Remaining rows (no source_offer_id, or offer not found) → standard
UPDATE public.jobs
  SET job_kind = 'standard'
  WHERE job_kind IS NULL;
