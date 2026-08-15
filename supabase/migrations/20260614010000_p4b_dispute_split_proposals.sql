-- =============================================================================
-- P4B Cluster 1 / PR A: Dispute Consensus Split — table + SECDEF RPCs
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- DO NOT APPLY without explicit user confirm.
--
-- Prod verifications completed before writing:
--   disputes.id            = uuid  (prompt claimed text — prod wins)
--   disputes.job_id        = uuid  (prompt claimed text — prod wins)
--   disputes.customer_profile_id = uuid, disputes.provider_id = uuid (FK to providers.id)
--   dispute_status_history.dispute_id = uuid, .job_id = uuid nullable, no updated_at
--   jobs.customer_user_id  = uuid, jobs.craftsman_user_id = text (mixed model)
--   operator_resolve_dispute_split(uuid, numeric, text, numeric, numeric) confirmed on prod
--   supabase_realtime publication exists; disputes already in it
--   profiles.is_operator = boolean confirmed
--   disputes_status_change_guard_tg (BEFORE UPDATE) EXISTS — sentinel GUC added to pass
--     non-operator SECDEF confirm writes through the trigger
--   No propose_split* / confirm_split* / reject_split* RPCs exist on prod (clean slate)
--
-- TRIGGER BYPASS NOTE (feedback_secdef_rpc_no_trigger_guard_bypass):
--   SECURITY DEFINER preserves the caller's auth.uid() in GUCs.
--   disputes_status_change_guard fires under the authenticated caller's uid (non-operator)
--   and raises. Fix: confirm_split_proposal sets SET LOCAL sentinel GUC; trigger checks it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. dispute_split_proposals table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispute_split_proposals (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- dispute_id is uuid on prod (disputes.id = uuid, despite app-level text IDs)
  dispute_id      uuid          NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  job_id          uuid          NOT NULL,
  proposed_by     uuid          NOT NULL,
  proposed_ratio  numeric(5,4)  NOT NULL CHECK (proposed_ratio > 0 AND proposed_ratio < 1),
  status          text          NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','accepted','rejected','superseded')),
  confirmed_by    uuid,
  proposal_round  smallint      NOT NULL DEFAULT 1 CHECK (proposal_round >= 1),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dispute_split_proposals IS
  'P4B: two-party consensus split proposals. One pending proposal per dispute at a time. '
  'All writes via SECDEF RPCs (propose_split_atomic / confirm_split_proposal / reject_split_proposal). '
  'Dormant until PR B wires callers.';

-- Exactly one live (pending) proposal per dispute at a time.
-- Partial unique — only blocks concurrent pending inserts, not historical rows.
CREATE UNIQUE INDEX IF NOT EXISTS dsp_one_pending_per_dispute_idx
  ON public.dispute_split_proposals (dispute_id)
  WHERE status = 'pending';

-- General lookup index (UI polls by dispute_id, optionally filtered by status)
CREATE INDEX IF NOT EXISTS dsp_dispute_status_idx
  ON public.dispute_split_proposals (dispute_id, status);

-- REPLICA IDENTITY FULL required: realtime DELETE events need non-PK columns
-- (dispute_id) for client-side filtering. Without it, only the PK appears in OLD
-- and dispute_id-filtered DELETE subscriptions are silently dropped.
ALTER TABLE public.dispute_split_proposals REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.dispute_split_proposals ENABLE ROW LEVEL SECURITY;

-- SELECT: proposer, confirmer, any party of the parent dispute, or operator.
-- IMPORTANT: all EXISTS subquery columns are table-qualified to prevent the
-- silent always-true tautology (unqualified col resolves to subquery table).
-- NULL-poisoning guards: IS NOT NULL before equality on nullable party columns.
CREATE POLICY dsp_select_own ON public.dispute_split_proposals
  FOR SELECT
  TO authenticated
  USING (
    -- Proposer sees their own rows
    -- (unqualified here is correct: refers to dispute_split_proposals.proposed_by)
    proposed_by = auth.uid()
    -- Confirmer sees the accepted row
    OR (confirmed_by IS NOT NULL AND confirmed_by = auth.uid())
    -- Customer party of the parent dispute
    OR EXISTS (
      SELECT 1 FROM public.disputes d
      WHERE d.id = dispute_split_proposals.dispute_id
        AND d.customer_profile_id IS NOT NULL
        AND d.customer_profile_id = auth.uid()
    )
    -- Craftsman party (provider_id FK → providers.id → profile_id)
    OR EXISTS (
      SELECT 1
        FROM public.disputes d
        JOIN public.providers pr ON pr.id = d.provider_id
       WHERE d.id = dispute_split_proposals.dispute_id
         AND pr.profile_id = auth.uid()
    )
    -- Opener (covers edge case where opener is neither customer nor craftsman slot)
    OR EXISTS (
      SELECT 1 FROM public.disputes d
      WHERE d.id = dispute_split_proposals.dispute_id
        AND d.opened_by_profile_id IS NOT NULL
        AND d.opened_by_profile_id = auth.uid()
    )
    -- Operator
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- Defensive: all direct writes from client roles are blocked even without policies.
-- RLS default-deny + no write policies = same effect, but explicit REVOKE is required
-- per audit invariant (feedback_audit_table_revoke_writes).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.dispute_split_proposals FROM anon, authenticated;

-- PostgREST requires an explicit SELECT grant to expose the table via the API.
GRANT SELECT ON public.dispute_split_proposals TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Realtime publication
-- ---------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.dispute_split_proposals;

-- ---------------------------------------------------------------------------
-- 4. Sentinel GUC patch on disputes_status_change_guard
-- ---------------------------------------------------------------------------
-- Problem: confirm_split_proposal is SECURITY DEFINER but auth.uid() remains
-- the authenticated caller's UUID (non-operator). The BEFORE UPDATE trigger
-- checks auth.uid() IS NULL (service_role path) OR is_current_user_operator()
-- and raises for all other callers — including our SECDEF confirm RPC.
--
-- Fix: add a transaction-local GUC sentinel check BEFORE the operator check.
-- confirm_split_proposal sets SET LOCAL app.p4b_split_consensus_commit = 'allow'
-- (via set_config(..., true = local)) immediately before writing disputes.
-- The sentinel is cleared automatically at transaction end (committed or rolled back).
--
-- This is a targeted replacement of the full function body (CREATE OR REPLACE).
-- The trigger registration (disputes_status_change_guard_tg) is unchanged.
CREATE OR REPLACE FUNCTION public.disputes_status_change_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Fast path: nothing protected changed.
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

  -- service_role / RPC-internal write without a JWT.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- SECDEF consensus-split internal write (P4B).
  -- Set by confirm_split_proposal with set_config(..., true) = SET LOCAL.
  -- Transaction-scoped: resets on commit/rollback; cannot be set by clients
  -- before calling RPC (each RPC invocation is its own transaction in PostgREST).
  IF current_setting('app.p4b_split_consensus_commit', true) = 'allow' THEN
    RETURN NEW;
  END IF;

  IF public.is_current_user_operator() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unauthorized: only operators can change dispute lifecycle fields'
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION public.disputes_status_change_guard() IS
  'Block 5.6 + P4B: guards status/decision/resolution_type/split_ratio/settlement_status/'
  'resolved_at/closed_at against direct mutations by non-operator authenticated callers. '
  'P4B addition: allows confirm_split_proposal SECDEF writes via app.p4b_split_consensus_commit sentinel GUC.';

-- ---------------------------------------------------------------------------
-- 4b. Widen dispute_status_history.source CHECK to allow 'consensus'
-- ---------------------------------------------------------------------------
-- Prod CHECK allowed only ('client','server','webhook','system','admin').
-- confirm_split_proposal writes source='consensus' to distinguish party-agreed
-- splits from operator-imposed ones ('admin'). Without this, the first confirm
-- call would raise check_violation at the history INSERT. Additive widening —
-- every existing row keeps a valid value; zero data risk.
ALTER TABLE public.dispute_status_history
  DROP CONSTRAINT IF EXISTS dispute_status_history_source_check;
ALTER TABLE public.dispute_status_history
  ADD CONSTRAINT dispute_status_history_source_check
  CHECK (source = ANY (ARRAY['client','server','webhook','system','admin','consensus']));

-- ---------------------------------------------------------------------------
-- 5. propose_split_atomic
-- ---------------------------------------------------------------------------
-- Either dispute party (customer OR craftsman, NOT operator) proposes a split ratio.
-- Supersedes any prior pending proposal for this dispute (counter-proposal model).
-- Caps at 10 proposal rounds per dispute (fail-fast before supersede).
CREATE OR REPLACE FUNCTION public.propose_split_atomic(
  p_dispute_id  uuid,
  p_ratio       numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_dispute_status    text;
  v_decision          text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_job_id            uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_party          boolean     := false;
  v_next_round        smallint;
  v_new_id            uuid;
  v_new_row           jsonb;
  v_now               timestamptz := now();
BEGIN
  -- Auth guard (anon callers have no valid JWT; auth.uid() would be NULL)
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Validate ratio before any DB I/O (fast fail)
  IF p_ratio IS NULL OR p_ratio <= 0 OR p_ratio >= 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be strictly between 0 and 1, got %', p_ratio
      USING ERRCODE = 'P0001';
  END IF;

  -- Load + lock dispute row (serializes concurrent proposals on the same dispute)
  SELECT d.status, d.decision, d.customer_profile_id, d.provider_id, d.job_id
    INTO v_dispute_status, v_decision, v_customer_pid, v_provider_id, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Party check — customer side
  -- NULL-poisoning guard: three-valued-logic safe — explicit IS NOT NULL prevents
  -- (NULL = v_uid) from evaluating to NULL and bypassing the check.
  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  -- Party check — craftsman side (canonical mixed model from open_dispute_atomic)
  -- craftsman_user_id is TEXT on jobs; cast v_uid to match.
  -- provider_id on disputes is providers.id (uuid), not profile_id.
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', p_dispute_id
      USING ERRCODE = '42501';
  END IF;

  -- Reject if dispute is not in an active (pre-resolution) status
  IF v_dispute_status NOT IN ('open','under_review','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'dispute_not_active: cannot propose split in status %, decision %',
      v_dispute_status, COALESCE(v_decision, 'none')
      USING ERRCODE = 'P0001';
  END IF;

  -- Proposal round cap — checked BEFORE supersede to fail fast without side effects
  SELECT (COALESCE(MAX(dsp.proposal_round), 0) + 1)::smallint
    INTO v_next_round
    FROM public.dispute_split_proposals dsp
   WHERE dsp.dispute_id = p_dispute_id;

  IF v_next_round > 10 THEN
    RAISE EXCEPTION 'split_proposal_cap_reached: dispute % has reached the maximum of 10 proposal rounds',
      p_dispute_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Supersede all currently pending proposals for this dispute
  UPDATE public.dispute_split_proposals
     SET status     = 'superseded',
         updated_at = v_now
   WHERE dispute_id = p_dispute_id
     AND status     = 'pending';

  -- Insert the new pending proposal
  INSERT INTO public.dispute_split_proposals (
    dispute_id, job_id, proposed_by, proposed_ratio,
    status, proposal_round, created_at, updated_at
  ) VALUES (
    p_dispute_id, v_job_id, v_uid, p_ratio,
    'pending', v_next_round, v_now, v_now
  )
  RETURNING id INTO v_new_id;

  SELECT row_to_json(dsp)::jsonb INTO v_new_row
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = v_new_id;

  RETURN v_new_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.propose_split_atomic(uuid, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.propose_split_atomic(uuid, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. confirm_split_proposal
-- ---------------------------------------------------------------------------
-- The OTHER party (not the proposer) confirms the pending split proposal.
-- Writes disputes: decision='split', split_ratio=proposed_ratio, settlement_status='pending'
-- (mirrors operator_resolve_dispute_split exactly, minus the award/refund amount args
-- which are left for the P4 money-movement run / PR B+).
-- Uses sentinel GUC to pass disputes_status_change_guard trigger.
CREATE OR REPLACE FUNCTION public.confirm_split_proposal(
  p_proposal_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               uuid        := auth.uid();
  v_dispute_id        uuid;
  v_job_id            uuid;
  v_proposed_by       uuid;
  v_proposed_ratio    numeric;
  v_dispute_status    text;
  v_decision          text;
  v_settlement_status text;
  v_customer_pid      uuid;
  v_provider_id       uuid;
  v_is_customer       boolean     := false;
  v_is_provider       boolean     := false;
  v_is_party          boolean     := false;
  v_now               timestamptz := now();
  v_result            jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Atomic fetch + status guard on proposal row.
  -- WHERE status = 'pending' kills zombie-acceptance: zero rows → P0002.
  -- FOR UPDATE serializes concurrent confirm/reject calls on the same proposal.
  SELECT dsp.dispute_id, dsp.job_id, dsp.proposed_by, dsp.proposed_ratio
    INTO v_dispute_id, v_job_id, v_proposed_by, v_proposed_ratio
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id
     AND dsp.status = 'pending'
   FOR UPDATE;

  IF v_dispute_id IS NULL THEN
    RAISE EXCEPTION 'proposal_not_found_or_not_pending: %', p_proposal_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be the OTHER party — proposer cannot confirm their own proposal
  IF v_uid = v_proposed_by THEN
    RAISE EXCEPTION 'proposer_cannot_confirm: caller % proposed this split; the other party must confirm',
      v_uid
      USING ERRCODE = '42501';
  END IF;

  -- Load + lock dispute row (also serializes against concurrent operator resolve)
  SELECT d.status, d.decision, d.settlement_status,
         d.customer_profile_id, d.provider_id
    INTO v_dispute_status, v_decision, v_settlement_status,
         v_customer_pid, v_provider_id
    FROM public.disputes d
   WHERE d.id = v_dispute_id
   FOR UPDATE;

  -- Party check for confirmer (must be a party, even though not the proposer)
  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', v_dispute_id
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent path: if dispute already resolved as split with pending/settled money leg,
  -- accept the confirm silently (no double-write, no FSM regression).
  IF v_dispute_status = 'resolved'
     AND v_decision = 'split'
     AND v_settlement_status IN ('pending', 'settled')
  THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d WHERE d.id = v_dispute_id;
    RETURN v_result;
  END IF;

  -- Dispute must be active for the resolution to proceed
  IF v_dispute_status NOT IN ('open','under_review','customer_waiting','provider_waiting') THEN
    RAISE EXCEPTION 'dispute_not_active: cannot confirm split in status %, decision %',
      v_dispute_status, COALESCE(v_decision, 'none')
      USING ERRCODE = 'P0001';
  END IF;

  -- Decision immutability: if status=resolved with a different decision, reject
  -- (mirrors c4_c5 guard; covers the race where operator resolved between our
  -- SELECT of the proposal and the FOR UPDATE on disputes above)
  IF v_dispute_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'split' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot override with split',
      v_dispute_id, v_decision
      USING ERRCODE = 'P0001';
  END IF;

  -- Mark proposal accepted
  UPDATE public.dispute_split_proposals
     SET status       = 'accepted',
         confirmed_by = v_uid,
         updated_at   = v_now
   WHERE id = p_proposal_id;

  -- Arm sentinel GUC before the disputes UPDATE so disputes_status_change_guard
  -- lets the write through. set_config(key, value, is_local=true) = SET LOCAL:
  -- scoped to this transaction only; resets on commit/rollback.
  PERFORM set_config('app.p4b_split_consensus_commit', 'allow', true);

  -- Write disputes — mirrors operator_resolve_dispute_split exactly
  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'split',
         resolution_type    = 'split',
         split_ratio        = v_proposed_ratio,
         settlement_status  = 'pending',
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = v_dispute_id;

  -- History entry — source 'consensus' distinguishes party-agreed splits from
  -- operator-imposed splits ('admin') for audit and UI differentiation
  INSERT INTO public.dispute_status_history (
    dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at
  ) VALUES (
    v_dispute_id, v_job_id, v_dispute_status, 'resolved', 'consensus', NULL,
    jsonb_build_object(
      'confirmed_by',    v_uid,
      'proposed_by',     v_proposed_by,
      'proposal_id',     p_proposal_id,
      'split_ratio',     v_proposed_ratio,
      'decision',        'split',
      'resolution_type', 'split'
    ),
    v_now
  );

  -- Mirror the operator path: sync dispute_status onto the job row
  UPDATE public.jobs
     SET dispute_status = 'resolved'
   WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d WHERE d.id = v_dispute_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_split_proposal(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_split_proposal(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. reject_split_proposal
-- ---------------------------------------------------------------------------
-- The OTHER party (not the proposer) rejects the pending proposal.
-- Does NOT write to disputes — rejection leaves the dispute active for a counter-proposal.
CREATE OR REPLACE FUNCTION public.reject_split_proposal(
  p_proposal_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid        := auth.uid();
  v_dispute_id   uuid;
  v_job_id       uuid;
  v_proposed_by  uuid;
  v_customer_pid uuid;
  v_provider_id  uuid;
  v_is_customer  boolean     := false;
  v_is_provider  boolean     := false;
  v_is_party     boolean     := false;
  v_now          timestamptz := now();
  v_result       jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Atomic fetch + status guard
  SELECT dsp.dispute_id, dsp.job_id, dsp.proposed_by
    INTO v_dispute_id, v_job_id, v_proposed_by
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id
     AND dsp.status = 'pending'
   FOR UPDATE;

  IF v_dispute_id IS NULL THEN
    RAISE EXCEPTION 'proposal_not_found_or_not_pending: %', p_proposal_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be the OTHER party
  IF v_uid = v_proposed_by THEN
    RAISE EXCEPTION 'proposer_cannot_reject_own_proposal: caller % proposed this split; the other party must reject',
      v_uid
      USING ERRCODE = '42501';
  END IF;

  -- Load dispute party columns for authorization check
  -- No FOR UPDATE needed here: reject does not write to disputes
  SELECT d.customer_profile_id, d.provider_id
    INTO v_customer_pid, v_provider_id
    FROM public.disputes d
   WHERE d.id = v_dispute_id;

  IF v_customer_pid IS NOT NULL AND v_customer_pid = v_uid THEN
    v_is_customer := true;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = v_job_id
      AND (
        j.craftsman_user_id = v_uid::text
        OR (v_provider_id IS NOT NULL AND j.provider_id IN (
          SELECT pr.id FROM public.providers pr WHERE pr.profile_id = v_uid
        ))
      )
  ) INTO v_is_provider;

  v_is_party := v_is_customer OR v_is_provider;

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'unauthorized: caller is not a party to dispute %', v_dispute_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.dispute_split_proposals
     SET status     = 'rejected',
         updated_at = v_now
   WHERE id = p_proposal_id;

  SELECT row_to_json(dsp)::jsonb INTO v_result
    FROM public.dispute_split_proposals dsp
   WHERE dsp.id = p_proposal_id;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reject_split_proposal(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.reject_split_proposal(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Schema cache reload
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
