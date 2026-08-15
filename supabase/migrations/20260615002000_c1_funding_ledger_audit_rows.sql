-- 20260615002000_c1_funding_ledger_audit_rows.sql
-- C1 Funding-Ledger: write escrow_deposit + platform_fee audit rows on funding completion.
--
-- SOURCE OF TRUTH = PROD. The body below is kept VERBATIM from the live
-- definition of public.confirm_funding_atomic(uuid,uuid,text) (== repo migration
-- 20260415000002, confirmed byte-identical against project itdntawwuzqfwmcwnwjr)
-- EXCEPT for one added nested block in the 'confirmed' path: after the tranche
-- update and guarded by p_escrow_plan_id IS NOT NULL, it INSERTs two audit rows.
--
-- WHY HERE: this RPC is the single shared atomic chokepoint where funding
-- completes for BOTH callers — api/confirm-funding.ts (browser) and
-- api/stripe-webhook.ts → reconcileFundingConfirmation (payment_intent.succeeded,
-- metadata.type='escrow_funding'). Extending it once covers both, commits the
-- ledger rows in the SAME transaction as the state flip, and is idempotent.
--
-- SHAPE: matches the prod money-movement ledger shape exactly (mirrors
-- api/_releaseSupplementaryPayout.ts lines 320-352):
--   * amount is bare numeric in EUR MAJOR units (NOT cents); CHECK amount>=0.
--   * escrow_deposit.amount = escrow_payment_plans.total_amount (GROSS held amount,
--     so gross = payout_net + platform_fee closes at full release).
--   * platform_fee.amount = escrow_payment_plans.platform_fee_amount
--     (the application fee initiate-funding snapshots),
--     COALESCE → round(total_amount * platform_fee_rate, 2).
--   * entry_type 'escrow_deposit' / 'platform_fee' are ALREADY in the prod
--     ledger_entries_entry_type_check (full set verified live: escrow_deposit,
--     platform_fee, payout, refund, dispute_hold, refund_partial,
--     payout_adjustment, escrow_release, escrow_refund) → NO enum/CHECK change.
--   * movement_ref = escrow_plan_id::text → stable across browser-confirm +
--     webhook + redeliveries; distinct from supplementary (movement_ref=sprId)
--     and from payout (movement_ref=tranche_id) rows on the same payment_id.
--   * legacy nullable `type` column left NULL (movement model) — these rows are
--     invisible to every client finance selector (SupabaseLedgerRepository maps
--     the legacy `type`, NULL here), exactly like the existing 'payout' rows.
--
-- IDEMPOTENCY: (1) already-funded redeliveries return 'already_funded' before the
-- INSERT; (2) both callers pass the same p_escrow_plan_id, so the second writer
-- hits ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING (arbiter =
-- UNIQUE INDEX ledger_entries_payment_entrytype_movement_uidx, P1.5/20260613010000);
-- (3) one PL/pgSQL transaction → state flip + ledger rows commit together.
-- Requires payment_id NON-NULL (Postgres treats NULLs as distinct in the unique
-- key) → v_pay_id IS NOT NULL guard, mirroring release_tranche_with_ledger.
--
-- GRANT POSTURE: CREATE OR REPLACE re-grants EXECUTE to PUBLIC via default
-- privileges, which would REOPEN the H9 PostgREST bypass (authenticated users
-- calling the RPC directly, skipping the Stripe-PI verify). This migration
-- therefore RE-ISSUES the exact 20260610153000 posture verbatim
-- (REVOKE ALL FROM PUBLIC/anon/authenticated + GRANT EXECUTE TO service_role).
--
-- DORMANT / AUDIT-ONLY: no money movement; when no funding completes the function
-- is byte-identical in effect. It only adds audit rows on a real funding flip.
--
-- ⚠️ DOWNSTREAM ACTIVATION (out of scope for C1, flagged): these rows are
-- invisible only because SupabaseLedgerRepository maps the legacy `type`. If the
-- reader is later repointed to entry_type (deferred Block P2/P3 taxonomy
-- unification), platform_fee would start counting in getRevenue/getOpenEscrow AND
-- craftsmanPayoutSummary already ADDS a separately-estimated releasedFee for
-- released tranches ("No ledger row exists yet") → DOUBLE-COUNT of
-- platformFeeCollected. Repointing the reader MUST unify the taxonomy + drop that
-- estimate in the same change.
--
-- ⚠️ NOT APPLIED: write-only migration. apply is a separate explicit human gate.

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

    -- ── 4. C1 Funding-Ledger audit rows (audit-only, no money movement) ──
    -- Idempotent via ON CONFLICT on UNIQUE(payment_id, entry_type, movement_ref).
    -- Skips when no payments row resolves (non-fatal audit gap, mirrors
    -- release_tranche_with_ledger). movement_ref = escrow_plan_id::text.
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

      -- Deterministic attribution: pin to the oldest payments row for the job
      -- (one-payment-per-job today; ORDER BY makes both callers + redeliveries
      --  resolve the SAME payment_id so the movement_ref idempotency key holds
      --  even in a hypothetical multi-payment edge — audit-trail correctness).
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

  -- ── Return result ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'funding_request_updated', v_fr_updated,
    'escrow_plan_updated', v_ep_updated,
    'tranches_updated', v_tranches_updated
  );
END;
$$;

-- ── Re-issue H9 grant posture (20260610153000) verbatim ─────────────────────
-- CREATE OR REPLACE re-grants EXECUTE to PUBLIC via default privileges; revoke it
-- again so authenticated users cannot call the RPC directly via PostgREST and
-- bypass the API-side Stripe-PI verify.
REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM authenticated;

-- service_role loses its implicit access through the PUBLIC revoke → grant explicitly
GRANT EXECUTE ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
