-- Funding confirmation must never take the escrow plan from an HTTP body or
-- Stripe metadata. Those identifiers are transport hints; the locked
-- funding_request row is the canonical relationship. The prior RPC accepted a
-- nullable p_escrow_plan_id, so a successful PI could mark only the request as
-- funded and permanently strand the plan, tranches and ledger on its pre-funded
-- states. This version derives and locks the plan from the request, repairs that
-- historical partial state on an idempotent retry, and retains the existing RPC
-- signature for deployed callers.

CREATE OR REPLACE FUNCTION public.confirm_funding_atomic(
  p_funding_request_id uuid,
  p_escrow_plan_id     uuid DEFAULT NULL::uuid,
  p_payment_intent_id  text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now                timestamptz := now();
  v_fr_status          text;
  v_ep_status          text;
  v_job_status         text;
  v_canonical_plan_id  uuid;
  v_job_id             uuid;
  v_was_already_funded boolean := false;
  v_fr_updated         boolean := false;
  v_ep_updated         boolean := false;
  v_tranches_updated   integer := 0;
  v_pay_id             uuid;
  v_gross              numeric;
  v_fee                numeric;
  v_rate               numeric;
  v_cur                text;
BEGIN
  -- Lock the request first; it is the sole source for plan/job linkage.
  SELECT status, escrow_plan_id, job_id
    INTO v_fr_status, v_canonical_plan_id, v_job_id
    FROM funding_requests
   WHERE id = p_funding_request_id
   FOR UPDATE;

  IF v_fr_status IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found', 'detail', 'funding_request not found');
  END IF;

  IF v_canonical_plan_id IS NULL OR v_job_id IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'funding_request is missing its canonical escrow relationship'
    );
  END IF;

  -- A caller may keep sending the legacy parameter, but it can never redirect
  -- this transaction to a different plan.
  IF p_escrow_plan_id IS NOT NULL AND p_escrow_plan_id <> v_canonical_plan_id THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'provided escrow plan does not match funding_request'
    );
  END IF;

  -- Lock the canonical plan before changing the request. A missing plan is a
  -- data-integrity failure, not a reason to produce a partial funded request.
  SELECT status INTO v_ep_status
    FROM escrow_payment_plans
   WHERE id = v_canonical_plan_id
   FOR UPDATE;

  IF v_ep_status IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'canonical escrow plan not found'
    );
  END IF;

  v_was_already_funded := v_fr_status = 'funded';

  -- Existing funded requests are idempotent, but deliberately continue through
  -- the plan/tranche/ledger reconciliation below to heal old partial confirms.
  IF NOT v_was_already_funded THEN
    SELECT status INTO v_job_status FROM jobs WHERE id = v_job_id;

    IF v_job_status IS NULL THEN
      RETURN jsonb_build_object('outcome', 'invalid_state', 'detail', 'linked job not found');
    END IF;

    IF v_job_status IN ('cancelled', 'completed') THEN
      RETURN jsonb_build_object(
        'outcome', 'job_terminal',
        'detail', 'job is ' || v_job_status || ' — funding refused',
        'job_status', v_job_status
      );
    END IF;

    IF v_fr_status NOT IN ('created', 'sent', 'funding_started', 'funding_initiated') THEN
      RETURN jsonb_build_object(
        'outcome', 'invalid_state',
        'detail', 'funding_request in non-fundable state: ' || v_fr_status,
        'funding_request_status', v_fr_status
      );
    END IF;

    UPDATE funding_requests
       SET status = 'funded', funded_at = v_now, updated_at = v_now
     WHERE id = p_funding_request_id
       AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');
    v_fr_updated := FOUND;
  END IF;

  IF v_ep_status IN ('awaiting_customer_funding', 'funding_initiated') THEN
    UPDATE escrow_payment_plans
       SET status = 'funded_in_escrow',
           funded_at = v_now,
           external_funding_ref = COALESCE(p_payment_intent_id, external_funding_ref),
           updated_at = v_now
     WHERE id = v_canonical_plan_id
       AND status IN ('awaiting_customer_funding', 'funding_initiated');
    v_ep_updated := FOUND;
  END IF;

  UPDATE escrow_tranches
     SET status = 'funded', updated_at = v_now
   WHERE plan_id = v_canonical_plan_id
     AND status = 'pending_funding';
  GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;

  -- Idempotent funding audit rows: an old request that was marked funded with
  -- no plan now receives the same ledger evidence as a normal confirmation.
  SELECT total_amount, platform_fee_amount, platform_fee_rate,
         upper(COALESCE(currency, 'EUR'))
    INTO v_gross, v_fee, v_rate, v_cur
    FROM escrow_payment_plans
   WHERE id = v_canonical_plan_id;

  SELECT id INTO v_pay_id
    FROM payments
   WHERE job_id = v_job_id
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_pay_id IS NOT NULL AND v_gross IS NOT NULL THEN
    v_fee := COALESCE(v_fee, round(v_gross * COALESCE(v_rate, 0), 2));
    INSERT INTO ledger_entries (payment_id, job_id, entry_type, amount, currency, metadata, movement_ref)
    VALUES
      (v_pay_id, v_job_id, 'escrow_deposit', v_gross, v_cur,
       jsonb_build_object('note', 'Treuhand-Einzahlung eingegangen', 'escrow_plan_id', v_canonical_plan_id::text),
       v_canonical_plan_id::text),
      (v_pay_id, v_job_id, 'platform_fee', v_fee, v_cur,
       jsonb_build_object('note', 'SaFix Plattformprovision', 'escrow_plan_id', v_canonical_plan_id::text, 'rate', v_rate),
       v_canonical_plan_id::text)
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome', CASE WHEN v_was_already_funded THEN 'already_funded' ELSE 'confirmed' END,
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated,
    'escrow_plan_id', v_canonical_plan_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text)
  TO service_role;
