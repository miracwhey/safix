-- Adds transfer_reversal_ref to escrow_tranches and introduces
-- reconcile_transfer_reversal_atomic for atomic webhook-driven reversal handling.
--
-- Also re-creates release_tranche_atomic with an updated COUNT that excludes
-- reversed tranches — keeping plan-status rollup accurate after reversals.

-- ── Schema ────────────────────────────────────────────────────────────────────

ALTER TABLE escrow_tranches
  ADD COLUMN IF NOT EXISTS transfer_reversal_ref TEXT;

-- ── release_tranche_atomic (updated) ─────────────────────────────────────────
-- Re-created here to fix the plan-rollup COUNT: reversed tranches
-- (transfer_reversal_ref IS NOT NULL) must not count as released.

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
  SELECT external_release_ref
  INTO v_existing_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

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

  -- Exclude reversed tranches from the released count.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released' AND transfer_reversal_ref IS NULL)
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

-- ── reconcile_transfer_reversal_atomic ────────────────────────────────────────
--
-- Called by: api/stripe-webhook.ts — transfer.reversed handler
--
-- Records the reversal against the tranche (sets transfer_reversal_ref) and
-- recomputes the plan-status rollup excluding reversed tranches.
--
-- Idempotent: re-delivering the same reversal ref is a no-op on the tranche row.
--
-- Returns JSONB:
--   { outcome: 'reversed', plan_status: TEXT, tranche_count: INT, released_count: INT }
--   { outcome: 'already_recorded' }  — same reversal ref already persisted
--   { outcome: 'not_found' }         — tranche not found for (id, plan_id)

CREATE OR REPLACE FUNCTION reconcile_transfer_reversal_atomic(
  p_tranche_id    UUID,
  p_plan_id       UUID,
  p_reversal_ref  TEXT,
  p_reversed_at   TIMESTAMPTZ DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_reversal_ref text;
  v_plan_status           text;
  v_tranche_count         int;
  v_released_count        int;
BEGIN
  SELECT transfer_reversal_ref
  INTO v_existing_reversal_ref
  FROM escrow_tranches
  WHERE id = p_tranche_id AND plan_id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_existing_reversal_ref IS NOT DISTINCT FROM p_reversal_ref THEN
    RETURN jsonb_build_object('outcome', 'already_recorded');
  END IF;

  UPDATE escrow_tranches
  SET
    transfer_reversal_ref = p_reversal_ref,
    updated_at            = p_reversed_at
  WHERE id = p_tranche_id
    AND plan_id = p_plan_id;

  -- Recompute plan status: reversed tranches do not count as released.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'released' AND transfer_reversal_ref IS NULL)
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
    'outcome',        'reversed',
    'plan_status',    v_plan_status,
    'tranche_count',  v_tranche_count,
    'released_count', v_released_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION reconcile_transfer_reversal_atomic(UUID, UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_transfer_reversal_atomic(UUID, UUID, TEXT, TIMESTAMPTZ) FROM anon;
REVOKE EXECUTE ON FUNCTION reconcile_transfer_reversal_atomic(UUID, UUID, TEXT, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION reconcile_transfer_reversal_atomic(UUID, UUID, TEXT, TIMESTAMPTZ) TO service_role;
