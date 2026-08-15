-- =============================================================================
-- Block P5 — payments FSM + authority hardening (THE FUND: payee self-release)
-- =============================================================================
-- Project: SaFix backend (ref itdntawwuzqfwmcwnwjr), Postgres 17.
--
-- WHAT THIS CLOSES
--   public.payments has membership-only RLS (customer/craftsman/provider) and a
--   direct `authenticated` UPDATE grant, with NO status/FSM/authority guard.
--   => a craftsman (craftsman_user_id = auth.uid(), the PAYEE) can
--        UPDATE payments SET status = 'released' WHERE job_id = <their job>
--      straight through PostgREST and self-release the DB money-state.
--   The only trigger on payments was set_payments_updated_at (pure updated_at).
--
-- REMEDIATION (single DB-level chokepoint over EVERY client-direct path):
--   1. BEFORE-UPDATE trigger enforce_payment_fsm() on public.payments:
--        - service_role / webhooks / crons / migrations (auth.uid() IS NULL) bypass.
--        - trusted SECDEF RPCs bypass via sentinel GUC app.payment_fsm_bypass='on'
--          (a BEFORE trigger STILL fires under SECURITY DEFINER and auth.uid()
--           stays the CALLER uid, so a legit customer-run release RPC would
--           otherwise be blocked — the sentinel is the documented escape hatch).
--        - non-status updates (linkage / refunded_amount / updated_at / stripe ids)
--          pass untouched.
--        - canonical FSM transitions enforced ONLY when BOTH old+new are in the
--          canonical escrow map; legacy CHECK-only states (authorized / captured /
--          escrowed / partially_refunded / failed / cancelled / pending /
--          requires_* / processing) are NOT in the map and are NOT hard-blocked,
--          so legacy Stripe-ish webhook writes keep working.
--        - AUTHORITY: the PAYEE (payments.craftsman_user_id, or provider via
--          providers.profile_id) may NEVER drive status into 'released'/'refunded'.
--          Forward escrow steps + dispute-open stay client-writable for any
--          participant (incl. the craftsman starting/finishing work); only the
--          two money-terminal writes are payee-blocked. The non-payee customer
--          stays able to write released/refunded client-direct (their own money),
--          but only along FSM-legal edges — see authorityMatrix.
--        - every identity compare is NULL-guarded (col IS NOT NULL AND col = uid):
--          customer_profile_id / customer_user_id / craftsman_user_id are NULLABLE
--          and `IF NOT(... OR uid = NULL ...)` is silently bypassable (3-valued
--          logic). Ownership is read from OLD, never NEW.
--   2. Grant cleanup on public.payments (anon footgun incl. RLS-bypassing TRUNCATE).
--   3. finalize_payment_state_atomic rewrite: fix every uuid=text cast (DEAD live),
--      restrict RELEASE/REFUND authority to customer/operator/system (NOT the payee
--      craftsman), SET LOCAL the bypass sentinel for its own UPDATE, and add a
--      timeline_signals audit row so direct RPC finalizations are not un-audited.
--
-- RECONCILED AGAINST LIVE PROD 2026-06-17 (read-only information_schema/pg_proc):
--   jobs.id uuid · jobs.customer_user_id uuid · jobs.customer_profile_id uuid
--   jobs.craftsman_user_id TEXT (the task brief's "uuid" was wrong) · jobs.project_id TEXT
--   payments.job_id uuid · payments.craftsman_user_id/customer_user_id/customer_profile_id/provider_id uuid
--   projects.id uuid · disputes.id uuid · disputes.job_id uuid · providers.id/profile_id uuid
--   is_current_user_operator() exists (SECDEF, no args) · timeline_signals(id text,
--   job_id uuid NOT NULL, type text, occurred_at bigint, entity_id text).
--
-- Fully idempotent + transaction-safe (CREATE OR REPLACE / DROP..IF EXISTS /
-- idempotent REVOKE/GRANT). Safe to behaviorally repro inside an aborted tx.
-- NOT applied to prod by this file.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Canonical FSM helpers (pure logic mirror of src/lib/payments/stateMachine.ts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payment_fsm_is_canonical(p_state text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT p_state = ANY (ARRAY[
    'none','deposit_required','deposit_paid','in_escrow','work_in_progress',
    'release_pending','released','disputed','refunded',
    'diagnosis_payment_pending','diagnosis_payment_completed'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.payment_fsm_is_allowed(p_from text, p_to text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT CASE p_from
    WHEN 'none'                         THEN p_to IN ('deposit_required')
    WHEN 'deposit_required'             THEN p_to IN ('deposit_paid')
    WHEN 'deposit_paid'                 THEN p_to IN ('in_escrow','refunded')
    WHEN 'in_escrow'                    THEN p_to IN ('work_in_progress','disputed','refunded')
    WHEN 'work_in_progress'             THEN p_to IN ('release_pending','disputed')
    WHEN 'release_pending'              THEN p_to IN ('released','disputed','refunded')
    WHEN 'released'                     THEN false  -- terminal
    WHEN 'disputed'                     THEN p_to IN ('refunded','released','release_pending')
    WHEN 'refunded'                     THEN false  -- terminal
    WHEN 'diagnosis_payment_pending'    THEN p_to IN ('diagnosis_payment_completed','refunded')
    WHEN 'diagnosis_payment_completed'  THEN false  -- terminal
    ELSE true  -- non-canonical from-state: never reached (caller gates on canonicality)
  END;
$$;

REVOKE ALL ON FUNCTION public.payment_fsm_is_canonical(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.payment_fsm_is_allowed(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_fsm_is_canonical(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.payment_fsm_is_allowed(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. BEFORE-UPDATE FSM + terminal client-lockdown trigger (P5b — MED#1 + MED#4)
-- ---------------------------------------------------------------------------
-- Mirrors the LIVE prod enforce_payment_fsm body (migration p5b, applied as
-- ledger version 20260620234605). The baseline file keeps its "p5" name for the
-- quality-gates.yml `cp` reference, but carries the P5b lockdown so the pgTAP
-- gate (10_payments_fsm_authority_guard.sql) runs against the real prod guard.
-- SECURITY DEFINER (owner postgres) for parity with finalize + zero behavioral
-- change to the bypass / NULL-uid fast paths. P5b no longer reads
-- public.providers: the payee-only authority arm is subsumed by the
-- identity-agnostic terminal lockdown (4a), so NO authenticated client may drive
-- a money terminal directly.
CREATE OR REPLACE FUNCTION public.enforce_payment_fsm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_uid uuid  := auth.uid();
  v_old text  := OLD.status;
  v_new text  := NEW.status;
BEGIN
  -- (1) service_role / system: webhooks, crons, migrations, seeds.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- (2) trusted SECDEF RPC sentinel — set ONLY by finalize_payment_state_atomic.
  IF current_setting('app.payment_fsm_bypass', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- (3) non-status update (linkage / refunded_amount / updated_at / stripe ids).
  IF v_new IS NOT DISTINCT FROM v_old THEN
    RETURN NEW;
  END IF;

  -- (4a) MED#1 — money-terminal lockdown. No authenticated client may drive a
  --      payment to 'released'/'refunded' directly; the legitimate terminal path
  --      is finalize_payment_state_atomic (step 2 sentinel) or a service_role
  --      webhook/cron (step 1). Subsumes the old payee-only authority guard
  --      (same 42501) and additionally blocks the non-payee customer + any
  --      legacy-hop INTO a terminal (only v_new matters here).
  IF v_new IN ('released', 'refunded') THEN
    RAISE EXCEPTION
      'payment_terminal_requires_rpc: payment % may not be driven to ''%'' by a direct client write — use finalize_payment_state_atomic / the release-refund RPC',
      OLD.id, v_new
      -- 42501 (insufficient_privilege): mirrors the P5 payee guard's errcode.
      USING ERRCODE = '42501';
  END IF;

  -- (4b) MED#4 — canonical-terminal immutability. No authenticated client may move
  --      a payment OUT of a canonical terminal ('released'/'refunded'), including
  --      via a legacy / non-canonical NEW status (the legacy-hop ESCAPE direction).
  IF public.payment_fsm_is_canonical(v_old)
     AND v_old IN ('released', 'refunded') THEN
    RAISE EXCEPTION
      'payment_terminal_immutable: payment % is terminal (''%'') and may not be moved by a client write (attempted -> ''%'')',
      OLD.id, v_old, v_new
      -- 23514 (check_violation) → classifyFailure class 23 = 'business-rejected'.
      USING ERRCODE = '23514';
  END IF;

  -- (4c) Canonical FSM guard for the remaining authenticated forward transitions.
  --      Enforced ONLY when BOTH sides are canonical so legacy Stripe-ish writes
  --      stay working. released/refunded are fully handled by 4a/4b above.
  IF public.payment_fsm_is_canonical(v_old)
     AND public.payment_fsm_is_canonical(v_new)
     AND NOT public.payment_fsm_is_allowed(v_old, v_new) THEN
    RAISE EXCEPTION
      'payment_fsm_illegal_transition: % -> % is not an allowed payment transition (payment %)',
      v_old, v_new, OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_payment_fsm() FROM PUBLIC, anon;
-- Owner = postgres for parity with finalize (P5b reads no providers row).
ALTER FUNCTION public.enforce_payment_fsm() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_payment_fsm_tg ON public.payments;
CREATE TRIGGER enforce_payment_fsm_tg
  BEFORE UPDATE ON public.payments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.enforce_payment_fsm();

-- ---------------------------------------------------------------------------
-- 2. Grant cleanup on public.payments
-- ---------------------------------------------------------------------------
-- anon: NO policy targets anon and NO unauthenticated payments path exists in
-- the app, so every anon grant is dead — except TRUNCATE, which BYPASSES RLS
-- and would let any anon SQL path wipe the money table. Revoke the lot.
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.payments FROM anon;

-- authenticated: keep SELECT + INSERT (client repo.add() create path) + UPDATE
-- (now trigger-guarded). DELETE has no RLS policy (already dead) and TRUNCATE
-- bypasses RLS — neither is ever a legitimate client op on the money table.
REVOKE DELETE, TRUNCATE ON public.payments FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. finalize_payment_state_atomic — corrected rewrite
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_payment_state_atomic(
  p_job_id          text,
  p_target_state    text,
  p_dispute_id      text DEFAULT NULL::text,
  p_actor           text DEFAULT 'system'::text,
  p_refunded_amount numeric DEFAULT NULL::numeric
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_payment_id     uuid;
  v_payment_status text;
  v_project_id     text;
  v_now            timestamptz := clock_timestamp();
BEGIN
  -- ── 1. Validate target state parameter ────────────────────────────────────
  IF p_target_state NOT IN ('released', 'refunded') THEN
    RAISE EXCEPTION 'invalid_target_state: % is not a terminal payment state (released | refunded)',
      p_target_state
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 2. Lock payment row (FIX: payments.job_id is uuid) ────────────────────
  SELECT id, status
    INTO v_payment_id, v_payment_status
    FROM public.payments
   WHERE job_id = p_job_id::uuid
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment_not_found: no payment record for job %', p_job_id
      USING ERRCODE = 'P0002';
  END IF;

  -- ── 2b. Authorization (FIX: uuid casts; RESTRICT to customer/operator/system,
  --        never the payee craftsman). service_role (auth.uid() IS NULL) exempt.
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.is_current_user_operator() THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.jobs j
         WHERE j.id = p_job_id::uuid
           AND ( (j.customer_user_id   IS NOT NULL AND j.customer_user_id   = auth.uid())
              OR (j.customer_profile_id IS NOT NULL AND j.customer_profile_id = auth.uid()) )
      ) THEN
        RAISE EXCEPTION
          'unauthorized: only the job customer or an operator may finalize payment for job % (caller is not the customer)',
          p_job_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- ── 3. Idempotent guard ───────────────────────────────────────────────────
  IF v_payment_status = p_target_state THEN
    RETURN jsonb_build_object(
      'idempotent', TRUE,
      'state',      p_target_state,
      'paymentId',  v_payment_id
    );
  END IF;

  -- ── 4. State-machine validation ───────────────────────────────────────────
  IF p_target_state = 'released' AND v_payment_status NOT IN ('release_pending', 'disputed') THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to released (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_target_state = 'refunded' AND v_payment_status NOT IN (
    'deposit_paid', 'in_escrow', 'release_pending', 'disputed'
  ) THEN
    RAISE EXCEPTION 'invalid_transition: cannot finalize payment from % to refunded (job %)',
      v_payment_status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ── 5. Active-dispute guard (non-dispute release) ─────────────────────────
  IF p_target_state = 'released' AND p_dispute_id IS NULL THEN
    IF EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE job_id = p_job_id::uuid
         AND status IN ('open', 'awaiting_evidence', 'under_review')
    ) THEN
      RAISE EXCEPTION 'release_blocked_by_dispute: active dispute exists for job % — resolve before releasing',
        p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 5b. Validate supplied dispute_id (FIX: disputes.id/job_id are uuid) ───
  IF p_dispute_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.disputes
       WHERE id     = p_dispute_id::uuid
         AND job_id = p_job_id::uuid
    ) THEN
      RAISE EXCEPTION 'invalid_dispute_id: dispute % does not exist or does not belong to job %',
        p_dispute_id, p_job_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ── 5c. Sentinel: this RPC has done its own authz above; let its own UPDATE
  --        pass the BEFORE-UPDATE FSM/authority trigger (which still fires under
  --        SECURITY DEFINER with auth.uid() = caller). LOCAL = this tx only.
  PERFORM set_config('app.payment_fsm_bypass', 'on', true);

  -- ── 6. Update payments (FIX: uuid cast) ───────────────────────────────────
  UPDATE public.payments
     SET status          = p_target_state,
         refunded_amount = COALESCE(p_refunded_amount, refunded_amount),
         updated_at      = v_now
   WHERE job_id = p_job_id::uuid;

  -- ── 7. Update jobs: payment_state + status (waiting_payment → completed) ──
  UPDATE public.jobs
     SET payment_state = p_target_state,
         status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
         updated_at    = v_now
   WHERE id = p_job_id::uuid;

  -- ── 8. Update linked project (jobs.project_id is text; projects.id is uuid) ─
  SELECT project_id
    INTO v_project_id
    FROM public.jobs
   WHERE id = p_job_id::uuid;

  IF v_project_id IS NOT NULL AND v_project_id <> '' THEN
    -- jobs.project_id is TEXT and prod holds legacy non-UUID values (e.g.
    -- 'proj-review-001'); compare id::text so a malformed project_id is a
    -- no-op match instead of a 22P02 that aborts the whole release.
    UPDATE public.projects
       SET payment_state = p_target_state,
           updated_at    = v_now
     WHERE id::text = v_project_id;
  END IF;

  -- ── 8b. Audit: append a timeline signal so direct RPC finalizations are not
  --        un-audited (mirrors the timeline_signals (id,job_id,type,occurred_at,
  --        entity_id) shape; id defaults to gen_random_uuid()::text).
  INSERT INTO public.timeline_signals (job_id, type, occurred_at, entity_id)
  VALUES (
    p_job_id::uuid,
    'payment_' || p_target_state,                       -- payment_released | payment_refunded
    (EXTRACT(EPOCH FROM v_now) * 1000)::bigint,
    v_payment_id::text
  );

  -- ── 8c. Close the bypass window: the sentinel is LOCAL (transaction-scoped),
  --        so reset it to 'off' now that the RPC's own writes are done. In prod
  --        each PostgREST RPC is its own tx (the GUC dies with the request), but
  --        resetting keeps the bypass scoped to exactly this RPC's UPDATEs and
  --        is robust under a multi-statement aborted-tx repro.
  PERFORM set_config('app.payment_fsm_bypass', 'off', true);

  -- ── 9. Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'idempotent',  FALSE,
    'state',       p_target_state,
    'paymentId',   v_payment_id,
    'jobId',       p_job_id,
    'projectId',   v_project_id,
    'actor',       p_actor,
    'finalizedAt', (EXTRACT(EPOCH FROM v_now) * 1000)::bigint
  );
END;
$$;

ALTER FUNCTION public.finalize_payment_state_atomic(text, text, text, text, numeric) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.finalize_payment_state_atomic(text, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_payment_state_atomic(text, text, text, text, numeric) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Refresh PostgREST schema cache (avoid stale-cache 'schema is invalid')
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
