-- =============================================================================
-- Migration: Block P · P3 CORE — payout-release corridor (destination-charge)
-- =============================================================================
-- WHY
--   P2 flips funding from platform-balance transfers to a Stripe DESTINATION
--   CHARGE: the application_fee is taken AT FUNDING and the NET sits on the
--   provider's connected account. P3 makes the matching RELEASE-side change —
--   a tranche release becomes `stripe.payouts.create` on the connected account
--   (money already there) instead of `stripe.transfers.create` from the platform
--   balance. The whole corridor flips on ONE server flag
--   (FUNDING_DESTINATION_CHARGE_ENABLED === 'true'); default OFF = transfer model,
--   byte-identical to today.
--
--   This migration is the DB half: it lets a single, signature-STABLE
--   release_tranche_with_ledger serve both corridors and adds the webhook
--   completion helper that flips a payout-initiated tranche to 'released' when
--   Stripe confirms `payout.paid`.
--
--   Source of truth = PROD DB (project itdntawwuzqfwmcwnwjr), verified live
--   2026-06-13 (escrow tables 0 rows). Repo migration files drift and are NOT
--   authoritative.
--
-- WHAT
--   1. escrow_tranches.external_payout_ref text — holds the po_* id for the
--      payout corridor (external_release_ref keeps tr_* for the transfer
--      corridor). Both nullable free-text, no CHECK.
--   2. CREATE OR REPLACE release_tranche_with_ledger on its EXACT P1.5 10-arg
--      signature (NO new params → flag-OFF call sites bind unchanged, no
--      DROP/overload/GRANT churn). The body routes by the Stripe id prefix
--      passed in p_transfer_id:
--        - 'tr_*' (or anything not 'po_*') -> TRANSFER branch, VERBATIM P1.5
--          behaviour: status='released', external_release_ref=id, plan rollup,
--          ledger 'payout' row. This is the flag-OFF safety contract.
--        - 'po_*'                          -> PAYOUT branch: status='release_pending',
--          external_payout_ref=id, NO plan rollup (release_pending ≠ released),
--          released_at stays NULL (set at payout.paid). The P1.5 ledger 'payout'
--          INSERT is kept VERBATIM (movement committed: money on the connected
--          account, payout initiated), deduped on (payment_id,entry_type,movement_ref).
--   3. complete_tranche_payout(text,text) SECDEF helper (service_role only):
--      payout.paid webhook calls it to flip release_pending -> released, set
--      released_at, and recompute the plan rollup with the SAME 3-state CASE —
--      keeping release+rollup money logic in SQL (single source, idempotent)
--      instead of duplicating the plan CASE in the webhook TS.
--   4. Status CHECK: NO CHANGE. escrow_tranches_status_check already allows
--      'release_pending' AND 'eligible_for_release' (verified live). A defensive,
--      idempotent guard rebuilds it ONLY if a drifted environment is missing
--      either value (no-op on prod).
--
-- 0-row-safe: escrow tables are empty on prod; the ADD COLUMN and CREATE OR
-- REPLACE are non-destructive. Idempotent (IF NOT EXISTS / IF EXISTS / guards).
--
-- DOES NOT touch prod. Gated — apply is a separate, explicitly-confirmed step.
-- =============================================================================

-- ── 1. Payout corridor reference column ──────────────────────────────────────
-- po_* for the destination-charge/payout corridor; external_release_ref keeps
-- tr_* for the transfer corridor. The repo TS (early idempotent-return, recovery
-- detection, response body) reads this to disambiguate a payout-model released
-- tranche (external_release_ref NULL) from a transfer-model one.
ALTER TABLE public.escrow_tranches
  ADD COLUMN IF NOT EXISTS external_payout_ref text;

-- ── 2. Defensive status-CHECK convergence (NO-OP on prod) ────────────────────
-- Prod escrow_tranches_status_check already contains both 'release_pending' and
-- 'eligible_for_release' (verified live 2026-06-13), so the eligible_for_release
-- -> release_pending -> released FSM is constraint-legal as-is. This block only
-- fires on a drifted environment whose constraint is missing either value; on
-- prod the position() checks pass and nothing changes.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.escrow_tranches'::regclass
    AND conname  = 'escrow_tranches_status_check';

  -- No status CHECK at all (drifted local where status is plain free text):
  -- leave it free text, nothing to extend.
  IF v_def IS NOT NULL
     AND (position('release_pending'      IN v_def) = 0
       OR position('eligible_for_release' IN v_def) = 0)
  THEN
    ALTER TABLE public.escrow_tranches
      DROP CONSTRAINT escrow_tranches_status_check;
    ALTER TABLE public.escrow_tranches
      ADD CONSTRAINT escrow_tranches_status_check
      CHECK (status = ANY (ARRAY[
        'pending_funding','funded','locked','eligible_for_release',
        'release_pending','released','blocked','disputed','refunded','cancelled'
      ]));
  END IF;
END $$;

-- ── 3. CREATE OR REPLACE release_tranche_with_ledger (corridor-routed) ────────
-- EXACT P1.5 10-arg signature retained. Routes by the Stripe id prefix in
-- p_transfer_id: 'po_*' -> PAYOUT branch (release_pending), else -> TRANSFER
-- branch (VERBATIM P1.5, released). The column ALTER above precedes this so
-- check_function_bodies validates the external_payout_ref reference at CREATE.
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
  v_is_payout        boolean;
BEGIN
  -- ── 1. Lock tranche row ────────────────────────────────────────────────────
  -- external_payout_ref added to the projection so the payout branch can run its
  -- own idempotency check.
  SELECT id, status, external_release_ref, external_payout_ref, kind
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

  -- Corridor discriminator: a Stripe payout id is 'po_*', a transfer id is 'tr_*'.
  -- The release handler passes payout.id under FUNDING_DESTINATION_CHARGE_ENABLED,
  -- transferId otherwise — so the id shape alone selects the branch and the
  -- signature stays stable for flag-OFF callers.
  v_is_payout := (p_transfer_id LIKE 'po\_%' ESCAPE '\');

  -- ═══════════════════════════════════════════════════════════════════════════
  -- PAYOUT BRANCH (destination-charge corridor): release_pending, await paid
  -- ═══════════════════════════════════════════════════════════════════════════
  IF v_is_payout THEN
    -- Idempotency: this exact payout already recorded on the tranche — safe no-op.
    IF v_tranche.external_payout_ref IS NOT NULL
       AND v_tranche.external_payout_ref = p_transfer_id
    THEN
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

    -- Initiate: payout created on the connected account, awaiting payout.paid.
    -- released_at is intentionally left at p_released_at (caller passes NULL);
    -- complete_tranche_payout sets it at paid. NO plan rollup — release_pending
    -- is not 'released', so the released-tranche count is unchanged.
    UPDATE escrow_tranches
    SET
      status              = 'release_pending',
      external_payout_ref = p_transfer_id,
      released_by         = p_actor,
      released_at         = p_released_at,
      updated_at          = now()
    WHERE id = p_tranche_id::uuid;

    v_outcome := 'release_pending';

    -- Ledger 'payout' row (prod-valid shape; same widened-key dedup as transfer
    -- branch). The movement is real at initiation: net money sits on the
    -- connected account and the payout is in flight. movement_ref = tranche_id
    -- keeps both tranche payouts distinct under the shared (payment,'payout') key.
    -- Guard unchanged: caller always passes p_payment_id + p_ledger_entry_id.
    IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
      INSERT INTO ledger_entries (
        payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
      )
      VALUES (
        p_payment_id::uuid,
        COALESCE(
          NULLIF(p_job_id, '')::uuid,
          (SELECT job_id FROM escrow_payment_plans WHERE id = p_plan_id::uuid)
        ),
        'payout',
        p_net_amount,
        p_currency,
        jsonb_build_object(
          'note',       'Tranche released via Stripe payout ' || p_transfer_id,
          'payout_id',  p_transfer_id,
          'actor',      p_actor,
          'tranche_id', p_tranche_id
        ),
        p_tranche_id
      )
      ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
    END IF;

    -- Counts for the response only — plan status is NOT advanced here.
    SELECT COUNT(*) INTO v_total
    FROM escrow_tranches WHERE plan_id = p_plan_id::uuid;
    SELECT COUNT(*) INTO v_released_count
    FROM escrow_tranches
    WHERE plan_id = p_plan_id::uuid
      AND status = 'released'
      AND transfer_reversal_ref IS NULL;

    RETURN jsonb_build_object(
      'outcome',           v_outcome,
      'plan_status',       (SELECT status FROM escrow_payment_plans WHERE id = p_plan_id::uuid),
      'total_tranches',    v_total,
      'released_tranches', v_released_count
    );
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- TRANSFER BRANCH (flag-OFF, VERBATIM P1.5): released immediately
  -- ═══════════════════════════════════════════════════════════════════════════

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

  -- ── 5. Ledger entry (prod-valid shape; best-effort within same tx) ─────────
  -- A tranche release moves NET escrowed money OUT to the provider via a Stripe
  -- transfer = the canonical 'payout' movement. Both deposit_release and
  -- final_release map to 'payout'; the (payment_id,'payout') collision is solved
  -- structurally by movement_ref = p_tranche_id (each tranche is a distinct row).
  -- id omitted  -> DEFAULT gen_random_uuid()
  -- created_at omitted -> DEFAULT now() (timestamptz; never epoch-ms)
  -- legacy 'type' left NULL; the note string moves into metadata jsonb.
  -- Guard unchanged: the caller always passes both p_payment_id + p_ledger_entry_id.
  IF p_payment_id IS NOT NULL AND p_ledger_entry_id IS NOT NULL THEN
    INSERT INTO ledger_entries (
      payment_id, job_id, entry_type, amount, currency, metadata, movement_ref
    )
    VALUES (
      p_payment_id::uuid,
      COALESCE(
        NULLIF(p_job_id, '')::uuid,
        (SELECT job_id FROM escrow_payment_plans WHERE id = p_plan_id::uuid)
      ),
      'payout',
      p_net_amount,
      p_currency,
      jsonb_build_object(
        'note',        'Tranche released via Stripe transfer ' || p_transfer_id,
        'transfer_id', p_transfer_id,
        'actor',       p_actor,
        'tranche_id',  p_tranche_id
      ),
      p_tranche_id
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'outcome',           v_outcome,
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;

-- Restrict to service_role only (re-issued verbatim on the unchanged signature).
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM anon;
REVOKE ALL     ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_tranche_with_ledger(text,text,text,text,timestamptz,numeric,text,text,text,text) TO service_role;

-- ── 4. complete_tranche_payout — payout.paid completion (release_pending->released)
-- Called by the stripe-webhook payout.paid handler after it resolves the tranche
-- (metadata.tranche_id or external_payout_ref = po_*). Flips the tranche to
-- 'released', stamps released_at, and recomputes the plan rollup with the SAME
-- 3-state CASE used by the transfer branch — money/rollup logic lives in SQL,
-- not duplicated in TS. Idempotent: a re-delivered paid event finds the tranche
-- already 'released' (0-row guard on the status-scoped UPDATE) and no-ops.
CREATE OR REPLACE FUNCTION public.complete_tranche_payout(
  p_tranche_id text,
  p_payout_id  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tranche         RECORD;
  v_plan_id         uuid;
  v_total           bigint;
  v_released_count  bigint;
  v_plan_status     text;
BEGIN
  SELECT id, status, plan_id
  INTO v_tranche
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  v_plan_id := v_tranche.plan_id;

  -- Idempotent guard: only a release_pending tranche advances. A re-delivered
  -- paid event (already 'released') or an unexpected state is a safe no-op.
  IF v_tranche.status <> 'release_pending' THEN
    RETURN jsonb_build_object(
      'outcome', CASE WHEN v_tranche.status = 'released'
                      THEN 'already_released' ELSE 'skipped' END,
      'status',  v_tranche.status
    );
  END IF;

  -- Advance the tranche. COALESCE keeps an existing po ref but backfills it from
  -- p_payout_id if the tranche was resolved purely via metadata.tranche_id.
  UPDATE escrow_tranches
  SET
    status              = 'released',
    released_at         = now(),
    external_payout_ref = COALESCE(external_payout_ref, p_payout_id),
    updated_at          = now()
  WHERE id = p_tranche_id::uuid
    AND status = 'release_pending';

  -- Plan rollup — identical CASE to release_tranche_with_ledger's transfer branch.
  SELECT COUNT(*) INTO v_total
  FROM escrow_tranches WHERE plan_id = v_plan_id;

  SELECT COUNT(*) INTO v_released_count
  FROM escrow_tranches
  WHERE plan_id = v_plan_id
    AND status = 'released'
    AND transfer_reversal_ref IS NULL;

  v_plan_status := CASE
    WHEN v_released_count >= v_total THEN 'fully_released'
    WHEN v_released_count > 0        THEN 'partially_released'
    ELSE                                  'funded_in_escrow'
  END;

  UPDATE escrow_payment_plans
  SET status = v_plan_status, updated_at = now()
  WHERE id = v_plan_id;

  RETURN jsonb_build_object(
    'outcome',           'released',
    'plan_status',       v_plan_status,
    'total_tranches',    v_total,
    'released_tranches', v_released_count
  );
END;
$$;

-- service_role only.
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM anon;
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_tranche_payout(text,text) TO service_role;

-- ── 5. Defensive PostgREST schema-cache reload ───────────────────────────────
NOTIFY pgrst, 'reload schema';
