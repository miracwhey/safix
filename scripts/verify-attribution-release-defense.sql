-- ─────────────────────────────────────────────────────────────────────────────
-- Attribution Release-Defense Trigger — reproducible behavioural verification.
--
-- Purpose:
--   Prove the DB-level `assert_attribution_finalized_before_release` trigger
--   (migration 20260420000003) actually blocks writes of status='released' on
--   both `escrow_tranches` and `supplementary_payment_requests` when the
--   owning job's attribution is not finalized.
--
-- Guarantee:
--   100 % non-destructive.  Each test uses a synthetic fake UUID that points
--   to a non-existent job/plan, so the trigger fires on the
--   `plan_not_found_or_missing_job` / `job_not_found` branch and raises
--   BEFORE any row is inserted.  No production data is mutated.
--
-- How to run:
--   1. Supabase SQL Editor:  paste + execute.  Expect two ERROR rows with
--      SQLSTATE P0004.
--   2. supabase CLI:         supabase db execute --project-ref <ref> < scripts/verify-attribution-release-defense.sql
--   3. psql:                 psql "$DATABASE_URL" -f scripts/verify-attribution-release-defense.sql
--
-- Interpreting the output:
--   PASS  (expected)  :  ERROR P0004  ATTRIBUTION_NOT_FINALIZED: <detail>
--   FAIL  (trigger did not fire)  :  statement completes without error
--   FAIL  (wrong SQLSTATE)  :  any other SQLSTATE
--
-- Last live run (against project itdntawwuzqfwmcwnwjr, 2026-04-20):
--   Test 1  ✅  P0004  ATTRIBUTION_NOT_FINALIZED: plan_not_found_or_missing_job
--   Test 2  ✅  P0004  ATTRIBUTION_NOT_FINALIZED: job_not_found
-- ─────────────────────────────────────────────────────────────────────────────

-- Test 1 — escrow_tranches: INSERT status='released' with a plan_id that
-- does not exist.  Expect: trigger fires BEFORE the FK check with
-- P0004 ATTRIBUTION_NOT_FINALIZED: plan_not_found_or_missing_job.
-- To re-enable: remove the BEGIN/ROLLBACK wrapping or execute the inner
-- statement directly; expect it to raise the error immediately.

BEGIN;

DO $$
BEGIN
  INSERT INTO public.escrow_tranches (
    id, plan_id, kind, status, amount, percentage, release_trigger,
    created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000000',
    'deposit_release',
    'released',
    100,
    0.25,
    'work_started',
    now(),
    now()
  );
  RAISE EXCEPTION 'TEST 1 FAIL: escrow_tranches trigger did not fire';
EXCEPTION WHEN sqlstate 'P0004' THEN
  RAISE NOTICE 'TEST 1 PASS: % %', SQLSTATE, SQLERRM;
END $$;

ROLLBACK;

-- Test 2 — supplementary_payment_requests: INSERT status='released' with a
-- job_id that does not exist.  Expect: trigger fires with P0004
-- ATTRIBUTION_NOT_FINALIZED: job_not_found.

BEGIN;

DO $$
BEGIN
  INSERT INTO public.supplementary_payment_requests (
    id, change_order_id, job_id, customer_user_id, craftsman_user_id,
    amount_cents, currency, status, original_payment_id, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000',
    100,
    'eur',
    'released',
    gen_random_uuid(),
    extract(epoch from now())::bigint * 1000,
    extract(epoch from now())::bigint * 1000
  );
  RAISE EXCEPTION 'TEST 2 FAIL: supplementary_payment_requests trigger did not fire';
EXCEPTION WHEN sqlstate 'P0004' THEN
  RAISE NOTICE 'TEST 2 PASS: % %', SQLSTATE, SQLERRM;
END $$;

ROLLBACK;

-- Test 3 — static smoke of trigger + RPC presence (read-only).  Should
-- return rows documenting the defences are installed.  Only a single
-- ORDER BY at the end of the compound query — inner ORDER BY before
-- UNION is not allowed in PostgreSQL.

SELECT 'TRIGGER ' || tgname AS installed
  FROM pg_trigger
 WHERE tgname LIKE 'assert_attribution_finalized_before_release%'
UNION ALL
SELECT 'RPC ' || proname
  FROM pg_proc
 WHERE proname IN ('operator_resolve_attribution', 'assert_attribution_finalized_before_release')
 ORDER BY 1;
