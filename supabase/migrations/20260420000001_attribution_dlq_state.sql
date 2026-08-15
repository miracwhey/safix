-- Attribution DLQ state — terminal manual-review state for the Finalizer worker.
--
-- Context:
--   The Attribution Finalizer (api/cron/finalize-attribution.ts) sweeps jobs in
--   'pending' / 'retrying' state and resolves their commercial_origin.  Prior
--   to this migration, retries were unbounded: a job stuck with missing user IDs
--   or persistent DB issues would cycle in 'retrying' forever.  There was no
--   operator-observable terminal state and no structured escalation path.
--
-- This migration introduces:
--   1. 'dlq' as a valid attribution_status value (Dead Letter Queue).
--   2. attribution_dlq_reason TEXT column — human-readable classification
--      ('MAX_RETRY_EXCEEDED', 'MISSING_USER_IDS', 'OPERATOR_ROLLBACK', ...).
--   3. Widened partial index so operator queries over unresolved attribution
--      rows include DLQ items.
--
-- Contract:
--   - 'dlq' is a NON-finalized status → payment paths must block (see
--     _attributionGuard.ts and release-defense trigger in 20260420000003).
--   - Transition rules:
--       retrying → dlq      (Finalizer decides retry_count exceeds MAX)
--       pending  → dlq      (Finalizer sees unrecoverable condition e.g. missing IDs)
--       dlq      → finalized (Operator resolves — Stage 4 RPC)
--       dlq      → retrying  (Operator requeues — Stage 4 RPC)
--   - Forward transitions (dlq → pending) are NOT permitted via UPDATE paths;
--     the Finalizer only finalizes OR escalates to DLQ.
--   - attribution_dlq_reason is required when attribution_status = 'dlq'
--     (enforced in a CHECK constraint below).

-- ── 1. Widen attribution_status CHECK to include 'dlq' ──────────────────────
-- The original constraint (migration 20260410000002) was inline on ADD COLUMN.
-- PostgreSQL auto-generates the name as "<table>_<column>_check".  We locate
-- and drop it defensively (catches both the auto-generated name and any
-- prior manual naming), then add the widened constraint under a stable name.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%attribution_status%'
    AND pg_get_constraintdef(oid) ILIKE '%pending%'
    AND pg_get_constraintdef(oid) ILIKE '%retrying%'
    AND pg_get_constraintdef(oid) NOT ILIKE '%dlq%'
  LIMIT 1;

  IF FOUND THEN
    EXECUTE format('ALTER TABLE public.jobs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_attribution_status_check
  CHECK (attribution_status IN ('pending', 'finalized', 'retrying', 'dlq'));

-- ── 2. attribution_dlq_reason column ────────────────────────────────────────
-- Nullable in general; required when status = 'dlq' (see CHECK below).

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS attribution_dlq_reason TEXT;

-- ── 3. Reason required when status = 'dlq' ──────────────────────────────────
-- Enforces the invariant: no DLQ row without a documented reason.  Prevents
-- the escalation path from degrading into an opaque bucket of "stuck jobs".

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_attribution_dlq_reason_required
  CHECK (attribution_status <> 'dlq' OR attribution_dlq_reason IS NOT NULL);

-- ── 4. Widen partial index to include 'dlq' for operator queries ────────────
-- Drop-and-recreate keeps the name stable and the predicate explicit.

DROP INDEX IF EXISTS public.idx_jobs_attribution_status;
CREATE INDEX idx_jobs_attribution_status
  ON public.jobs (attribution_status)
  WHERE attribution_status IN ('pending', 'retrying', 'dlq');

-- ── 5. Backfill note ─────────────────────────────────────────────────────────
-- No retroactive re-classification.  Any job currently in 'pending' or
-- 'retrying' stays where it is; the Finalizer with the new Max-Retry logic
-- will escalate as needed on the next sweep.  Backfilling legacy
-- 'unknown_pending_resolution' rows to DLQ en bloc would cause a sudden
-- operator alert spike without grounded cause data.

COMMENT ON COLUMN public.jobs.attribution_dlq_reason IS
  'Documented reason when attribution_status = ''dlq''. See finalize-attribution.ts for taxonomy.';
