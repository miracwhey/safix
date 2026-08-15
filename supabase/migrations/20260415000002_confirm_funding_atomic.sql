-- Atomic funding confirmation — single-transaction write for confirm-funding.
--
-- Replaces the previous 3-sequential-write pattern that allowed split state:
--   funding_request=funded while plan/tranches remained in pre-funded states.
--
-- All three writes happen in one PL/pgSQL function (implicit transaction):
--   1. funding_requests → 'funded'
--   2. escrow_payment_plans → 'funded_in_escrow'
--   3. escrow_tranches → 'funded'
--
-- Idempotent: already-funded requests return 'already_funded' without changes.
-- Re-entry safe: status guards + FOR UPDATE locks prevent double-application.
-- Used by both /api/confirm-funding (browser) and stripe-webhook (server).

CREATE OR REPLACE FUNCTION confirm_funding_atomic(
  p_funding_request_id UUID,
  p_escrow_plan_id     UUID    DEFAULT NULL,
  p_payment_intent_id  TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now             TIMESTAMPTZ := now();
  v_fr_status       TEXT;
  v_ep_status       TEXT;
  v_fr_updated      BOOLEAN := FALSE;
  v_ep_updated      BOOLEAN := FALSE;
  v_tranches_updated INT := 0;
BEGIN
  -- ── 0. Lock + read funding_request status ──────────────────────────────
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

  -- Already funded → idempotent success (no changes needed)
  IF v_fr_status = 'funded' THEN
    RETURN jsonb_build_object(
      'outcome', 'already_funded',
      'funding_request_status', v_fr_status
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

  -- ── 1. Update funding_requests → 'funded' ─────────────────────────────
  UPDATE funding_requests
  SET status     = 'funded',
      funded_at  = v_now,
      updated_at = v_now
  WHERE id = p_funding_request_id
    AND status IN ('created', 'sent', 'funding_started', 'funding_initiated');

  v_fr_updated := FOUND;

  -- ── 2. Update escrow_payment_plans → 'funded_in_escrow' ───────────────
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
    -- If plan is already funded_in_escrow / partially_released / fully_released → no-op (idempotent)

    -- ── 3. Update pending_funding tranches → 'funded' ────────────────────
    UPDATE escrow_tranches
    SET status     = 'funded',
        updated_at = v_now
    WHERE plan_id = p_escrow_plan_id
      AND status = 'pending_funding';

    GET DIAGNOSTICS v_tranches_updated = ROW_COUNT;
  END IF;

  -- ── Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated
  );
END;
$$;

-- Accessible from service_role (admin client used by API routes + webhooks)
GRANT EXECUTE ON FUNCTION confirm_funding_atomic(UUID, UUID, TEXT) TO service_role;
