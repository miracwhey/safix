-- =============================================================================
-- Migration: Block 1 – release_tranche_with_ledger RPC
-- =============================================================================
-- Replaces the call-site-split pattern (release_tranche_atomic + separate
-- ledger write) with a single DB-transaction function that atomically:
--   1. Updates escrow_tranches (status, external_release_ref, released_at)
--   2. Rolls up escrow_payment_plans.status
--   3. Inserts a ledger_entries row of type 'tranche_release'
--
-- The ledger write requires a payment_id (FK to payments).  The caller
-- (api/release-tranche.ts) resolves this before calling the RPC and passes
-- it as p_payment_id.  If p_payment_id is NULL or p_ledger_entry_id is NULL
-- the ledger step is skipped silently — the tranche + plan update still
-- commits atomically.
--
-- Returns the same JSON shape as release_tranche_atomic so the API caller
-- needs minimal changes.
-- =============================================================================

-- Add 'tranche_release' to the type constraint on ledger_entries if the
-- constraint exists (some deployments have a CHECK constraint on type).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name   = 'ledger_entries_type_check'
  ) THEN
    -- Drop and recreate the constraint to include 'tranche_release'.
    -- The previous constraint was added by 20260413000002_supplementary_payment_v3_payout.sql
    -- and did not include this type.  INSERT of type='tranche_release' would
    -- violate it, so we expand it here.
    ALTER TABLE ledger_entries
      DROP CONSTRAINT IF EXISTS ledger_entries_type_check;

    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_type_check
        CHECK (type IN (
          'escrow_created', 'deposit_paid', 'final_paid', 'platform_fee',
          'payout', 'refund', 'dispute_hold', 'dispute_resolved_release',
          'dispute_resolved_refund', 'supplementary_created',
          'supplementary_funded', 'supplementary_platform_fee', 'supplementary_payout',
          'tranche_release'
        ));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.release_tranche_with_ledger(
  p_tranche_id       text,
  p_plan_id          text,
  p_transfer_id      text,
  p_actor            text,
  p_released_at      timestamptz,
  p_net_amount       numeric,
  p_currency         text    DEFAULT 'EUR',
  p_payment_id       text    DEFAULT NULL,
  p_job_id           text    DEFAULT NULL,
  p_ledger_entry_id  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche          RECORD;
  v_total            bigint;
  v_released_count   bigint;
  v_plan_status      text;
  v_outcome          text;
BEGIN
  -- ── 1. Lock tranche row ────────────────────────────────────────────────────
  SELECT id, status, external_release_ref, kind
  INTO v_tranche
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome',          'not_found',
      'plan_status',      null,
      'total_tranches',   0,
      'released_tranches',0
    );
  END IF;

  -- ── 2. Idempotency check ───────────────────────────────────────────────────
  IF v_tranche.external_release_ref IS NOT NULL
     AND v_tranche.external_release_ref = p_transfer_id
  THEN
    -- Already recorded this exact transfer — safe no-op
    SELECT COUNT(*) INTO v_total
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
    SELECT COUNT(*) INTO v_released_count
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid AND status = 'released';
    RETURN jsonb_build_object(
      'outcome',           'already_recorded',
      'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
      'total_tranches',    v_total,
      'released_tranches', v_released_count
    );
  END IF;

  -- ── 3. Update tranche ─────────────────────────────────────────────────────
  UPDATE escrow_tranches
  SET
    status               = 'released',
    external_release_ref = p_transfer_id,
    released_by          = p_actor,
    released_at          = p_released_at,
    updated_at           = now()
  WHERE id = p_tranche_id::uuid;

  v_outcome := 'released';

  -- ── 4. Plan status rollup ─────────────────────────────────────────────────
  SELECT COUNT(*) INTO v_total
  FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;

  -- Exclude reversed tranches — mirrors the fix in 20260417000002_reversal_model.sql
  SELECT COUNT(*) INTO v_released_count
  FROM escrow_tranches
  WHERE plan_id = p_plan_id::uuid
    AND status = 'released'
    AND transfer_reversal_ref IS NULL;

  v_plan_status := CASE
    WHEN v_released_count >= v_total THEN 'fully_released'
    WHEN v_released_count > 0        THEN 'partially_released'
    ELSE                                  'funded_in_escrow'
  END;

  UPDATE escrow_payment_plans
  SET status = v_plan_status, updated_at = now()
  WHERE id = p_plan_id::uuid;

  -- ── 5. Ledger entry (best-effort within same transaction) ─────────────────
  -- Requires both p_payment_id and p_ledger_entry_id to be non-null.
  -- p_job_id is denormalised for fast lookup; falls back to plan.job_id.
  IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
    INSERT INTO ledger_entries (
      id, payment_id, job_id, type, amount, currency, created_at, note
    )
    VALUES (
      p_ledger_entry_id,
      p_payment_id,
      COALESCE(p_job_id, (SELECT job_id::text FROM escrow_payment_plans WHERE id = p_plan_id::uuid)),
      'tranche_release',
      p_net_amount,
      p_currency,
      (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
      'Tranche released via Stripe transfer ' || p_transfer_id
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome',           v_outcome,
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;

-- Restrict to service_role only (same as release_tranche_atomic)
REVOKE ALL   ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM anon;
REVOKE ALL   ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) TO service_role;
