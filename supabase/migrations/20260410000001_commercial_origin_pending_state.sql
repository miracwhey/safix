-- Expand commercial_origin on jobs and projects to allow the transient
-- 'unknown_pending_resolution' state.
--
-- This state is stamped on a job when the customer_provider_relationships
-- lookup fails transiently at job-creation time (Supabase timeout, 503, etc.).
--
-- Invariant:
--   'unknown_pending_resolution' on a job BLOCKS all payment initiation.
--   Payment endpoints (create-escrow, initiate-funding) gate on
--   attribution_status = 'finalized' and return 402
--   PAYMENT_BLOCKED_ATTRIBUTION_UNRESOLVED when not finalized.
--   Resolution is handled exclusively by the Attribution Finalizer worker.
--
-- 'unknown_pending_resolution' is NEVER stored in customer_provider_relationships.
-- That table only ever holds 'merchant_brought' or 'platform_acquired'.

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_commercial_origin_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_commercial_origin_check
  CHECK (commercial_origin IN (
    'merchant_brought',
    'platform_acquired',
    'unknown_pending_resolution'
  ));

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_commercial_origin_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_commercial_origin_check
  CHECK (commercial_origin IN (
    'merchant_brought',
    'platform_acquired',
    'unknown_pending_resolution'
  ));
