-- =============================================================================
-- P4 Teil A: settle_consensus_split + trigger hardening + P4B dormancy lock
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- Sequenced AFTER 20260614010000_p4b_dispute_split_proposals.sql.
-- DO NOT APPLY without explicit user confirm.
--
-- Pre-apply state (after P4B is applied):
--   disputes_status_change_guard has the P4B sentinel (app.p4b_split_consensus_commit).
--   propose_split_atomic / confirm_split_proposal / reject_split_proposal are
--   GRANTed EXECUTE to authenticated (P4B shipped them granted — that is the hole
--   this migration closes via the dormancy block in part 3).
--
-- What this migration does:
--   1. settle_consensus_split(uuid) — SECDEF RPC, service_role ONLY (launch-gated,
--      NOT authenticated yet). Idempotent on already-settled disputes.
--   2. Recreate disputes_status_change_guard — preserves all P4B branches verbatim,
--      inserts one new P4A settle sentinel branch (narrowly scoped: only
--      settlement_status pending→settled, all other lifecycle fields unchanged).
--   3. Dormancy: REVOKE EXECUTE on P4B functions from authenticated — closes the
--      Teil-B hole so no authenticated user can create accepted-proposal rows or
--      resolve a dispute as split until the feature flag is flipped.
--   4. NOTIFY pgrst, 'reload schema'.
--
-- SENTINEL PATTERN (feedback_secdef_rpc_no_trigger_guard_bypass):
--   SECURITY DEFINER preserves auth.uid() as the caller's JWT claim.
--   disputes_status_change_guard (BEFORE UPDATE) fires for the caller's uid and
--   raises for non-operators. Fix: settle_consensus_split calls
--   set_config('app.p4b_split_settle_commit','allow', true) immediately before the
--   disputes UPDATE. The new trigger branch admits ONLY a pending→settled flip when
--   this sentinel is armed — any broader lifecycle change still raises.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. settle_consensus_split(p_dispute_id uuid)
-- ---------------------------------------------------------------------------
-- Called (by service layer) after money-movement is confirmed to mark the dispute
-- settlement as complete (settlement_status: pending → settled).
--
-- Party check mirrors confirm_split_proposal exactly — all three routes:
--   - customer:  disputes.customer_profile_id = auth.uid()
--   - provider:  providers.profile_id = auth.uid() via disputes.provider_id
--   - craftsman: jobs.craftsman_user_id::text = auth.uid()::text
--   - operator:  profiles.is_operator = true
--
-- Idempotent: if settlement_status is already 'settled', returns the row unchanged
-- with no error — safe to retry on transient failures.
CREATE OR REPLACE FUNCTION public.settle_consensus_split(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_status            text;
  v_decision          text;
  v_settlement_status text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_job_id            uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_operator       boolean     := false;
  v_is_party          boolean     := false;
  v_now               timestamptz := now();
  v_result            jsonb;
BEGIN
  -- Auth guard: anon callers have no JWT; auth.uid() would be NULL.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Lock dispute row for the duration of this transaction.
  -- Serializes concurrent settle calls on the same dispute.
  SELECT d.status, d.decision, d.settlement_status,
         d.customer_profile_id, d.provider_id, d.job_id
    INTO v_status, v_decision, v_settlement_status,
         v_customer_pid, v_provider_id, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Party check — customer side.
  -- NULL-poisoning guard (feedback_plpgsql_null_poisoning_authz_gate):
  -- three-valued-logic safe — explicit IS NOT NULL prevents (NULL = v_uid) from
  -- evaluating to NULL and silently bypassing the IF.
  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  -- Party check — craftsman/provider side.
  -- Mirrors confirm_split_proposal exactly: two sub-routes joined by OR.
  --   Route A: jobs.craftsman_user_id (TEXT) = auth.uid()::text — the mixed-model route.
  --   Route B: providers.profile_id = auth.uid() via disputes.provider_id (uuid FK).
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
     WHERE j.id = v_job_id
       AND (
             j.craftsman_user_id = v_uid::text
             OR (v_provider_id IS NOT NULL AND j.provider_id IN (
                   SELECT pr.id FROM public.providers pr
                    WHERE pr.profile_id = v_uid
                 ))
           )
  ) INTO v_is_provider;

  -- Operator check.
  SELECT COALESCE(p.is_operator, false)
    INTO v_is_operator
    FROM public.profiles p
   WHERE p.id = v_uid;

  v_is_party := v_is_customer OR v_is_provider OR v_is_operator;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', p_dispute_id
      USING ERRCODE = '42501';
  END IF;

  -- Require the dispute to be in the resolved/split state (precondition for settlement).
  IF v_status IS DISTINCT FROM 'resolved'
     OR v_decision IS DISTINCT FROM 'split'
  THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % has status=%, decision=%; '
                    'expected status=resolved and decision=split',
      p_dispute_id, COALESCE(v_status, 'null'), COALESCE(v_decision, 'null')
      USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent path: already settled — return the dispute row unchanged.
  -- No error: safe for workflow retries (feedback_agentic_loop_retry_reexecutes_side_effects).
  IF v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- Settlement_status must be 'pending' to proceed; any other value is unexpected.
  IF v_settlement_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % settlement_status=%, expected pending',
      p_dispute_id, COALESCE(v_settlement_status, 'null')
      USING ERRCODE = 'P0001';
  END IF;

  -- Arm settle sentinel — transaction-local (is_local=true = SET LOCAL semantics).
  -- Clears automatically on commit or rollback; cannot be pre-set by a client caller
  -- because each PostgREST RPC invocation runs in its own transaction.
  -- The sentinel is narrowly checked in disputes_status_change_guard: it admits ONLY
  -- a settlement_status pending→settled flip with all other lifecycle fields unchanged.
  PERFORM set_config('app.p4b_split_settle_commit', 'allow', true);

  UPDATE public.disputes
     SET settlement_status = 'settled',
         updated_at        = v_now
   WHERE id = p_dispute_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d WHERE d.id = p_dispute_id;

  RETURN v_result;
END;
$$;

-- GRANT: service_role only until CONSENSUS_SPLIT_ENABLED is flipped at launch.
-- Supabase ALTER DEFAULT PRIVILEGES grants EXECUTE directly to anon + authenticated
-- on every new public function, so REVOKE FROM PUBLIC alone leaves the authenticated
-- grant intact (feedback_supabase_function_anon_default_execute). Must name
-- authenticated explicitly or the settle RPC stays callable pre-launch.
-- See the LAUNCH RE-GRANT block below for the authenticated grant command.
REVOKE EXECUTE ON FUNCTION public.settle_consensus_split(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_consensus_split(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_consensus_split(uuid) IS
  'P4A: marks a consensus-split dispute settlement as complete (pending→settled). '
  'SECURITY DEFINER. service_role ONLY until CONSENSUS_SPLIT_ENABLED launch flag is set. '
  'Idempotent: already-settled disputes are returned unchanged without error. '
  'Uses app.p4b_split_settle_commit sentinel to pass disputes_status_change_guard '
  '(narrowly scoped: only settlement_status pending→settled, no other lifecycle change). '
  'LAUNCH RE-GRANT: GRANT EXECUTE ON FUNCTION public.settle_consensus_split(uuid) TO authenticated;';

-- ---------------------------------------------------------------------------
-- 2. Recreate disputes_status_change_guard — add P4A settle sentinel branch
-- ---------------------------------------------------------------------------
-- Preserved branches (verbatim from P4B state after 20260614010000 is applied):
--   (a) fast-path no-op when no protected field changed
--   (b) auth.uid() IS NULL → service_role internal write, admitted
--   (c) P4B sentinel: app.p4b_split_consensus_commit = 'allow'
--       → admits full confirm_split_proposal resolve write
-- New branch (P4A):
--   (d) P4A settle sentinel: app.p4b_split_settle_commit = 'allow'
--       → admitted ONLY when settlement_status flips pending→settled AND every
--         other lifecycle field (status, decision, resolution_type, split_ratio,
--         resolved_at, closed_at) is unchanged. Placing this AFTER branch (c)
--         means the broader consensus-commit path is tried first; the narrower
--         settle path is checked next. Any attempt to exploit the settle sentinel
--         to change status/decision/split_ratio is blocked by the strict conditions.
-- Unchanged branches:
--   (e) operator check
--   (f) RAISE 42501
--
-- The trigger registration (disputes_status_change_guard_tg, BEFORE UPDATE on disputes)
-- is unchanged and does not need to be recreated.
CREATE OR REPLACE FUNCTION public.disputes_status_change_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- (a) Fast path: nothing protected changed.
  IF NEW.status              IS NOT DISTINCT FROM OLD.status
     AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
     AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  -- (b) service_role / internal write without a JWT.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- (c) P4B consensus-commit sentinel (set by confirm_split_proposal SECDEF).
  --     Admits the full resolve write: status/decision/resolution_type/split_ratio/
  --     settlement_status/resolved_at all change in one UPDATE.
  IF current_setting('app.p4b_split_consensus_commit', true) = 'allow' THEN
    RETURN NEW;
  END IF;

  -- (d) P4A settle sentinel (set by settle_consensus_split SECDEF).
  --     Narrowly scoped: ONLY admits a settlement_status pending→settled flip.
  --     All other lifecycle fields must be unchanged — any broader write falls through
  --     to the RAISE below even if this sentinel is armed.
  IF current_setting('app.p4b_split_settle_commit', true) = 'allow'
     AND OLD.settlement_status = 'pending' AND NEW.settlement_status = 'settled'
     AND NEW.status            IS NOT DISTINCT FROM OLD.status
     AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
     AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
     AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
     AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
     AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
  THEN
    RETURN NEW;
  END IF;

  -- (e) Operators may change any lifecycle field directly.
  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  -- (f) All other authenticated callers are blocked.
  RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public.disputes_status_change_guard() IS
  'Block 5.6 + P4B + P4A: guards status/decision/resolution_type/split_ratio/'
  'settlement_status/resolved_at/closed_at against direct mutations by non-operator '
  'authenticated callers. '
  'P4B: allows confirm_split_proposal writes via app.p4b_split_consensus_commit sentinel. '
  'P4A: allows settle_consensus_split writes via app.p4b_split_settle_commit sentinel '
  '(strictly scoped to settlement_status pending→settled; no other lifecycle field change).';

-- ---------------------------------------------------------------------------
-- 3. Dormancy hardening — close the P4B authenticated grant hole
-- ---------------------------------------------------------------------------
-- P4B migration (20260614010000) shipped propose_split_atomic / confirm_split_proposal /
-- reject_split_proposal with GRANT EXECUTE TO authenticated. This is correct for
-- when the feature is live, but at apply time the feature flags
-- (CONSENSUS_SPLIT_ENABLED / VITE_CONSENSUS_SPLIT_ENABLED) are NOT yet set.
--
-- Defense-in-depth: revoke at the DB layer so no authenticated caller can create
-- accepted-proposal rows or resolve a dispute as split even if the route-layer flag
-- check is bypassed (e.g., direct PostgREST call).
--
-- After this REVOKE:
--   - authenticated callers get 42501 on all three consensus-split RPCs
--   - service_role retains EXECUTE for internal / Edge-Function orchestration
--   - The whole consensus-capture path is dormant at the DB layer
REVOKE EXECUTE ON FUNCTION public.propose_split_atomic(uuid, numeric) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_split_proposal(uuid)         FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.reject_split_proposal(uuid)          FROM authenticated;

-- ---------------------------------------------------------------------------
-- LAUNCH RE-GRANT (run at flag flip, NOT now)
-- ---------------------------------------------------------------------------
-- When CONSENSUS_SPLIT_ENABLED=true (server) + VITE_CONSENSUS_SPLIT_ENABLED=true
-- (client) are set, apply the following as a single migration or MCP execute_sql call:
--
-- GRANT EXECUTE ON FUNCTION public.propose_split_atomic(uuid, numeric) TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.confirm_split_proposal(uuid)         TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.reject_split_proposal(uuid)          TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.settle_consensus_split(uuid)         TO authenticated;
-- NOTIFY pgrst, 'reload schema';
--
-- All four grants must be applied atomically (single transaction).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4. Schema cache reload
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- (run manually to undo this migration — NOT via apply_migration)
-- This restores the guard to the pre-P4B PROD_GUARD_DEF (no sentinel branches),
-- drops settle_consensus_split, and re-grants the P4B functions to authenticated.
-- Only use if rolling back BOTH P4A and P4B together; if rolling back P4A only,
-- restore the guard to the P4B state (with app.p4b_split_consensus_commit branch).
-- =============================================================================
--
-- -- Step 1: Restore disputes_status_change_guard to original prod state (no sentinels):
-- CREATE OR REPLACE FUNCTION public.disputes_status_change_guard()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- SET search_path TO 'public'
-- AS $function$
-- BEGIN
--   IF NEW.status              IS NOT DISTINCT FROM OLD.status
--      AND NEW.decision          IS NOT DISTINCT FROM OLD.decision
--      AND NEW.resolution_type   IS NOT DISTINCT FROM OLD.resolution_type
--      AND NEW.split_ratio       IS NOT DISTINCT FROM OLD.split_ratio
--      AND NEW.settlement_status IS NOT DISTINCT FROM OLD.settlement_status
--      AND NEW.resolved_at       IS NOT DISTINCT FROM OLD.resolved_at
--      AND NEW.closed_at         IS NOT DISTINCT FROM OLD.closed_at
--   THEN
--     RETURN NEW;
--   END IF;
--   IF auth.uid() IS NULL THEN
--     RETURN NEW;
--   END IF;
--   IF public.is_current_user_operator() THEN
--     RETURN NEW;
--   END IF;
--   RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
--     USING ERRCODE = '42501';
-- END;
-- $function$;
--
-- -- Step 2: Drop settle_consensus_split:
-- DROP FUNCTION IF EXISTS public.settle_consensus_split(uuid);
--
-- -- Step 3: Re-grant P4B functions to authenticated (restore P4B GRANT state):
-- GRANT EXECUTE ON FUNCTION public.propose_split_atomic(uuid, numeric) TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.confirm_split_proposal(uuid)         TO authenticated;
-- GRANT EXECUTE ON FUNCTION public.reject_split_proposal(uuid)          TO authenticated;
--
-- -- Step 4: Schema cache reload:
-- NOTIFY pgrst, 'reload schema';
-- =============================================================================
