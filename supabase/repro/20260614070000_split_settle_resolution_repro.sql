-- =============================================================================
-- BEHAVIORAL REPRO (aborted-tx) — Block P · Batch 4 settle_dispute_resolution
-- Migration under test: supabase/migrations/20260614070000_p4_batch4_split_settle_relocation.sql
--   (depends on Batch 1-3 + A1-clean; generalized shared corridor settler).
-- =============================================================================
-- WHAT THIS PROVES (behavioral, prod-schema-faithful — NOT review-by-reading) —
-- the THREE post-fix invariants the in-memory pins (tests/api/stripeWebhookBatch4
-- SplitSettle G7 A/B + settle C/D/E/F) cannot reach, because they live in the SQL
-- body settle_dispute_resolution, not the TS webhook:
--
--   S1 · RELEASE/REJECT = pure settlement_status flip (HIGH fix):
--        decision='release' → settle does NOT refund the still-HELD craftsman
--        tranche to the customer (it STAYS held), writes NO ledger row, and only
--        flips settlement_status pending→settled. (Wrong-party-money guard.)
--
--   S2 · operator/consensus SPLIT = held-only refund (no snapshot, live SUM):
--        decision='split', no default_refund_minor → amount = LIVE SUM of held
--        tranches; the held 75% final → 'refunded', the released 25% deposit
--        STAYS released, exactly ONE refund_partial ledger row (amount=750.00,
--        source='corridor_resolution'), payments/jobs NOT touched (G6=B).
--
--   S3 · MULTI-DISPUTE no ledger double-count (HIGH fix — live SUM excludes
--        'refunded'): two resolved+pending splits on ONE job. settle(A) refunds
--        the held final tranche + writes refund_partial(A). settle(B) re-runs the
--        live SUM, which now EXCLUDES the already-'refunded' tranche → 0 → writes
--        NO second refund_partial. Total refund rows for the job = 1, not 2.
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near DB with 20260614070000 (and 050000/060000) APPLIED.
--     APPLY-TIME GATE: not run in the build harness (no DB there).
--   * Command:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--               supabase/repro/20260614070000_split_settle_resolution_repro.sql
--   * Expected terminal output: a NOTICE block ending with
--       "REPRO PASSED — all 3 settle_dispute_resolution invariants hold" followed
--       by the deliberate 'REPRO_ROLLBACK_SENTINEL' ERROR that aborts the tx.
--     Any "ASSERT_FAILED: ..." ERROR before the sentinel = a regression.
--   * NOTHING PERSISTS: one transaction, rolled back by the final RAISE (+ ROLLBACK).
--
-- SEEDING NOTE: seed INSERTs run with session_replication_role='replica' so FK
--   triggers are skipped (no need for the offers/profiles graph — the RPC never
--   traverses those refs). Reset to 'origin' BEFORE the RPC calls so the real
--   settle runs with triggers active (disputes_status_change_guard admits the flip
--   via branch (b): owner/service-role auth.uid() IS NULL). Requires DB-owner.
-- =============================================================================

BEGIN;

SELECT set_config('session_replication_role', 'replica', true);  -- seed only

-- ── S1: RELEASE — held craftsman tranche must NOT be refunded ─────────────────
-- job=a1 plan=c1 pay=d1 disp=e1 ; deposit=11(released) final=12(held/funded)
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('a1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'B4 repro S1 release', 'waiting_payment',
        'work_in_progress', 'resolved', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, currency, total_amount,
   status, platform_fee_rate, platform_fee_amount)
VALUES ('c1cccccc-cccc-cccc-cccc-cccccccccccc', 'b1bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'a1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        NULL, 'EUR', 1000.00, 'partially_released', 0.0900, 90.00);
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status, released_at, external_payout_ref)
VALUES ('11111111-1111-1111-1111-111111111111', 'c1cccccc-cccc-cccc-cccc-cccccccccccc',
        'deposit_release', 25.00, 250.00, 'work_started', 'released', now(), 'po_s1_deposit');
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
VALUES ('12222222-2222-2222-2222-222222222222', 'c1cccccc-cccc-cccc-cccc-cccccccccccc',
        'final_release', 75.00, 750.00, 'work_completed', 'funded');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('d1dddddd-dddd-dddd-dddd-dddddddddddd', 'a1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'disputed', 'pi_s1', 1000.00, 1000.00, 'eur');
-- resolved RELEASE, no snapshot, settlement pending (operator decision direct).
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('e1eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'a1aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'release', 'release_full', 'pending', 'work_quality', 'B4 S1 release', now());

-- ── S2: SPLIT — held-only refund, one refund_partial, live SUM (no snapshot) ──
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('a2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'B4 repro S2 split', 'waiting_payment',
        'work_in_progress', 'resolved', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, currency, total_amount,
   status, platform_fee_rate, platform_fee_amount)
VALUES ('c2cccccc-cccc-cccc-cccc-cccccccccccc', 'b2bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'a2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        NULL, 'EUR', 1000.00, 'partially_released', 0.0900, 90.00);
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status, released_at, external_payout_ref)
VALUES ('21111111-1111-1111-1111-111111111111', 'c2cccccc-cccc-cccc-cccc-cccccccccccc',
        'deposit_release', 25.00, 250.00, 'work_started', 'released', now(), 'po_s2_deposit');
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
VALUES ('22222222-2222-2222-2222-222222222222', 'c2cccccc-cccc-cccc-cccc-cccccccccccc',
        'final_release', 75.00, 750.00, 'work_completed', 'funded');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('d2dddddd-dddd-dddd-dddd-dddddddddddd', 'a2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'disputed', 'pi_s2', 1000.00, 1000.00, 'eur');
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('e2eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'a2aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'split', 'split', 'pending', 'work_quality', 'B4 S2 split', now());

-- ── S3: MULTI-DISPUTE — second settle must NOT re-count the refunded tranche ──
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'B4 repro S3 multi', 'waiting_payment',
        'work_in_progress', 'resolved', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.escrow_payment_plans
  (id, source_offer_id, job_id, customer_user_id, provider_id, currency, total_amount,
   status, platform_fee_rate, platform_fee_amount)
VALUES ('c3cccccc-cccc-cccc-cccc-cccccccccccc', 'b3bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333',
        NULL, 'EUR', 1000.00, 'partially_released', 0.0900, 90.00);
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status, released_at, external_payout_ref)
VALUES ('31111111-1111-1111-1111-111111111111', 'c3cccccc-cccc-cccc-cccc-cccccccccccc',
        'deposit_release', 25.00, 250.00, 'work_started', 'released', now(), 'po_s3_deposit');
INSERT INTO public.escrow_tranches
  (id, plan_id, kind, percentage, amount, release_trigger, status)
VALUES ('32222222-2222-2222-2222-222222222222', 'c3cccccc-cccc-cccc-cccc-cccccccccccc',
        'final_release', 75.00, 750.00, 'work_completed', 'funded');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('d3dddddd-dddd-dddd-dddd-dddddddddddd', 'a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'disputed', 'pi_s3', 1000.00, 1000.00, 'eur');
-- TWO resolved+pending splits on the SAME job (non-active statuses are not blocked
-- by the active-unique index → a job can carry >1).
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('e3aaaaaa-eeee-eeee-eeee-eeeeeeeeeeee', 'a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'split', 'split', 'pending', 'work_quality', 'B4 S3 split A', now() - interval '2 hours');
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('e3bbbbbb-eeee-eeee-eeee-eeeeeeeeeeee', 'a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'split', 'split', 'pending', 'work_quality', 'B4 S3 split B', now() - interval '1 hour');

SELECT set_config('session_replication_role', 'origin', true);  -- triggers ON for the real RPCs

-- ── Run the real generalized settler (service-role / owner context) ──────────
SELECT public.settle_dispute_resolution('e1eeeeee-eeee-eeee-eeee-eeeeeeeeeeee');  -- S1 release
SELECT public.settle_dispute_resolution('e2eeeeee-eeee-eeee-eeee-eeeeeeeeeeee');  -- S2 split
SELECT public.settle_dispute_resolution('e3aaaaaa-eeee-eeee-eeee-eeeeeeeeeeee');  -- S3 first
SELECT public.settle_dispute_resolution('e3bbbbbb-eeee-eeee-eeee-eeeeeeeeeeee');  -- S3 second

-- ── Assertions ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- S1
  v_s1_set    text; v_s1_held  text; v_s1_dep   text; v_s1_led   int;
  v_s1_pay    text;
  -- S2
  v_s2_set    text; v_s2_held  text; v_s2_dep   text;
  v_s2_led    int;  v_s2_type  text; v_s2_amt   numeric; v_s2_src text;
  v_s2_pay    text;
  -- S3
  v_s3a_set   text; v_s3b_set  text;
  v_s3_led_a  int;  v_s3_led_b int;  v_s3_led_total int; v_s3_refunded int;
BEGIN
  -- ===== S1 · RELEASE: pure settlement flip, held tranche untouched =====
  SELECT settlement_status INTO v_s1_set FROM public.disputes
    WHERE id = 'e1eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT status INTO v_s1_held FROM public.escrow_tranches
    WHERE id = '12222222-2222-2222-2222-222222222222';
  SELECT status INTO v_s1_dep  FROM public.escrow_tranches
    WHERE id = '11111111-1111-1111-1111-111111111111';
  SELECT status INTO v_s1_pay  FROM public.payments
    WHERE id = 'd1dddddd-dddd-dddd-dddd-dddddddddddd';
  SELECT count(*) INTO v_s1_led FROM public.ledger_entries
    WHERE dispute_id = 'e1eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  IF v_s1_set IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S1]: settlement_status expected settled, got %', v_s1_set;
  END IF;
  IF v_s1_held IS DISTINCT FROM 'funded' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S1]: release must NOT refund the held tranche — expected funded, got %', v_s1_held;
  END IF;
  IF v_s1_dep IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S1]: deposit expected released (untouched), got %', v_s1_dep;
  END IF;
  IF v_s1_led IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S1]: release must write NO ledger row, got % rows', v_s1_led;
  END IF;
  IF v_s1_pay IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S1]: payment expected disputed (G6=B untouched), got %', v_s1_pay;
  END IF;

  -- ===== S2 · SPLIT: held-only refund, one refund_partial, live SUM =====
  SELECT settlement_status INTO v_s2_set FROM public.disputes
    WHERE id = 'e2eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT status INTO v_s2_held FROM public.escrow_tranches
    WHERE id = '22222222-2222-2222-2222-222222222222';
  SELECT status INTO v_s2_dep  FROM public.escrow_tranches
    WHERE id = '21111111-1111-1111-1111-111111111111';
  SELECT status INTO v_s2_pay  FROM public.payments
    WHERE id = 'd2dddddd-dddd-dddd-dddd-dddddddddddd';
  SELECT count(*), max(entry_type), max(amount), max(metadata->>'source')
    INTO v_s2_led, v_s2_type, v_s2_amt, v_s2_src
    FROM public.ledger_entries WHERE dispute_id = 'e2eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  IF v_s2_set IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: settlement_status expected settled, got %', v_s2_set;
  END IF;
  IF v_s2_held IS DISTINCT FROM 'refunded' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: held final tranche expected refunded, got %', v_s2_held;
  END IF;
  IF v_s2_dep IS DISTINCT FROM 'released' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: deposit expected released (untouched), got %', v_s2_dep;
  END IF;
  IF v_s2_led IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: expected exactly 1 refund_partial row, got %', v_s2_led;
  END IF;
  IF v_s2_type IS DISTINCT FROM 'refund_partial' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: ledger entry_type expected refund_partial, got %', v_s2_type;
  END IF;
  IF v_s2_amt IS DISTINCT FROM 750.00 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: ledger amount expected 750.00 (live held SUM), got %', v_s2_amt;
  END IF;
  IF v_s2_src IS DISTINCT FROM 'corridor_resolution' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: ledger source expected corridor_resolution (no snapshot), got %', v_s2_src;
  END IF;
  IF v_s2_pay IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S2]: payment expected disputed (G6=B untouched), got %', v_s2_pay;
  END IF;

  -- ===== S3 · MULTI-DISPUTE: second settle re-counts NOTHING =====
  SELECT settlement_status INTO v_s3a_set FROM public.disputes
    WHERE id = 'e3aaaaaa-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT settlement_status INTO v_s3b_set FROM public.disputes
    WHERE id = 'e3bbbbbb-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT count(*) INTO v_s3_led_a FROM public.ledger_entries
    WHERE dispute_id = 'e3aaaaaa-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT count(*) INTO v_s3_led_b FROM public.ledger_entries
    WHERE dispute_id = 'e3bbbbbb-eeee-eeee-eeee-eeeeeeeeeeee';
  SELECT count(*), COALESCE(sum(CASE WHEN entry_type = 'refund_partial' THEN 1 ELSE 0 END), 0)
    INTO v_s3_led_total, v_s3_refunded
    FROM public.ledger_entries WHERE job_id = 'a3aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  IF v_s3a_set IS DISTINCT FROM 'settled' OR v_s3b_set IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S3]: both disputes expected settled, got A=% B=%', v_s3a_set, v_s3b_set;
  END IF;
  IF v_s3_led_a IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S3]: first settle expected 1 refund_partial, got %', v_s3_led_a;
  END IF;
  IF v_s3_led_b IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S3]: second settle must re-count NOTHING (live SUM excludes refunded) — expected 0 rows, got %', v_s3_led_b;
  END IF;
  IF v_s3_refunded IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'ASSERT_FAILED [S3]: job total refund_partial rows expected 1 (no double-count), got %', v_s3_refunded;
  END IF;

  RAISE NOTICE '------------------------------------------------------------------';
  RAISE NOTICE 'REPRO PASSED — all 3 settle_dispute_resolution invariants hold:';
  RAISE NOTICE '  S1 release: held tranche=% (NOT refunded) · ledger rows=% · dispute=%', v_s1_held, v_s1_led, v_s1_set;
  RAISE NOTICE '  S2 split:   held=% deposit=% · ledger=% amount=% src=% · dispute=%', v_s2_held, v_s2_dep, v_s2_type, v_s2_amt, v_s2_src, v_s2_set;
  RAISE NOTICE '  S3 multi:   1st rows=% · 2nd rows=% · job refund_partial total=% (no double-count)', v_s3_led_a, v_s3_led_b, v_s3_refunded;
  RAISE NOTICE '------------------------------------------------------------------';

  -- Final RAISE = rollback (nothing persists). Distinct sentinel so the operator
  -- can tell "passed + rolled back" from a real ASSERT_FAILED above.
  RAISE EXCEPTION 'REPRO_ROLLBACK_SENTINEL: success, aborting tx (no data persisted)';
END;
$$;

-- Belt-and-braces: the DO block already aborted the tx; unreachable but guarantees
-- no persistence if the sentinel is ever removed.
ROLLBACK;

-- =============================================================================
-- DEADLOCK TEST CONCEPT (2 sessions — run manually, NOT here)
-- Proves the G2 lock order holds for the Batch-4 settler too: Dispute → Plan →
-- Tranche, matching complete_tranche_payout's Plan → Tranche suffix.
-- -----------------------------------------------------------------------------
-- Setup (committed): a plan with the deposit tranche 'release_pending' (a
--   payout.paid about to complete it) AND a resolved+split dispute on the SAME
--   plan (settlement_status='pending').
--
-- Session A:  BEGIN; SELECT public.complete_tranche_payout('<deposit_tranche>','po_x');  -- no commit
-- Session B:  BEGIN; SELECT public.settle_dispute_resolution('<dispute>');               -- no commit
--
-- POST-FIX: settle_dispute_resolution locks disputes FOR UPDATE, then
--   escrow_payment_plans FOR UPDATE, then the tranches; complete_tranche_payout
--   locks Plan then Tranche. No process holds a tranche lock while waiting for the
--   plan lock → no ABBA cycle → NO 40P01 deadlock. Both serialize on the plan lock;
--   the just-released tranche is excluded from the held predicate either way.
-- =============================================================================
