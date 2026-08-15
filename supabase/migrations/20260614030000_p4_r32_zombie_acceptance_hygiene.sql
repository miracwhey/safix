-- P4 follow-up · R3.2 Zombie-Acceptance-Hygiene (LIVE hygiene fix)
--
-- Closes a latent mis-payout on the currently-live operator refund AND split
-- routes: when an operator resolves a dispute as a refund or split, the related
-- job's pending acceptance row stays 'pending'. The auto-release sweep
-- (api/_acceptanceAutoRelease.ts) selects status='pending' acceptances whose
-- expires_at has passed and releases the FULL final tranche — so a now-refunded
-- (or split) job could still auto-release to the provider ("zombie" acceptance):
-- a double-payout for full refund, a mis-payout for split. Each CREATE OR REPLACE
-- below is byte-identical to the live prod body (pulled via pg_get_functiondef)
-- PLUS one additive UPDATE that drives the pending acceptance terminal ('disputed').
--
-- SECURITY DEFINER is required: the operator is not the acceptance owner, so a
-- plain UPDATE would be RLS-blocked. 'disputed' is allowed by acceptances_status_check.
-- epoch-ms (not timestamptz) because acceptances.updated_at is bigint.
--
-- Scope = money-to-customer resolutions: refund AND split (both leave the customer
-- owed part/all of the escrow). operator_resolve_dispute_release is intentionally
-- EXCLUDED — a release pays the provider, so the sweep releasing the final tranche
-- is the correct, idempotent outcome. The companion query-ordering fix
-- (.order('expires_at')) lives in api/_acceptanceAutoRelease.ts in the same PR.
--
-- LIVE: not flag-gated; effective on apply. No schema/signature change.

CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_refund(p_dispute_id uuid, p_note text DEFAULT NULL::text, p_refund_amount numeric DEFAULT NULL::numeric, p_release_amount numeric DEFAULT NULL::numeric)
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
  v_resolution_type    text;
  v_now                timestamptz := now();
  v_result             jsonb;
BEGIN
  v_operator_id := public._assert_caller_is_operator();
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: resolve_refund got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'refund' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as refund',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  v_resolution_type := CASE WHEN p_release_amount IS NULL OR p_release_amount = 0 THEN 'refund_full' ELSE 'refund_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'refund',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         release_amount         = COALESCE(p_release_amount, release_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'refund', 'resolution_type', v_resolution_type, 'refund_amount', p_refund_amount, 'release_amount', p_release_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;

  -- R3.2 zombie-acceptance hygiene (additive): drive the related pending acceptance
  -- terminal so the auto-release sweep can never release the now-refunded final tranche.
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id AND status = 'pending';

  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

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
  IF p_split_ratio IS NULL OR p_split_ratio < 0 OR p_split_ratio > 1 THEN
    RAISE EXCEPTION 'invalid_split_ratio: must be in [0,1], got %', p_split_ratio USING ERRCODE = 'P0001';
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
