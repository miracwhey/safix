-- DB-level enforcement of the attribution invariant:
--   attribution_status = 'finalized' → commercial_origin IN ('merchant_brought', 'platform_acquired')
--
-- This invariant is already enforced in application code (create-escrow hard gate +
-- origin validity assertion) and was repaired by migration 20260410000003 for any
-- pre-existing finalized+NULL rows.  This constraint closes the final gap: it prevents
-- the invalid state from being persisted even if application-layer checks are bypassed
-- (direct SQL writes, future migration mistakes, worker bugs).
--
-- The CHECK expression reads:
--   NOT (attribution_status = 'finalized')
--   OR  commercial_origin IN ('merchant_brought', 'platform_acquired')
-- which is logically equivalent to the implication:
--   attribution_status = 'finalized' → commercial_origin IN ('merchant_brought', 'platform_acquired')
--
-- Rows where attribution_status is 'pending' or 'retrying' are unconstrained —
-- commercial_origin may be NULL or 'unknown_pending_resolution' in those states.
--
-- Pre-condition: migration 20260410000003 must have run first (zero finalized+NULL rows).
-- This migration is a no-op if the invariant is already satisfied.

-- NULL semantics fix: `FALSE OR NULL = NULL` passes in PostgreSQL CHECK constraints.
-- The explicit IS NOT NULL guard ensures finalized+NULL is rejected at the DB level.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_attribution_finalized_origin_check
  CHECK (
    attribution_status != 'finalized'
    OR (
      commercial_origin IS NOT NULL
      AND commercial_origin IN ('merchant_brought', 'platform_acquired')
    )
  );
