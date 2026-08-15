-- Job-terminal guard for confirm_funding_atomic.
--
-- Closes the residual money hole behind the cancel→funding cascade: a job can
-- be cancelled while its FundingRequest is in 'funding_initiated' (a LIVE Stripe
-- PaymentIntent). The cancel cascade intentionally does NOT cancel that request
-- (it would strand the live PI), and the api/initiate-funding terminal recheck
-- only guards the initiate path — confirmation arrives later via stripe-webhook
-- → this RPC. Without a job-status check the customer can complete that PI after
-- the cancel and fund a dead order.
--
-- This adds a job-terminal guard that refuses confirmation when the linked job
-- is 'cancelled' or 'completed'. Placed AFTER the already_funded idempotency
-- check so prior-funded requests stay idempotent (existing escrowed money is a
-- refund-flow concern, not this RPC's), and BEFORE any write.
--
-- IMPORTANT: rebuilt from the LIVE prod definition (which carries the C1
-- Funding-Ledger audit block from the payout-corridor work) — NOT from the
-- stale repo base migration 20260415000002. The C1 block is preserved verbatim.
-- CREATE OR REPLACE preserves existing privileges (the h9 execute-revoke stays).

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
  v_now             TIMESTAMPTZ := now();
  v_fr_status       TEXT;
  v_ep_status       TEXT;
  v_job_status      TEXT;
  v_fr_updated      BOOLEAN := FALSE;
  v_ep_updated      BOOLEAN := FALSE;
  v_tranches_updated INT := 0;
BEGIN
  -- 0. Lock + read funding_request status
  SELECT status INTO v_fr_status
  FROM funding_requests
  WHERE id = p_funding_request_id
  FOR UPDATE;

  IF v_fr_status IS NULL THEN
    RETURN jsonb_build_object(
      'outcome', 'not_found',
      'detail', 'funding_request not found'
    );
  END IF;

  -- Already funded -> idempotent success (no changes needed)
  IF v_fr_status = 'funded' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_funded',
      'funding_request_status', v_fr_status
    );
  END IF;

  -- Job-terminal guard: never fund a cancelled/completed job. Closes the window
  -- where a customer completes a live Stripe PaymentIntent AFTER the job was
  -- cancelled. Placed after the already_funded check so already-funded requests
  -- stay idempotent (their escrowed money is handled by refund flows, not here).
  SELECT j.status INTO v_job_status
  FROM funding_requests fr
  JOIN jobs j ON j.id = fr.job_id
  WHERE fr.id = p_funding_request_id;

  IF v_job_status IN ('cancelled', 'completed') THEN
    RETURN jsonb_build_object(
      'outcome', 'job_terminal',
      'detail', 'job is ' || v_job_status || ' — funding refused',
      'job_status', v_job_status
    );
  END IF;

  -- Status guard: only advance from pre-funded states
  IF v_fr_status NOT IN ('created', 'sent', 'funding_started', 'funding_initiated') THEN
    RETURN jsonb_build_object(
      'outcome', 'invalid_state',
      'detail', 'funding_request in non-fundable state: ' || v_fr_status,
      'funding_request_status', v_fr_status
    );
  END IF;

  -- 1. Update funding_requests -> 'funded'
  UPDATE funding_requests
  SET status     = 'funded',
      funded_at  = v_now,
      updated_at = v_now
  WHERE id = p_funding_request_id
    AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');

  v_fr_updated := FOUND;

  -- 2. Update escrow_payment_plans -> 'funded_in_escrow'
  IF p_escrow_plan_id IS NOT NULL THEN
    SELECT status INTO v_ep_status
    FROM escrow_payment_plans
    WHERE id = p_escrow_plan_id
    FOR UPDATE;

    IF v_ep_status IN ('awaiting_customer_funding', 'funding_initiated') THEN
      UPDATE escrow_payment_plans
      SET status              = 'funded_in_escrow',
          funded_at           = v_now,
          external_funding_ref = COALESCE(p_payment_intent_id, external_funding_ref),
          updated_at          = v_now
      WHERE id = p_escrow_plan_id
        AND status IN ('awaiting_customer_funding', 'funding_initiated');

      v_ep_updated := FOUND;
    END IF;
    -- If plan is already funded_in_escrow / partially_released / fully_released -> no-op (idempotent)

    -- 3. Update pending_funding tranches -> 'funded'
    UPDATE escrow_tranches
    SET status     = 'funded',
        updated_at = v_now
    WHERE plan_id = p_escrow_plan_id
      AND status = 'pending_funding';

    GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;

    -- 4. C1 Funding-Ledger audit rows (audit-only, no money movement)
    -- Idempotent via ON CONFLICT on UNIQUE(payment_id, entry_type, movement_ref).
    -- Skips when no payments row resolves (non-fatal audit gap). movement_ref = escrow_plan_id::text.
    DECLARE
      v_pay_id uuid;
      v_job_id uuid;
      v_gross  numeric;
      v_fee    numeric;
      v_rate   numeric;
      v_cur    text;
    BEGIN
      SELECT job_id, total_amount, platform_fee_amount, platform_fee_rate, upper(COALESCE(currency, 'EUR'))
        INTO v_job_id, v_gross, v_fee, v_rate, v_cur
        FROM escrow_payment_plans
        WHERE id = p_escrow_plan_id;

      -- Deterministic attribution: pin to the oldest payments row for the job.
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
           jsonb_build_object('note', 'Treuhand-Einzahlung eingegangen', 'escrow_plan_id', p_escrow_plan_id::text), p_escrow_plan_id::text),
          (v_pay_id, v_job_id, 'platform_fee', v_fee, v_cur,
           jsonb_build_object('note', 'SaFix Plattformprovision', 'escrow_plan_id', p_escrow_plan_id::text, 'rate', v_rate), p_escrow_plan_id::text)
        ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
      END IF;
    END;
  END IF;

  -- Return result
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated
  );
END;
$function$;
