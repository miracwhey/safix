-- =============================================================================
-- BEHAVIORAL REPRO (aborted-tx) — Block P · #5 operator split ratio (0,1) EXCLUSIVE
-- Migration under test: supabase/migrations/20260615000000_p_operator_split_ratio_exclusive.sql
-- =============================================================================
-- WHAT THIS PROVES (behavioral, prod-schema-faithful — NOT review-by-reading):
--   operator_resolve_dispute_split now REJECTS a split ratio outside (0,1):
--     1. ratio = 0     → RAISE invalid_split_ratio (was a double-pay: full
--        provider release via release-tranche.ts coercion + full customer refund
--        via service.ts total*(1-0))
--     2. ratio = 1     → RAISE invalid_split_ratio (a full release, not a split)
--     3. ratio = -0.5  → RAISE invalid_split_ratio
--     4. ratio = 1.5   → RAISE invalid_split_ratio
--     5. ratio = NULL  → RAISE invalid_split_ratio (unchanged)
--     6. ratio = 0.5   → ADMITTED by the gate (no invalid_split_ratio); with a
--        non-existent dispute the next step raises dispute_not_found (P0002),
--        proving interior ratios are NOT false-rejected.
--   The ratio guard sits BEFORE the dispute lookup, so 1–5 need no dispute seed.
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near database with migration
--     20260615000000_p_operator_split_ratio_exclusive.sql APPLIED.
--     APPLY-TIME GATE — not run in the build harness (no DB there).
--   * Command:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--               supabase/repro/20260615000000_operator_split_ratio_exclusive_repro.sql
--   * Expected terminal output: a single NOTICE block ending with
--       "REPRO PASSED — all 6 ratio-bound invariants hold" followed by the
--       deliberate 'REPRO_ROLLBACK_SENTINEL' ERROR that aborts the transaction.
--     Any "ASSERT_FAILED: ..." ERROR before the sentinel = the guard regressed.
--   * NOTHING PERSISTS: everything runs inside one transaction rolled back by the
--     final RAISE (plus a trailing ROLLBACK for belt-and-braces).
--
-- SEEDING NOTE: the operator profile is seeded with session_replication_role=
--   'replica' so FK/handle_new_user triggers are skipped (no auth.users graph
--   needed). Reset to 'origin' before switching role. The RPC is then called as
--   the authenticated operator (SET LOCAL ROLE authenticated + request.jwt.claim.sub
--   = the seeded operator uid; _assert_caller_is_operator → is_current_user_operator
--   reads profiles.is_operator). Requires DB-owner / superuser to seed + SET ROLE.
-- =============================================================================

BEGIN;

-- op = aaaa…0001 (is_operator), bogus dispute = bbbb…0002 (intentionally absent)
SELECT set_config('session_replication_role', 'replica', true);  -- skip FK/triggers for seed only

INSERT INTO public.profiles (id, is_operator)
VALUES ('aaaa0000-0000-4000-8000-000000000001', true);

SELECT set_config('session_replication_role', 'origin', true);   -- triggers back on

-- Become the operator (auth.uid() resolves from request.jwt.claim.sub).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaa0000-0000-4000-8000-000000000001', true);

DO $$
DECLARE
  v_bog         uuid := 'bbbb0000-0000-4000-8000-000000000002';  -- non-existent dispute
  v_bad         numeric;
  v_err         text;
  v_passed_gate boolean := false;
BEGIN
  -- setup sanity: the caller is recognized as an operator
  IF NOT public.is_current_user_operator() THEN
    RAISE EXCEPTION 'ASSERT_FAILED [setup]: caller not recognized as operator (auth.uid=%)', auth.uid();
  END IF;

  -- 1–5: every out-of-(0,1) ratio (incl. NULL) must RAISE invalid_split_ratio,
  --      and do so BEFORE the dispute lookup (so the bogus dispute is never read).
  FOREACH v_bad IN ARRAY ARRAY[0, 1, -0.5, 1.5, NULL]::numeric[] LOOP
    BEGIN
      PERFORM public.operator_resolve_dispute_split(v_bog, v_bad);
      RAISE EXCEPTION 'ASSERT_FAILED [r=%]: ratio ACCEPTED (should reject)', COALESCE(v_bad::text, 'NULL')
        USING ERRCODE = 'P0003';
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        IF v_err NOT LIKE 'invalid_split_ratio%' THEN
          RAISE EXCEPTION 'ASSERT_FAILED [r=%]: rejected with WRONG error: %', COALESCE(v_bad::text, 'NULL'), v_err;
        END IF;
    END;
  END LOOP;

  -- 6: an interior ratio (0.5) must PASS the gate. The bogus dispute then raises
  --    dispute_not_found (P0002). Getting invalid_split_ratio here = false-reject.
  BEGIN
    PERFORM public.operator_resolve_dispute_split(v_bog, 0.5);
    -- impossible: a non-existent dispute cannot resolve
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN
      v_passed_gate := true;  -- dispute_not_found ⇒ ratio gate admitted 0.5
    WHEN SQLSTATE 'P0001' THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err LIKE 'invalid_split_ratio%' THEN
        RAISE EXCEPTION 'ASSERT_FAILED [r=0.5]: interior ratio FALSE-REJECTED by gate: %', v_err;
      END IF;
      RAISE EXCEPTION 'ASSERT_FAILED [r=0.5]: unexpected P0001 (not the ratio gate): %', v_err;
  END;
  IF NOT v_passed_gate THEN
    RAISE EXCEPTION 'ASSERT_FAILED [r=0.5]: expected dispute_not_found (P0002) proving gate-pass, got none';
  END IF;

  RAISE NOTICE '------------------------------------------------------------------';
  RAISE NOTICE 'REPRO PASSED — all 6 ratio-bound invariants hold:';
  RAISE NOTICE '  reject: ratio in {0, 1, -0.5, 1.5, NULL} → invalid_split_ratio (pre-lookup)';
  RAISE NOTICE '  admit:  ratio 0.5 → gate passed → dispute_not_found (no false-reject)';
  RAISE NOTICE '------------------------------------------------------------------';

  -- Final RAISE = rollback (nothing persists). Distinct sentinel so the operator
  -- can tell "passed + rolled back" from a real ASSERT_FAILED above.
  RAISE EXCEPTION 'REPRO_ROLLBACK_SENTINEL: success, aborting tx (no data persisted)';
END;
$$;

-- Belt-and-braces: the DO block already aborted the tx; unreachable but guarantees
-- no persistence if the sentinel is ever removed.
ROLLBACK;
