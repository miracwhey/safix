-- =============================================================================
-- Block P · #5 — operator split ratio bound: [0,1] inclusive -> (0,1) EXCLUSIVE
-- =============================================================================
-- WHY (money-correctness, LIVE path — operator dispute resolution is NOT flag-gated):
--   operator_resolve_dispute_split previously admitted p_split_ratio in [0,1]
--   INCLUSIVE (20260614030000:105). A ratio of 0 is a category error — it is a
--   FULL customer refund, not a split — and it double-pays:
--     * the settlement bridge (api/release-tranche.ts:149) coerces an out-of-(0,1]
--       ratio to `undefined`, which falls through to a FULL provider release
--       (effectiveGross = trancheGross), AND
--     * the domain split path (src/lib/payments/service.ts:438) computes the
--       customer refund as total*(1 - ratio) = total*(1 - 0) = a FULL refund.
--   => at ratio=0 the customer is fully refunded AND the provider is fully
--      released — the platform eats the whole tranche.
--   ratio=1 (full provider release) is the mirror category error: it belongs on
--   the plain release path, not a "split".
--
--   The consensus split proposal RPC already bounds proposed_ratio to (0,1)
--   EXCLUSIVE; this aligns the operator RPC to the same contract. 0% => use the
--   refund decision, 100% => use the release decision.
--
-- WHAT: CREATE OR REPLACE operator_resolve_dispute_split with the ratio guard
--   tightened to reject <= 0 and >= 1. The body is otherwise BYTE-IDENTICAL to
--   20260614030000 (R3.2 zombie-acceptance hygiene preserved: the pending
--   acceptance is still flipped to 'disputed', the status-history row is still
--   written, the resolved/settled idempotent early-return is preserved).
--   CREATE OR REPLACE preserves the existing EXECUTE grants. No schema change.
--
-- LIVE: this replaces a prod-live function (shipped via PR #990 / 20260614030000)
--   and changes runtime behaviour for out-of-(0,1) operator inputs (now rejected
--   instead of silently double-paying). It is NOT dormant. Apply is an explicit
--   prod gate. Behavioural repro: supabase/repro/20260615000000_operator_split_ratio_exclusive_repro.sql
-- =============================================================================

-- DB-level chokepoint: NO write path — the operator/consensus RPCs, a generic
-- PostgREST patch of disputes.split_ratio, or any future caller — may persist a
-- split_ratio outside (0,1). NULL is allowed (release/refund/reject disputes
-- carry no split). This is the single gate the RPC guard + the release-tranche /
-- refund-escrow application-layer guards all sit in front of; it closes the
-- generic-update seam they cannot reach. Verified prod-clean before add (0
-- disputes, 0 rows with split_ratio, no existing split_ratio CHECK).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.disputes'::regclass
      AND conname = 'disputes_split_ratio_exclusive_chk'
  ) THEN
    ALTER TABLE public.disputes
      ADD CONSTRAINT disputes_split_ratio_exclusive_chk
      CHECK (split_ratio IS NULL OR (split_ratio > 0 AND split_ratio < 1));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_split(p_dispute_id uuid, p_split_ratio numeric, p_note text DEFAULT NULL::text, p_provider_award_amount numeric DEFAULT NULL::numeric, p_customer_refund_amount numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_operator_id        uuid;
  v_from_status        text;
  v_decision           text;
  v_settlement_status  text;
  v_job_id             uuid;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  -- (0,1) EXCLUSIVE: 0% is a full refund, 100% is a full release — neither is a
  -- split. Inclusive bounds double-paid at ratio=0 (see migration header).
  IF p_split_ratio IS NULL OR p_split_ratio <= 0 OR p_split_ratio >= 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be in (0,1) exclusive (0%% = refund, 100%% = release), got %', p_split_ratio USING ERRCODE = 'P0001';
  END IF;
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_split got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'split' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as split',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'split',
         resolution_type        = 'split',
         split_ratio            = p_split_ratio,
         settlement_status      = 'pending',
         provider_award_amount  = COALESCE(p_provider_award_amount,  provider_award_amount),
         customer_refund_amount = COALESCE(p_customer_refund_amount, customer_refund_amount),
         release_amount         = COALESCE(p_provider_award_amount,  release_amount),
         refund_amount          = COALESCE(p_customer_refund_amount, refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'split', 'resolution_type', 'split', 'split_ratio', p_split_ratio, 'provider_award_amount', p_provider_award_amount, 'customer_refund_amount', p_customer_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  -- R3.2 zombie-acceptance hygiene (additive): a split also refunds the customer's
  -- share, so the pending acceptance must go terminal — otherwise the auto-release
  -- sweep would blind-release the FULL final tranche to the provider.
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id AND status = 'pending';

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

NOTIFY pgrst, 'reload schema';
