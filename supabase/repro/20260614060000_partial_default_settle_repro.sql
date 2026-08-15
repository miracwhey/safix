-- =============================================================================
-- BEHAVIORAL REPRO (aborted-tx) — Block P · Batch 3 settle-fix (F1)
-- Migration under test: supabase/migrations/20260614060000_p_default_cut_partial_settle.sql
--   (depends on 20260614050000 apply_dispute_default_refund 75/25 + the
--    default_refund_minor / default_applied_at columns).
-- =============================================================================
-- WHAT THIS PROVES (behavioral, prod-schema-faithful — NOT review-by-reading):
--   After the T+80 default chain (apply_dispute_default_refund → settle_dispute_default)
--   on a plan where the 25% deposit was already paid out (po_*) and the 75% final
--   is still held in escrow:
--     1. the HELD final tranche → 'refunded'
--     2. the released 25% deposit tranche STAYS 'released' (never reversed)  ← F1 core
--     3. the ledger row is entry_type='refund_partial' with amount = the held
--        SNAPSHOT (750.00), NOT the full total (1000.00)                      ← G3 / (b)
--     4. ledger metadata carries held_minor / released_retained_minor / total_minor
--        and the REAL shares (refund_ratio 0.75, split_ratio 0.25 from held/total) ← F3
--     5. the escrow plan is NOT forced to 'refunded' (stays 'partially_released') ← (c)
--     6. payments.status is NOT forced to 'refunded' (stays 'disputed')          ← (c)
--     7. jobs.payment_state is NOT forced to 'refunded'                          ← (c)
--     8. dispute.settlement_status flips pending → settled                       ← settle core
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near database with migration
--     20260614060000_p_default_cut_partial_settle.sql (and 20260614050000) APPLIED.
--     This is an APPLY-TIME GATE: it is NOT run in the build harness (no DB there).
--   * Command:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--               supabase/repro/20260614060000_partial_default_settle_repro.sql
--   * Expected terminal output:  a single NOTICE block ending with
--       "REPRO PASSED — all 8 invariants hold" followed by the deliberate
--       'REPRO_ROLLBACK_SENTINEL' ERROR that aborts the transaction.
--     Any "ASSERT_FAILED: ..." ERROR before the sentinel = the fix regressed.
--   * NOTHING PERSISTS: the whole thing runs inside one transaction that is
--     rolled back by the final RAISE (and a trailing ROLLBACK for belt-and-braces).
--
-- SEEDING NOTE: seed INSERTs run with session_replication_role='replica' so FK
--   triggers are skipped (no need to build the full offers/profiles graph — the
--   RPCs never traverse those refs). It is reset to 'origin' BEFORE the RPC calls,
--   so the real settle runs with all triggers active (disputes_status_change_guard
--   admits the settlement flip via branch (b): owner/service-role auth.uid() IS NULL).
--   Requires DB-owner / superuser (matches the service_role cron context).
-- =============================================================================

BEGIN;

-- Fixed UUIDs so every statement can reference the same rows without plpgsql plumbing.
-- job=aaaa offer=bbbb plan=cccc payment=dddd dispute=eeee dep=1111 fin=2222 cust=3333 prov=4444
SELECT set_config('session_replication_role', 'replica', true);  -- skip FK/triggers for seed only

INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Batch3 repro job', 'waiting_payment',
        'work_in_progress', 'under_review', '44444444-4444-4444-4444-444444444444');

INSERT INTO public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, currency, total_amount,
   status, platform_fee_rate, platform_fee_amount)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333',
        NULL, 'EUR', 1000.00, 'partially_released', 0.0900, 90.00);

-- Deposit 25% — ALREADY PAID OUT via payout (po_*): status 'released', external_payout_ref set.
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status, released_at, external_payout_ref)
VALUES ('11111111-1111-1111-1111-111111111111',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'deposit_release', 25.00, 250.00, 'work_started', 'released', now(), 'po_test_deposit');

-- Final 75% — STILL HELD in escrow (the shared held predicate selects this one).
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
VALUES ('22222222-2222-2222-2222-222222222222',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'final_release', 75.00, 750.00, 'work_completed', 'funded');

-- Payment in 'disputed' (set by open_dispute_atomic in the real flow).
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'disputed', 'pi_test_repro', 1000.00, 1000.00, 'eur');

-- Dispute pre-default: under_review, no decision, default not yet applied.
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, reason, description)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
        'under_review', 'work_quality', 'Batch3 repro dispute');

SELECT set_config('session_replication_role', 'origin', true);  -- triggers ON for the real RPC run

-- ── Run the real T+80 default chain (service-role / owner context) ───────────
SELECT public.apply_dispute_default_refund('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
SELECT public.settle_dispute_default('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');

-- ── Assertions ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_set_status     text;
  v_dep_status     text;
  v_fin_status     text;
  v_plan_status    text;
  v_pay_status     text;
  v_job_pay_state  text;
  v_led_count      int;
  v_led_type       text;
  v_led_amount     numeric;
  v_led_meta       jsonb;
  v_snapshot       bigint;
BEGIN
  SELECT settlement_status, default_refund_minor
    INTO v_set_status, v_snapshot
    FROM public.disputes WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT status INTO v_dep_status
    FROM public.escrow_tranches WHERE id = '11111111-1111-1111-1111-111111111111';
  SELECT status INTO v_fin_status
    FROM public.escrow_tranches WHERE id = '22222222-2222-2222-2222-222222222222';
  SELECT status INTO v_plan_status
    FROM public.escrow_payment_plans WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  SELECT status INTO v_pay_status
    FROM public.payments WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  SELECT payment_state INTO v_job_pay_state
    FROM public.jobs WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  SELECT count(*), max(entry_type), max(amount), max(metadata)
    INTO v_led_count, v_led_type, v_led_amount, v_led_meta
    FROM public.ledger_entries WHERE dispute_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  -- 0. apply stamped the held snapshot = 750.00 * 100.
  IF v_snapshot IS DISTINCT FROM 75000 THEN
    RAISE EXCEPTION 'ASSERT_FAILED: default_refund_minor expected 75000, got %', v_snapshot;
  END IF;
  -- 8. settle flipped settlement_status pending → settled.
  IF v_set_status IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: settlement_status expected settled, got %', v_set_status;
  END IF;
  -- 1. held final tranche → refunded.
  IF v_fin_status IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: final tranche expected refunded, got %', v_fin_status;
  END IF;
  -- 2. released 25% deposit tranche STAYS released (F1 core).
  IF v_dep_status IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: deposit tranche expected released (untouched), got %', v_dep_status;
  END IF;
  -- 3a. exactly one ledger row, entry_type refund_partial.
  IF v_led_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ASSERT_FAILED: expected exactly 1 ledger row, got %', v_led_count;
  END IF;
  IF v_led_type IS DISTINCT FROM 'refund_partial' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: ledger entry_type expected refund_partial, got %', v_led_type;
  END IF;
  -- 3b. ledger amount = held snapshot (750.00), NOT total (1000.00).
  IF v_led_amount IS DISTINCT FROM 750.00 THEN
    RAISE EXCEPTION 'ASSERT_FAILED: ledger amount expected 750.00 (snapshot, not 1000.00 total), got %', v_led_amount;
  END IF;
  -- 4. ledger metadata: held / released_retained / total / real shares (F3).
  IF (v_led_meta->>'held_minor')::bigint IS DISTINCT FROM 75000
     OR (v_led_meta->>'released_retained_minor')::bigint IS DISTINCT FROM 25000
     OR (v_led_meta->>'total_minor')::bigint IS DISTINCT FROM 100000
     OR (v_led_meta->>'refund_ratio')::numeric IS DISTINCT FROM 0.7500
     OR (v_led_meta->>'split_ratio')::numeric  IS DISTINCT FROM 0.2500 THEN
    RAISE EXCEPTION 'ASSERT_FAILED: ledger metadata shares wrong: %', v_led_meta;
  END IF;
  -- 5. plan NOT forced to refunded.
  IF v_plan_status IS DISTINCT FROM 'partially_released' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: plan expected partially_released (NOT refunded), got %', v_plan_status;
  END IF;
  -- 6. payment NOT forced to refunded.
  IF v_pay_status IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: payment expected disputed (NOT refunded), got %', v_pay_status;
  END IF;
  -- 7. job payment_state NOT forced to refunded.
  IF v_job_pay_state IS DISTINCT FROM 'work_in_progress' THEN
    RAISE EXCEPTION 'ASSERT_FAILED: job payment_state expected work_in_progress (NOT refunded), got %', v_job_pay_state;
  END IF;

  RAISE NOTICE '------------------------------------------------------------------';
  RAISE NOTICE 'REPRO PASSED — all 8 invariants hold:';
  RAISE NOTICE '  held final tranche=% · released deposit=% (unchanged)', v_fin_status, v_dep_status;
  RAISE NOTICE '  ledger=% amount=% (snapshot, not 1000.00 total)', v_led_type, v_led_amount;
  RAISE NOTICE '  plan=% · payment=% · job.payment_state=% (all NOT refunded)', v_plan_status, v_pay_status, v_job_pay_state;
  RAISE NOTICE '  dispute.settlement_status=%', v_set_status;
  RAISE NOTICE '------------------------------------------------------------------';

  -- Final RAISE = rollback (nothing persists). Distinct sentinel so the operator
  -- can tell "passed + rolled back" from a real ASSERT_FAILED above.
  RAISE EXCEPTION 'REPRO_ROLLBACK_SENTINEL: success, aborting tx (no data persisted)';
END;
$$;

-- Belt-and-braces: the DO block already aborted the tx; this is unreachable but
-- guarantees no persistence if the sentinel is ever removed.
ROLLBACK;

-- =============================================================================
-- DEADLOCK / WRITE-SKEW TEST CONCEPT (2 sessions — run manually, NOT here)
-- Proves the G2 deadlock fix + A1 write-skew fix from the Plan→Tranche lock order.
-- -----------------------------------------------------------------------------
-- Setup (one session, committed): a plan with the deposit tranche in
--   'release_pending' (a payout.paid is about to complete it) AND a dispute that
--   has just been default-applied (resolved/refund/settlement_status=pending,
--   default_refund_minor stamped) on the SAME plan.
--
-- Session A:  BEGIN;
--             SELECT public.complete_tranche_payout('<deposit_tranche>','po_x');
--             -- (does NOT commit yet)
-- Session B:  BEGIN;
--             SELECT public.settle_dispute_default('<dispute>');
--             -- (does NOT commit yet)
--
-- POST-FIX (this migration): both RPCs take escrow_payment_plans FOR UPDATE
--   FIRST. Whichever grabs the plan lock first runs to completion; the other
--   BLOCKS on the plan row and proceeds once the first COMMITs. No ABBA cycle →
--   NO deadlock, and the tranche reads/writes are serialized on the plan lock so
--   there is NO write-skew (A's release-rollup and B's held-refund cannot
--   interleave on stale snapshots). Final state is deterministic regardless of
--   which session committed first.
--
-- PRE-FIX (old defs): complete_tranche_payout locked the TRANCHE first then the
--   plan; settle_dispute_default locked the plan (after the dispute) then the
--   tranches. A holds tranche-lock waiting for plan-lock; B holds plan-lock
--   waiting for tranche-lock → Postgres detects ERRCODE 40P01 (deadlock_detected)
--   and kills one session. The lock-order unification removes that cycle.
-- =============================================================================
