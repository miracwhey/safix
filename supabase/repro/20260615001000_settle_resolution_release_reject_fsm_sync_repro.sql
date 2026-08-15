-- =============================================================================
-- BEHAVIORAL REPRO (aborted-tx) — Block P · #6 release/reject FSM sync
-- Migration under test: supabase/migrations/20260615001000_p_settle_resolution_release_reject_fsm_sync.sql
--   (apply 20260614070000 first, then this — both CREATE OR REPLACE settle_dispute_resolution).
-- =============================================================================
-- WHAT THIS PROVES (behavioral, prod-schema-faithful — NOT review-by-reading):
--   settle_dispute_resolution now converges the payment FSM for RELEASE/REJECT, and
--   still leaves REFUND on Option B:
--     R (release): dispute pending→settled; payments disputed→released;
--        jobs payment_state→released + status waiting_payment→completed;
--        projects payment_state→released (project_id set).
--     J (reject):  same FSM sync; project_id empty/unset (jobs.project_id NOT NULL
--        DEFAULT '') → project step skipped by the `<> ''` guard, no error.
--     F (refund):  dispute pending→settled; payments STAYS disputed; jobs STAYS
--        payment_state=disputed (Option B — refund not FSM-synced).
--     I (idempotent): a 2nd settle of R is a no-op (still settled/released).
--
-- HOW / WHEN TO RUN — read before executing:
--   * ONLY against a prod-near DB with 20260614070000 + 20260615001000 APPLIED.
--     APPLY-TIME GATE — not run in the build harness (no DB there).
--   * Command:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--               supabase/repro/20260615001000_settle_resolution_release_reject_fsm_sync_repro.sql
--   * Expected terminal output: a NOTICE block ending with
--       "REPRO PASSED — all release/reject FSM-sync invariants hold" then the
--       deliberate 'REPRO_ROLLBACK_SENTINEL' ERROR that aborts the transaction.
--     Any "ASSERT_FAILED: ..." ERROR before the sentinel = the sync regressed.
--   * NOTHING PERSISTS: one transaction, rolled back by the final RAISE + ROLLBACK.
--
-- SEEDING NOTE: seed runs with session_replication_role='replica' (skip FK/triggers;
--   no offers/profiles graph needed). Reset to 'origin' BEFORE the RPC calls so the
--   real settle runs with triggers active (disputes_status_change_guard +
--   jobs_terminal_status_guard admit the service-role write via auth.uid() IS NULL).
--   No escrow plan/tranche needed: release/reject set v_refund_minor=0, so the held
--   predicate is never exercised. Requires DB-owner / superuser.
-- =============================================================================

BEGIN;

SELECT set_config('session_replication_role', 'replica', true);  -- seed only

-- ── R: RELEASE — full payment-FSM sync incl. project ─────────────────────────
INSERT INTO public.projects (id, payment_state)
VALUES ('69999999-9999-9999-9999-999999999999', 'disputed');
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id, project_id)
VALUES ('61111111-1111-1111-1111-111111111111', '#6 repro R release', 'waiting_payment',
        'disputed', 'resolved', '44444444-4444-4444-4444-444444444444',
        '69999999-9999-9999-9999-999999999999');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('62222222-2222-2222-2222-222222222222', '61111111-1111-1111-1111-111111111111',
        'disputed', 'pi_r', 1000.00, 1000.00, 'eur');
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('63333333-3333-3333-3333-333333333333', '61111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'release', 'release_full', 'pending', 'work_quality', '#6 R release', now());

-- ── J: REJECT — FSM sync, project_id empty (default '') → project step skipped ─
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('64444444-4444-4444-4444-444444444444', '#6 repro J reject', 'waiting_payment',
        'disputed', 'resolved', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('65555555-5555-5555-5555-555555555555', '64444444-4444-4444-4444-444444444444',
        'disputed', 'pi_j', 1000.00, 1000.00, 'eur');
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('66666666-6666-6666-6666-666666666666', '64444444-4444-4444-4444-444444444444',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'reject', 'rejected', 'pending', 'work_quality', '#6 J reject', now());

-- ── F: REFUND — Option B, NO payment-FSM sync ────────────────────────────────
INSERT INTO public.jobs (id, title, status, payment_state, dispute_status, craftsman_user_id)
VALUES ('67777777-7777-7777-7777-777777777777', '#6 repro F refund', 'waiting_payment',
        'disputed', 'resolved', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.payments (id, job_id, status, provider_ref, total_amount, amount_total, currency)
VALUES ('68888888-8888-8888-8888-888888888888', '67777777-7777-7777-7777-777777777777',
        'disputed', 'pi_f', 1000.00, 1000.00, 'eur');
INSERT INTO public.disputes
  (id, job_id, customer_profile_id, provider_id, status, decision, resolution_type,
   settlement_status, reason, description, opened_at)
VALUES ('6a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '67777777-7777-7777-7777-777777777777',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        'resolved', 'refund', 'refund_full', 'pending', 'work_quality', '#6 F refund', now());

SELECT set_config('session_replication_role', 'origin', true);   -- triggers back on

DO $$
DECLARE
  v_pay   text; v_js text; v_jps text; v_proj text; v_set text;
BEGIN
  -- ── R: release ─────────────────────────────────────────────────────────────
  PERFORM public.settle_dispute_resolution('63333333-3333-3333-3333-333333333333');
  SELECT settlement_status INTO v_set FROM public.disputes WHERE id='63333333-3333-3333-3333-333333333333';
  SELECT status INTO v_pay FROM public.payments WHERE id='62222222-2222-2222-2222-222222222222';
  SELECT status, payment_state INTO v_js, v_jps FROM public.jobs WHERE id='61111111-1111-1111-1111-111111111111';
  SELECT payment_state INTO v_proj FROM public.projects WHERE id='69999999-9999-9999-9999-999999999999';
  IF v_set  <> 'settled'   THEN RAISE EXCEPTION 'ASSERT_FAILED [R]: dispute settlement_status=% (want settled)', v_set; END IF;
  IF v_pay  <> 'released'  THEN RAISE EXCEPTION 'ASSERT_FAILED [R]: payments.status=% (want released)', v_pay; END IF;
  IF v_jps  <> 'released'  THEN RAISE EXCEPTION 'ASSERT_FAILED [R]: jobs.payment_state=% (want released)', v_jps; END IF;
  IF v_js   <> 'completed' THEN RAISE EXCEPTION 'ASSERT_FAILED [R]: jobs.status=% (want completed)', v_js; END IF;
  IF v_proj <> 'released'  THEN RAISE EXCEPTION 'ASSERT_FAILED [R]: projects.payment_state=% (want released)', v_proj; END IF;

  -- ── I: idempotent — second settle of R is a no-op, no error ─────────────────
  PERFORM public.settle_dispute_resolution('63333333-3333-3333-3333-333333333333');
  SELECT status INTO v_pay FROM public.payments WHERE id='62222222-2222-2222-2222-222222222222';
  SELECT settlement_status INTO v_set FROM public.disputes WHERE id='63333333-3333-3333-3333-333333333333';
  IF v_pay <> 'released' OR v_set <> 'settled' THEN
    RAISE EXCEPTION 'ASSERT_FAILED [I]: second settle changed state (payment=%, dispute=%)', v_pay, v_set;
  END IF;

  -- ── J: reject — FSM sync, project_id NULL path must not error ───────────────
  PERFORM public.settle_dispute_resolution('66666666-6666-6666-6666-666666666666');
  SELECT settlement_status INTO v_set FROM public.disputes WHERE id='66666666-6666-6666-6666-666666666666';
  SELECT status INTO v_pay FROM public.payments WHERE id='65555555-5555-5555-5555-555555555555';
  SELECT status, payment_state INTO v_js, v_jps FROM public.jobs WHERE id='64444444-4444-4444-4444-444444444444';
  IF v_set <> 'settled'   THEN RAISE EXCEPTION 'ASSERT_FAILED [J]: dispute settlement_status=% (want settled)', v_set; END IF;
  IF v_pay <> 'released'  THEN RAISE EXCEPTION 'ASSERT_FAILED [J]: payments.status=% (want released)', v_pay; END IF;
  IF v_jps <> 'released'  THEN RAISE EXCEPTION 'ASSERT_FAILED [J]: jobs.payment_state=% (want released)', v_jps; END IF;
  IF v_js  <> 'completed' THEN RAISE EXCEPTION 'ASSERT_FAILED [J]: jobs.status=% (want completed)', v_js; END IF;

  -- ── F: refund — Option B, payment + job NOT synced ──────────────────────────
  PERFORM public.settle_dispute_resolution('6a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  SELECT settlement_status INTO v_set FROM public.disputes WHERE id='6a000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  SELECT status INTO v_pay FROM public.payments WHERE id='68888888-8888-8888-8888-888888888888';
  SELECT payment_state INTO v_jps FROM public.jobs WHERE id='67777777-7777-7777-7777-777777777777';
  IF v_set <> 'settled'  THEN RAISE EXCEPTION 'ASSERT_FAILED [F]: dispute settlement_status=% (want settled)', v_set; END IF;
  IF v_pay <> 'disputed' THEN RAISE EXCEPTION 'ASSERT_FAILED [F]: payments.status=% (Option B — want disputed, NOT synced)', v_pay; END IF;
  IF v_jps <> 'disputed' THEN RAISE EXCEPTION 'ASSERT_FAILED [F]: jobs.payment_state=% (Option B — want disputed, NOT synced)', v_jps; END IF;

  RAISE NOTICE '------------------------------------------------------------------';
  RAISE NOTICE 'REPRO PASSED — all release/reject FSM-sync invariants hold:';
  RAISE NOTICE '  R release: dispute=settled, payment=released, job=released/completed, project=released';
  RAISE NOTICE '  J reject:  dispute=settled, payment=released, job=released/completed (empty project_id skipped)';
  RAISE NOTICE '  F refund:  dispute=settled, payment=disputed, job=disputed (Option B, no FSM sync)';
  RAISE NOTICE '  I idempotent: second release settle = no-op';
  RAISE NOTICE '------------------------------------------------------------------';

  RAISE EXCEPTION 'REPRO_ROLLBACK_SENTINEL: success, aborting tx (no data persisted)';
END;
$$;

-- Belt-and-braces: the DO block already aborted the tx.
ROLLBACK;
