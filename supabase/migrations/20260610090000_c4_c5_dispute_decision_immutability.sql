-- C4 + C5: Dispute-Operator-RPCs — reject settlement_status fix + decision immutability
-- Written against LIVE prod definitions (pg_get_functiondef, project itdntawwuzqfwmcwnwjr, 2026-06-10).
-- C4: operator_reject_dispute wrote settlement_status='settled' although the money leg
--     (release to provider) has not run yet -> retry CTA (settlementStatus='pending')
--     never appeared, UI showed green "Abgewickelt" with an unpaid provider.
-- C5: all four resolve/reject RPCs accept from_status='resolved' and silently overwrite
--     a different terminal decision -> enables a second, conflicting money movement
--     (stripe.refunds.create fires before finalize_payment_state_atomic can stop it).
--     Fix: decision-immutability guard + settled no-op in all four RPCs.
-- operator_mark_dispute_under_review is NOT affected (whitelist excludes 'resolved').

-- 1. operator_reject_dispute (C4 + C5) ---------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_reject_dispute(p_dispute_id uuid, p_note text DEFAULT NULL::text)
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
  SELECT status, job_id, decision, settlement_status
    INTO v_from_status, v_job_id, v_decision, v_settlement_status
    FROM public.disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id USING ERRCODE = 'P0002';
  END IF;
  IF v_from_status NOT IN ('open','under_review','customer_waiting','provider_waiting','resolved') THEN
    RAISE EXCEPTION 'invalid_dispute_status: reject got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  -- C5 decision immutability: a resolved dispute's decision can never be overwritten
  -- with a different decision. NULL-guarded (three-valued logic).
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'reject' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as reject',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  -- Fully settled disputes are immutable: idempotent no-op (never regress settled -> pending).
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  UPDATE public.disputes
     SET status            = 'resolved',
         decision           = 'reject',
         resolution_type    = 'rejected',
         settlement_status  = 'pending',  -- C4 fix: was 'settled'; money leg has not run yet
         resolved_at        = COALESCE(resolved_at, v_now),
         updated_at         = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'reject', 'resolution_type', 'rejected'), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

-- 2. operator_resolve_dispute_release (C5) -----------------------------------------
CREATE OR REPLACE FUNCTION public.operator_resolve_dispute_release(p_dispute_id uuid, p_note text DEFAULT NULL::text, p_release_amount numeric DEFAULT NULL::numeric, p_refund_amount numeric DEFAULT NULL::numeric)
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
    RAISE EXCEPTION 'invalid_dispute_status: resolve_release got %', v_from_status USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_decision IS NOT NULL AND v_decision <> 'release' THEN
    RAISE EXCEPTION 'decision_immutable: dispute % already resolved with decision %, cannot re-resolve as release',
      p_dispute_id, v_decision USING ERRCODE = 'P0001';
  END IF;
  IF v_from_status = 'resolved' AND v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;
  v_resolution_type := CASE WHEN p_refund_amount IS NULL OR p_refund_amount = 0 THEN 'release_full' ELSE 'release_partial' END;
  UPDATE public.disputes
     SET status                 = 'resolved',
         decision               = 'release',
         resolution_type        = v_resolution_type,
         settlement_status      = 'pending',
         release_amount         = COALESCE(p_release_amount, release_amount),
         refund_amount          = COALESCE(p_refund_amount,  refund_amount),
         provider_award_amount  = COALESCE(p_release_amount, provider_award_amount),
         customer_refund_amount = COALESCE(p_refund_amount,  customer_refund_amount),
         resolved_at            = COALESCE(resolved_at, v_now),
         updated_at             = v_now
   WHERE id = p_dispute_id;
  INSERT INTO public.dispute_status_history (dispute_id, job_id, previous_status, next_status, source, note, metadata, created_at)
  VALUES (p_dispute_id, v_job_id, v_from_status, 'resolved', 'admin', p_note,
    jsonb_build_object('operator_id', v_operator_id, 'decision', 'release', 'resolution_type', v_resolution_type, 'release_amount', p_release_amount, 'refund_amount', p_refund_amount), v_now);
  UPDATE public.jobs SET dispute_status = 'resolved' WHERE id = v_job_id;
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

-- 3. operator_resolve_dispute_refund (C5) ------------------------------------------
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
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

-- 4. operator_resolve_dispute_split (C5) -------------------------------------------
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
  SELECT row_to_json(d)::jsonb INTO v_result FROM public.disputes d WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$function$;

-- ACL belt-and-braces (CREATE OR REPLACE preserves proacl; live state already excludes anon)
REVOKE ALL ON FUNCTION public.operator_reject_dispute(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.operator_resolve_dispute_release(uuid, text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.operator_resolve_dispute_refund(uuid, text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.operator_resolve_dispute_split(uuid, numeric, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operator_reject_dispute(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_resolve_dispute_release(uuid, text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_resolve_dispute_refund(uuid, text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_resolve_dispute_split(uuid, numeric, text, numeric, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
