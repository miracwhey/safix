-- Atomic tranche release: updates escrow_tranches and escrow_payment_plans
-- in a single database transaction, eliminating the split-brain window where
-- the tranche row shows 'released' but the plan status has not been updated.
--
-- Called by:
--   api/release-tranche.ts  — after a successful Stripe Transfer creation
--   api/stripe-webhook.ts   — transfer.created handler for healing stuck states
--
-- Returns JSONB:
--   { outcome: 'released', plan_status: TEXT, tranche_count: INT, released_count: INT }
--   { outcome: 'not_found' }  — tranche row not found (wrong id or plan_id)
--   { outcome: 'already_recorded' } — transfer ref already persisted (idempotent)
CREATE OR REPLACE FUNCTION release_tranche_atomic(
  p_tranche_id   UUID,
  p_plan_id      UUID,
  p_transfer_id  TEXT,
  p_actor        TEXT,
  p_released_at  TIMESTAMPTZ DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_ref   text;
  v_plan_status    text;
  v_tranche_count  int;
  v_released_count int;
BEGIN
  -- Read the current external_release_ref to detect already-idempotent calls.
  SELECT external_release_ref
  INTO v_existing_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;  -- Row lock: prevents concurrent releases of the same tranche.

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- If this exact transfer ID is already recorded, the write is fully idempotent.
  -- Still recompute and update the plan status in case that write was missed.
  IF v_existing_ref IS DISTINCT FROM p_transfer_id THEN
    UPDATE escrow_tranches
    SET
      status               = 'released',
      released_at          = p_released_at,
      released_by          = p_actor,
      external_release_ref = p_transfer_id,
      updated_at           = now()
    WHERE id = p_tranche_id
      AND plan_id = p_plan_id;
  END IF;

  -- Read all tranches for the plan within the same transaction.
  -- Sees the updated state of the row above.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released')
  INTO v_tranche_count, v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id;

  IF v_tranche_count > 0 AND v_tranche_count = v_released_count THEN
    v_plan_status := 'fully_released';
  ELSIF v_released_count > 0 THEN
    v_plan_status := 'partially_released';
  ELSE
    v_plan_status := 'funded_in_escrow';
  END IF;

  UPDATE escrow_payment_plans
  SET
    status     = v_plan_status,
    updated_at = now()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'outcome',        CASE WHEN v_existing_ref IS NOT DISTINCT FROM p_transfer_id THEN 'already_recorded' ELSE 'released' END,
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION release_tranche_atomic(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION release_tranche_atomic(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION release_tranche_atomic(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_tranche_atomic(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
