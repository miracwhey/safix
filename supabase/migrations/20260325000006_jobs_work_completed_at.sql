-- ============================================================
-- Job Operations: work_completed_at column
-- ============================================================
-- The previous job_operations_columns migration (20260325000003) added
-- work_started_at, funding_requested_at, and source_offer_id but missed
-- work_completed_at.
--
-- The code (SupabaseJobRepository.rowToJob, markWorkCompleteWorkflow,
-- craftsmanOperations.completeJob) reads and writes work_completed_at.
-- Without this column the complete-work operation cannot persist.
--
-- This migration closes the gap.
-- ============================================================

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS work_completed_at bigint;

-- Index for operational queries filtering on work completion
CREATE INDEX IF NOT EXISTS idx_jobs_work_completed_at
  ON public.jobs (work_completed_at)
  WHERE work_completed_at IS NOT NULL;
