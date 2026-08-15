-- Repair: enforce invariant attribution_status = 'finalized' → commercial_origin NOT NULL.
--
-- Migration 20260410000002 originally backfilled legacy NULL commercial_origin rows to
-- attribution_status = 'finalized' WITHOUT setting commercial_origin.  This created
-- rows where attribution_status = 'finalized' but commercial_origin IS NULL — a direct
-- violation of the system invariant:
--
--   A finalized job must have commercial_origin IN ('merchant_brought', 'platform_acquired').
--
-- This migration repairs those rows by setting commercial_origin = 'platform_acquired',
-- formalising the conservative safe default that the fee layer was already applying
-- (9% via wasDefaulted).  No fee change occurs: the rate was already 9%.
--
-- If migration 20260410000002 was fixed before being applied (i.e. the NULL backfill
-- already sets commercial_origin), this migration is a safe no-op (no rows match).

UPDATE jobs
SET commercial_origin = 'platform_acquired'
WHERE attribution_status = 'finalized'
  AND commercial_origin IS NULL;

-- Verify: after this migration, no finalized+NULL rows should remain.
-- (informational — does not block the migration on failure)
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM jobs
  WHERE attribution_status = 'finalized'
    AND commercial_origin IS NULL;

  IF bad_count > 0 THEN
    RAISE WARNING 'ATTRIBUTION INVARIANT VIOLATION: % job(s) remain with attribution_status = ''finalized'' AND commercial_origin IS NULL after repair migration.', bad_count;
  ELSE
    RAISE NOTICE 'Attribution invariant confirmed: 0 finalized+NULL rows.';
  END IF;
END;
$$;
