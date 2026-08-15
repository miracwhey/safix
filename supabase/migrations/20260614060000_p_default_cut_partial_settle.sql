-- =============================================================================
-- Migration: Block P · Batch 3 — T+80 default SETTLE flips to 75/25 PARTIAL
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- Sequenced AFTER 20260614050000_p_default_cut_partial_75_25.sql.
-- DO NOT APPLY without explicit user confirm.
--
-- THE SETTLE-FIX (resolves the #1 flip-blocker F1).
--   Batch 2 (20260614050000) made apply_dispute_default_refund stamp
--   resolution_type='refund_partial' + split_ratio=0.25 + the held-remainder
--   snapshot disputes.default_refund_minor (MINOR/cents). The worker now refunds
--   only the still-HELD 75% tranche. BUT settle_dispute_default (still from
--   20260614040000) kept doing a FULL settle:
--     (1) marked the WHOLE escrow plan 'refunded',
--     (2) flipped EVERY non-refunded tranche with transfer_reversal_ref IS NULL
--         to 'refunded' — INCLUDING the already-released 25% deposit tranche
--         (WRONG — it was paid out and is never clawed back on a default),
--     (3) wrote a ledger 'refund' row over the FULL total_amount,
--     (4) forced payments / jobs / project to 'refunded' (full-refund FSM).
--   Only DORMANCY (FUNDING_DESTINATION_CHARGE_ENABLED unset, 0 dispute rows in
--   prod) made that harmless. This migration fixes it.
--
-- WHAT this migration does (additive, idempotent, 0-row-safe — CREATE OR REPLACE
--   only; no schema/column changes):
--   1. CREATE OR REPLACE settle_dispute_default(uuid) — body from 20260614040000
--      with four PARTIAL deltas:
--        (a) TRANCHES: refund ONLY the still-HELD tranches via the SHARED held
--            predicate (byte-identical to Batch 2 + api/_disputeDefaultCut.ts).
--            The released 25% tranche STAYS as-is (never reversed).
--        (b) LEDGER: amount = disputes.default_refund_minor snapshot (G3 single
--            source) instead of total_amount; entry_type 'refund' → 'refund_partial';
--            metadata = held / released_retained / real shares (F3) / fee context.
--        (c) PAYMENTS/JOBS/PROJECT: NOT touched and plan NOT forced to 'refunded'.
--            Mirrors settle_consensus_split (20260614020000) exactly — that RPC
--            only flips the dispute settlement_status pending→settled and leaves
--            the plan/payment/job/project FSM untouched, because work was partly
--            performed (Option B = consensus-split pattern, NOT a full-refund FSM).
--        (d) PLAN LOCK (G2/A1): take escrow_payment_plans FOR UPDATE before any
--            tranche/plan write — global lock order Plan → Tranche.
--   2. CREATE OR REPLACE complete_tranche_payout(text,text) — body from
--      20260613020000 verbatim, with the SAME plan-before-tranche lock order so
--      both corridor settlers acquire escrow_payment_plans before escrow_tranches
--      (G2 deadlock fix + A1 write-skew fix).
--
-- SHARED HELD PREDICATE (G4 — byte-identical to 20260614050000 and
--   api/_disputeDefaultCut.ts). A tranche is "held" (still in escrow, owed back to
--   the customer on a default) when:
--     status NOT IN ('released','release_pending')
--     AND external_release_ref  IS NULL   -- no tr_* transfer recorded
--     AND external_payout_ref   IS NULL   -- no po_* payout recorded
--     AND transfer_reversal_ref IS NULL   -- not already reversed
--
-- Prod currently has 0 rows in disputes/escrow_payment_plans/escrow_tranches/
--   ledger_entries — this migration is 0-row-safe and non-destructive. Gated
--   behind FUNDING_DESTINATION_CHARGE_ENABLED at the caller level; dormant when
--   the flag is not set.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. settle_dispute_default(p_dispute_id uuid) — now 75/25 PARTIAL settle
-- ---------------------------------------------------------------------------
-- Called by the T+80 cron worker after the Stripe partial refund (of the held
-- remainder) succeeds. Flips dispute settlement_status pending→settled, refunds
-- ONLY the held tranches, and writes a refund_partial ledger row over the held
-- snapshot. It deliberately does NOT touch the escrow plan status, payments,
-- jobs, or project — the released 25% stays with the craftsman, so this is NOT a
-- full-refund terminal (Option B = settle_consensus_split pattern).
--
-- Called by service_role only (T+80 cron worker). auth.uid() IS NULL in this
-- context → disputes_status_change_guard branch (b) admits the settlement flip
-- unconditionally; no sentinel is needed (same as 20260614040000).
--
-- Precondition: dispute must be status='resolved' AND decision='refund'
-- (set by apply_dispute_default_refund or an operator refund decision).
--
-- Idempotent: if settlement_status is already 'settled', returns the row
-- unchanged with no error. Safe for cron retry; the per-dispute ledger
-- movement_ref + ON CONFLICT DO NOTHING make the ledger write exactly-once.
CREATE OR REPLACE FUNCTION public.settle_dispute_default(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status            text;
  v_decision          text;
  v_settlement_status text;
  v_job_id            uuid;
  v_plan_id           uuid;
  v_total             numeric;
  v_currency          text;
  v_fee_total         numeric;
  v_fee_rate          numeric;
  v_payment_id        uuid;
  v_refund_minor      bigint;   -- held-remainder snapshot (MINOR/cents), G3 single source
  v_total_minor       bigint;
  v_retained_minor    bigint;
  v_refund_ratio      numeric;
  v_retained_ratio    numeric;
  v_fee_refunded      numeric;
  v_result            jsonb;
BEGIN
  -- Lock the dispute row. Read the held-remainder snapshot (default_refund_minor,
  -- MINOR units) stamped by apply_dispute_default_refund — the SINGLE SOURCE for
  -- the ledger amount (G3). The settle NEVER recomputes the held set.
  SELECT d.status, d.decision, d.settlement_status, d.job_id, d.default_refund_minor
    INTO v_status, v_decision, v_settlement_status, v_job_id, v_refund_minor
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: already settled → return current row unchanged.
  -- Safe for cron retry (feedback_agentic_loop_retry_reexecutes_side_effects).
  IF v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- Precondition: must be resolved/refund (set by apply_dispute_default_refund
  -- or an operator refund decision).
  IF v_status IS DISTINCT FROM 'resolved'
     OR v_decision IS DISTINCT FROM 'refund'
  THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % has status=%, decision=%; '
                    'expected status=resolved and decision=refund',
      p_dispute_id,
      COALESCE(v_status,   'null'),
      COALESCE(v_decision, 'null')
      USING ERRCODE = 'P0001';
  END IF;

  -- Resolve escrow plan for this job (may be NULL if no plan was ever created).
  -- Also read platform_fee_amount / platform_fee_rate for the ledger fee context.
  SELECT epp.id, epp.total_amount, epp.currency,
         epp.platform_fee_amount, epp.platform_fee_rate
    INTO v_plan_id, v_total, v_currency, v_fee_total, v_fee_rate
    FROM public.escrow_payment_plans epp
   WHERE epp.job_id = v_job_id
   LIMIT 1;

  -- (d) G2 / A1 PLAN LOCK — take the plan row lock BEFORE any tranche/plan write.
  -- Global lock order is Plan → Tranche in BOTH corridor settlers
  -- (complete_tranche_payout below + this function), eliminating the ABBA deadlock
  -- and the write-skew between a concurrent payout-completion and this default
  -- settle on the same plan.
  IF v_plan_id IS NOT NULL THEN
    PERFORM 1 FROM public.escrow_payment_plans WHERE id = v_plan_id FOR UPDATE;
  END IF;

  -- Resolve payment for the ledger deduplication key. NEVER insert a NULL
  -- payment_id ledger row: the unique index (payment_id, entry_type, movement_ref)
  -- treats NULL as distinct so ON CONFLICT DO NOTHING would not deduplicate.
  SELECT p.id INTO v_payment_id
    FROM public.payments p
   WHERE p.job_id = v_job_id
   LIMIT 1;

  -- ── Derive the REAL 75/25 shares from the held snapshot (F3) ──────────────
  -- total_minor = plan total × 100; held = the snapshot; retained = total − held.
  -- The audit shares are computed from held/total (the actual cut), NOT from the
  -- nominal 0.25 split_ratio stamped on the dispute.
  v_total_minor    := round(COALESCE(v_total, 0) * 100)::bigint;
  v_refund_minor   := COALESCE(v_refund_minor, 0);
  v_retained_minor := GREATEST(v_total_minor - v_refund_minor, 0);
  IF v_total_minor > 0 THEN
    v_refund_ratio   := round(v_refund_minor::numeric   / v_total_minor, 4);
    v_retained_ratio := round(v_retained_minor::numeric / v_total_minor, 4);
  ELSE
    v_refund_ratio   := 0;
    v_retained_ratio := 0;
  END IF;
  -- Platform fee follows the refunded money proportionally (refundApplicationFee
  -- is true on the Stripe call). Audit estimate only — Stripe is authoritative.
  v_fee_refunded := round(COALESCE(v_fee_total, 0) * v_refund_ratio, 2);

  -- Flip settlement on the dispute (pending → settled). service_role context
  -- (auth.uid() IS NULL) → disputes_status_change_guard branch (b) admits this
  -- write; no sentinel needed. No other lifecycle field changes.
  UPDATE public.disputes
     SET settlement_status = 'settled',
         updated_at        = now()
   WHERE id = p_dispute_id;

  -- (a) PARTIAL TRANCHE REFUND — refund ONLY the still-HELD tranches via the
  -- SHARED held predicate (byte-identical to Batch 2 / api/_disputeDefaultCut.ts).
  -- The already-released 25% tranche (status released/release_pending, or carrying
  -- an external_release_ref / external_payout_ref, or already reversed) is EXCLUDED
  -- and STAYS as-is — it was paid out to the craftsman and is never clawed back by
  -- the default.
  --
  -- (c) The plan status is NOT forced to 'refunded' (mirrors settle_consensus_split
  -- which leaves the plan/payment/job/project FSM untouched): the work was partly
  -- performed, so this is NOT a full-refund terminal. The plan keeps its existing
  -- (partially_released) rollup.
  IF v_plan_id IS NOT NULL THEN
    UPDATE public.escrow_tranches
       SET status     = 'refunded',
           updated_at = now()
     WHERE plan_id = v_plan_id
       AND status NOT IN ('released', 'release_pending')
       AND external_release_ref  IS NULL
       AND external_payout_ref   IS NULL
       AND transfer_reversal_ref IS NULL;
  END IF;

  -- (b) LEDGER — record the PARTIAL refund movement.
  --   amount     = the held-remainder snapshot (G3 single source) in MAJOR units.
  --   entry_type = 'refund_partial' (a live, CHECK-allowed value) — NOT 'refund'.
  --   metadata   = held / released_retained / REAL shares (F3) / fee context.
  -- Only when a payment row exists AND something was actually refunded — a
  -- held-zero default (escrow already fully released before T+80) moves no money,
  -- so it writes no ledger row.
  IF v_payment_id IS NOT NULL AND v_refund_minor > 0 THEN
    INSERT INTO public.ledger_entries
      (payment_id, job_id, dispute_id, entry_type, amount, currency, movement_ref, metadata)
    VALUES (
      v_payment_id,
      v_job_id,
      p_dispute_id,
      'refund_partial',
      v_refund_minor::numeric / 100,
      COALESCE(v_currency, 'EUR'),
      p_dispute_id::text,          -- movement_ref = dispute uuid (stable, unique per dispute)
      jsonb_build_object(
        'source',                  't80_default',
        'resolution_type',         'refund_partial',
        'held_minor',              v_refund_minor,
        'released_retained_minor', v_retained_minor,
        'total_minor',             v_total_minor,
        -- F3: REAL shares from the held snapshot, NOT the nominal 0.25.
        'split_ratio',             v_retained_ratio,   -- provider-retained = released_retained/total
        'refund_ratio',            v_refund_ratio,     -- customer-refunded  = held/total
        'fee', jsonb_build_object(
                 'platform_fee_amount',   COALESCE(v_fee_total, 0),
                 'platform_fee_rate',     v_fee_rate,
                 'platform_fee_refunded', v_fee_refunded
               )
      )
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  -- (c) payments / jobs / project: INTENTIONALLY NOT TOUCHED. The 75/25 partial
  -- default is NOT a full-refund FSM — the craftsman performed (and keeps) the
  -- released 25%, so forcing payments/jobs/project to 'refunded' would corrupt the
  -- Payment/Job/Project FSM. This mirrors settle_consensus_split exactly.

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_dispute_default(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_dispute_default(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_dispute_default(uuid) IS
  'P4 Batch 3 · T+80 default cut (75/25 PARTIAL settle): settles a default-refund '
  'dispute after Stripe confirms the partial refund of the held remainder. Flips '
  'settlement_status pending→settled, refunds ONLY the still-HELD tranches (shared '
  'held predicate), and writes a refund_partial ledger row over the '
  'default_refund_minor snapshot (G3). Does NOT mark the plan refunded and does NOT '
  'touch payments/jobs/project — the released 25% stays with the craftsman (Option B '
  '= settle_consensus_split pattern). Takes escrow_payment_plans FOR UPDATE before '
  'any tranche/plan write (Plan→Tranche lock order). SECURITY DEFINER. service_role '
  'ONLY (T+80 cron worker). Idempotent: already-settled rows return unchanged. '
  'Gated behind FUNDING_DESTINATION_CHARGE_ENABLED=true at the caller level; dormant '
  'when the flag is not set.';

-- ---------------------------------------------------------------------------
-- 2. complete_tranche_payout(text,text) — Plan→Tranche lock order (G2/A1)
-- ---------------------------------------------------------------------------
-- Body from 20260613020000 VERBATIM, with ONE change: resolve the plan id with an
-- unlocked read and take the plan FOR UPDATE lock BEFORE the existing tranche
-- FOR UPDATE. This makes both corridor settlers (this function +
-- settle_dispute_default above) acquire escrow_payment_plans before
-- escrow_tranches, eliminating the ABBA deadlock and the A1 write-skew between a
-- concurrent payout-completion and a default-settle on the same plan.
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
  -- GLOBAL LOCK ORDER (Plan → Tranche): resolve the plan id WITHOUT a row lock
  -- first, take the plan lock, THEN lock the tranche. Identical ordering to
  -- settle_dispute_default → no ABBA deadlock / write-skew.
  SELECT plan_id INTO v_plan_id
  FROM escrow_tranches
  WHERE id = p_tranche_id::uuid;

  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  PERFORM 1 FROM escrow_payment_plans WHERE id = v_plan_id FOR UPDATE;

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

-- service_role only (verbatim from 20260613020000).
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM anon;
REVOKE ALL     ON FUNCTION public.complete_tranche_payout(text,text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_tranche_payout(text,text) TO service_role;

COMMENT ON FUNCTION public.complete_tranche_payout(text,text) IS
  'P3 + P4 Batch 3: payout.paid completion (release_pending→released) with plan '
  'rollup. Takes escrow_payment_plans FOR UPDATE before the tranche lock '
  '(Plan→Tranche order, identical to settle_dispute_default) → G2 deadlock fix + '
  'A1 write-skew fix. SECURITY DEFINER, service_role only. Idempotent: a '
  're-delivered paid event finds the tranche already released and no-ops.';

-- ---------------------------------------------------------------------------
-- 3. Schema cache reload
-- ---------------------------------------------------------------------------
-- Required after every MCP-apply migration (feedback_postgrest_schema_cache_reload).
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- (run manually to undo — NOT via apply_migration)
-- =============================================================================
--
-- -- Restore the full-refund settle body + the original tranche-first lock order
-- -- by re-applying the settle_dispute_default definition from 20260614040000 and
-- -- the complete_tranche_payout definition from 20260613020000 verbatim, then:
-- NOTIFY pgrst, 'reload schema';
--
-- No column/schema changes were made by this migration, so nothing else to undo.
-- =============================================================================
