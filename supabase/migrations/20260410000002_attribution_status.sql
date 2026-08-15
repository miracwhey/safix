-- Two-phase attribution: attribution_status column on jobs.
--
-- Introduces the attribution lifecycle:
--
--   pending   — attribution resolution is in-flight or pending a retry.
--               Job creation succeeded, but the customer_provider_relationships
--               lookup failed transiently (Supabase timeout, 503, etc.).
--               BLOCKS all payment initiation until finalized.
--
--   retrying  — the Attribution Finalizer worker attempted resolution and
--               the DB was still unreachable. Worker will retry with exponential
--               backoff. BLOCKS payment initiation.
--
--   finalized — commercial_origin has been confirmed from
--               customer_provider_relationships (or definitively absent →
--               platform_acquired). Payment initiation is permitted.
--
-- INVARIANT:
--   Payment creation (create-escrow, initiate-funding) MUST require
--   attribution_status = 'finalized'. No inline reconciliation at request time.
--
-- Backfill strategy:
--   • Jobs with commercial_origin IN ('merchant_brought', 'platform_acquired')
--     had attribution confirmed at job-creation time → finalized.
--   • Jobs with commercial_origin = 'unknown_pending_resolution'
--     had a transient DB error at creation → pending (worker will resolve).
--   • Jobs with commercial_origin IS NULL are legacy pre-attribution jobs.
--     They cannot be resolved retroactively, and the fee layer already
--     defaults them to 9% (platform_acquired safe default).
--     Mark them finalized so they are not permanently blocked.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS attribution_status TEXT
    NOT NULL DEFAULT 'pending'
    CHECK (attribution_status IN ('pending', 'finalized', 'retrying'));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS attribution_retry_count INT NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS attribution_last_retry_at TIMESTAMPTZ;

-- Backfill: jobs with a confirmed origin are finalized.
UPDATE jobs
SET attribution_status = 'finalized'
WHERE commercial_origin IN ('merchant_brought', 'platform_acquired');

-- Backfill: legacy jobs (no attribution model).
-- Formalize as 'platform_acquired' — this is the conservative safe default
-- the fee layer already applies (9%).  Making it explicit enforces the
-- invariant: attribution_status = 'finalized' → commercial_origin NOT NULL.
--
-- This does NOT change fee behaviour: the rate was already 9% via wasDefaulted.
-- It only makes the stored classification explicit and queryable.
UPDATE jobs
SET attribution_status = 'finalized',
    commercial_origin = 'platform_acquired'
WHERE commercial_origin IS NULL;

-- Jobs with unknown_pending_resolution stay at 'pending' (default).
-- The Attribution Finalizer cron will sweep them.

CREATE INDEX IF NOT EXISTS idx_jobs_attribution_status
  ON jobs (attribution_status)
  WHERE attribution_status IN ('pending', 'retrying');
