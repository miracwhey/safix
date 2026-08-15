-- =============================================================================
-- Migration: Block P · Batch 4 — shared corridor split-settle relocation (A1-b)
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- Sequenced AFTER 20260614060000_p_default_cut_partial_settle.sql.
-- DO NOT APPLY without explicit user confirm (passive migration; apply is a
-- separate, explicitly-confirmed step).
--
-- WHY (the settlement_status leak — corridor-gated, dormant today)
--   Under the destination-charge corridor (FUNDING_DESTINATION_CHARGE_ENABLED ON)
--   every operator/consensus dispute resolution that moves money to the craftsman
--   (RELEASE / REJECT / operator-SPLIT / consensus-SPLIT) drives an ASYNC payout
--   through releaseEscrowWorkflow's tranche bridge. The bridge therefore reports
--   bridgeFullySucceeded=false (the tranche is release_pending, not released), so
--   the CLIENT never calls settleDispute()/settle_consensus_split. The payout.paid
--   webhook (completePayoutCorridorTranche) settles the PAYMENT on fully_released
--   but DELIBERATELY does not settle the DISPUTE (its own KNOWN-DEFERRED comment).
--   The T+80 cron's settle_dispute_default only handles auto-defaults
--   (default_applied_at IS NOT NULL). Result: disputes.settlement_status stays
--   'pending' forever for operator/consensus corridor resolutions. (The operator
--   FULL-REFUND path is the one exception: it uses the synchronous refundEscrow
--   path and settles client-side, so it is NOT leaked.)
--
-- WHAT this migration does (additive, idempotent, 0-row-safe — CREATE OR REPLACE
--   only; no schema/column/index changes):
--   1. CREATE settle_dispute_resolution(uuid) — the ONE generalized, service_role
--      shared settler used by BOTH the payout.paid webhook (operator/consensus
--      release/reject/split) AND, via delegation, the T+80 cron (auto-default).
--      It is the Batch 3 settle_dispute_default body generalized along two axes:
--        (a) precondition broadened: status='resolved' AND
--            decision IN ('refund','split','release','reject') (was decision='refund').
--        (b) ledger amount source: COALESCE(disputes.default_refund_minor, LIVE
--            held/refunded tranche SUM). The T+80 default has the snapshot
--            (G3 single-source, deterministic across retries); operator/consensus
--            resolutions have NO snapshot, so the amount is the live SUM of the
--            still-held + already-refunded tranches via the SHARED held predicate.
--      It refunds still-HELD tranches (shared held predicate) ONLY for decision in
--      (refund,split); release/reject are a pure settlement_status flip (customer
--      owed nothing — never claw back a held craftsman tranche). Writes a
--      refund_partial ledger row ONLY when money was actually returned (none for
--      release/reject), flips settlement_status pending→settled, DOES NOT touch
--      payments/jobs/project
--      (G6 = Option B). Plan→Tranche FOR UPDATE lock order preserved (N2/G2).
--   2. CREATE OR REPLACE settle_dispute_default(uuid) as a THIN DELEGATE to
--      settle_dispute_resolution. The cron + its 1b retry keep calling
--      settle_dispute_default unchanged; both cron and webhook now funnel through
--      ONE body (no divergent second implementation). For the cron path
--      (decision='refund', default_refund_minor set, default_applied_at NOT NULL)
--      the delegated behavior is BYTE-IDENTICAL to Batch 3.
--
-- WHY a separate refund_partial entry_type does NOT double-count the webhook's
--   ''-movement-ref 'refund' rows: the unique index is
--   (payment_id, entry_type, movement_ref); 'refund'/'' and 'refund_partial'/
--   <dispute_id> never collide. The runtime double-count is closed in TS (G7) by
--   making the two webhook 'refund' writers skip when a refund_partial row already
--   exists for the payment — see api/stripe-webhook.ts in this batch.
--
-- SHARED HELD PREDICATE (G4 — byte-identical to 20260614050000, 20260614060000 and
--   api/_disputeDefaultCut.ts). A tranche is "held" (still owed to the customer)
--   when:
--     status NOT IN ('released','release_pending')
--     AND external_release_ref  IS NULL   -- no tr_* transfer recorded
--     AND external_payout_ref   IS NULL   -- no po_* payout recorded
--     AND transfer_reversal_ref IS NULL   -- not already reversed
--   NOTE: the held-tranche UPDATE uses this exact predicate (so 'refunded' rows
--   match and a re-settle is an idempotent no-op on them). The operator/consensus
--   LIVE-SUM amount ADDITIONALLY excludes status='refunded' so a SECOND dispute
--   settled on the same job does not RE-COUNT customer tranches a prior dispute
--   already refunded (would be a refund_partial ledger double-count). The
--   snapshot/cron path is unaffected (amount = default_refund_minor).
--
-- FEE-LEDGER = Option B: the platform-fee refund is recorded ONLY in the metadata
--   of the refund_partial row (metadata.fee.*); the corridor never books a separate
--   platform_fee row.
--
-- N2 (no double-pay): the settle refunds ONLY still-HELD tranches; the just-released
--   tranche from complete_tranche_payout is 'released' → EXCLUDED by the predicate →
--   never clawed back. Plan→Tranche FOR UPDATE lock + R3.2/Batch3 mitigations keep
--   the apply-snapshot→settle window safe. The settle NEVER releases/pays a tranche.
--
-- DORMANCY: gated behind FUNDING_DESTINATION_CHARGE_ENABLED at every caller (cron
--   returns corridor_disabled before constructing clients; the webhook's
--   completePayoutCorridorTranche only runs for a resolved corridor payout, which
--   cannot exist flag-OFF). Prod currently has 0 rows in disputes /
--   escrow_payment_plans / escrow_tranches / ledger_entries — 0-row-safe and
--   non-destructive. Both functions are service_role-only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. settle_dispute_resolution(p_dispute_id uuid) — generalized shared settler
-- ---------------------------------------------------------------------------
-- Called as service_role by:
--   · completePayoutCorridorTranche (payout.paid webhook) — operator/consensus
--     RELEASE / REJECT / SPLIT corridor resolutions, after the craftsman tranche
--     payout lands. auth.uid() IS NULL → disputes_status_change_guard branch (b)
--     admits the settlement flip; no sentinel needed.
--   · settle_dispute_default (delegation) — T+80 auto-default (decision='refund').
--
-- Idempotent: already-settled → returns the dispute row unchanged, no error.
-- Precondition: status='resolved' AND decision IN ('refund','split','release',
--   'reject'). Any other state RAISES (P0001) so an unresolved/odd dispute is never
--   silently "settled".
CREATE OR REPLACE FUNCTION public.settle_dispute_resolution(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status            text;
  v_decision          text;
  v_resolution_type   text;
  v_settlement_status text;
  v_default_applied   timestamptz;
  v_snapshot_minor    bigint;     -- disputes.default_refund_minor (NULL for operator/consensus)
  v_job_id            uuid;
  v_plan_id           uuid;
  v_total             numeric;
  v_currency          text;
  v_fee_total         numeric;
  v_fee_rate          numeric;
  v_payment_id        uuid;
  v_refund_minor      bigint;     -- amount actually returned to the customer (MINOR)
  v_total_minor       bigint;
  v_retained_minor    bigint;
  v_refund_ratio      numeric;
  v_retained_ratio    numeric;
  v_fee_refunded      numeric;
  v_source            text;
  v_result            jsonb;
BEGIN
  -- Lock the dispute row. Read decision/resolution_type and the (optional) held
  -- snapshot stamped by apply_dispute_default_refund.
  SELECT d.status, d.decision, d.resolution_type, d.settlement_status,
         d.default_applied_at, d.default_refund_minor, d.job_id
    INTO v_status, v_decision, v_resolution_type, v_settlement_status,
         v_default_applied, v_snapshot_minor, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: already settled → return current row unchanged.
  IF v_settlement_status = 'settled' THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- Precondition: resolved + a money-bearing decision. Broadened from the Batch 3
  -- default settle (which required decision='refund') to cover the operator/
  -- consensus corridor resolutions that leaked settlement_status='pending'.
  IF v_status IS DISTINCT FROM 'resolved'
     OR v_decision NOT IN ('refund', 'split', 'release', 'reject')
  THEN
    RAISE EXCEPTION 'settle_precondition_failed: dispute % has status=%, decision=%; '
                    'expected status=resolved and decision in (refund,split,release,reject)',
      p_dispute_id,
      COALESCE(v_status,   'null'),
      COALESCE(v_decision, 'null')
      USING ERRCODE = 'P0001';
  END IF;

  -- Resolve escrow plan + fee context for this job.
  SELECT epp.id, epp.total_amount, epp.currency,
         epp.platform_fee_amount, epp.platform_fee_rate
    INTO v_plan_id, v_total, v_currency, v_fee_total, v_fee_rate
    FROM public.escrow_payment_plans epp
   WHERE epp.job_id = v_job_id
   LIMIT 1;

  -- G2 / N2 PLAN LOCK — take the plan row lock BEFORE any tranche/plan read-for-
  -- write. Global lock order Plan → Tranche in all corridor settlers.
  IF v_plan_id IS NOT NULL THEN
    PERFORM 1 FROM public.escrow_payment_plans WHERE id = v_plan_id FOR UPDATE;
  END IF;

  -- Resolve payment for the ledger dedup key. NEVER insert a NULL payment_id row
  -- (the unique index treats NULL as distinct → ON CONFLICT would not dedup).
  SELECT p.id INTO v_payment_id
    FROM public.payments p
   WHERE p.job_id = v_job_id
   LIMIT 1;

  -- ── Determine the amount returned to the customer (MINOR units) ───────────
  -- A refund leg exists ONLY for the customer-favouring decisions (refund/split).
  -- release/reject award the customer NOTHING → v_refund_minor stays 0, so NO
  -- tranche is flipped to 'refunded' and NO ledger row is written. This is now
  -- decision-ENFORCED, not merely assumed from "everything is released": a partial
  -- release/reject bridge can leave a craftsman-owed tranche HELD when the payout
  -- lands, and refunding it to the customer would mis-route money to the wrong
  -- party and seal the dispute against the release retry.
  --   · T+80 default (decision='refund'): use the snapshot (G3 single-source,
  --     deterministic on retry).
  --   · operator/consensus SPLIT (no snapshot): LIVE SUM of still-held + already-
  --     refunded customer tranches via the SHARED held predicate.
  IF v_decision NOT IN ('refund', 'split') THEN
    v_refund_minor := 0;
  ELSIF v_snapshot_minor IS NOT NULL THEN
    v_refund_minor := v_snapshot_minor;
  ELSIF v_plan_id IS NOT NULL THEN
    -- Live amount counts ONLY genuinely-still-held tranches. 'refunded' is
    -- ADDITIONALLY excluded here (vs the shared held predicate) so a SECOND
    -- dispute settled on the same job does NOT re-count customer tranches a prior
    -- dispute already refunded → no ledger double-count (refund_partial keyed by a
    -- different dispute_id would not ON CONFLICT-dedup). The snapshot/cron path is
    -- unaffected (amount = default_refund_minor).
    SELECT COALESCE(round(SUM(t.amount) * 100), 0)::bigint
      INTO v_refund_minor
      FROM public.escrow_tranches t
     WHERE t.plan_id = v_plan_id
       AND t.status NOT IN ('released', 'release_pending', 'refunded')
       AND t.external_release_ref  IS NULL
       AND t.external_payout_ref   IS NULL
       AND t.transfer_reversal_ref IS NULL;
  ELSE
    v_refund_minor := 0;
  END IF;
  v_refund_minor := COALESCE(v_refund_minor, 0);

  -- Audit shares (F3): from the actual cut, not the nominal split_ratio.
  v_total_minor    := round(COALESCE(v_total, 0) * 100)::bigint;
  v_retained_minor := GREATEST(v_total_minor - v_refund_minor, 0);
  IF v_total_minor > 0 THEN
    v_refund_ratio   := round(v_refund_minor::numeric   / v_total_minor, 4);
    v_retained_ratio := round(v_retained_minor::numeric / v_total_minor, 4);
  ELSE
    v_refund_ratio   := 0;
    v_retained_ratio := 0;
  END IF;
  v_fee_refunded := round(COALESCE(v_fee_total, 0) * v_refund_ratio, 2);
  v_source := CASE WHEN v_default_applied IS NOT NULL
                   THEN 't80_default' ELSE 'corridor_resolution' END;

  -- Flip settlement on the dispute (pending → settled). service_role context
  -- (auth.uid() IS NULL) → disputes_status_change_guard branch (b) admits it.
  -- No other lifecycle field changes.
  UPDATE public.disputes
     SET settlement_status = 'settled',
         updated_at        = now()
   WHERE id = p_dispute_id;

  -- PARTIAL TRANCHE REFUND — mark ONLY the still-HELD tranches 'refunded' via the
  -- SHARED held predicate. The already-released/paid-out craftsman tranches
  -- (incl. the one just released by complete_tranche_payout) are EXCLUDED and
  -- stay as-is (N2 — never clawed back). The plan status is NOT forced to
  -- 'refunded' (G6 = Option B). DECISION-GATED to refund/split: release/reject
  -- refund the customer NOTHING, so a held craftsman-owed tranche (possible on a
  -- partial release/reject bridge) is NEVER flipped to the customer's 'refunded'.
  IF v_plan_id IS NOT NULL AND v_decision IN ('refund', 'split') THEN
    UPDATE public.escrow_tranches
       SET status     = 'refunded',
           updated_at = now()
     WHERE plan_id = v_plan_id
       AND status NOT IN ('released', 'release_pending')
       AND external_release_ref  IS NULL
       AND external_payout_ref   IS NULL
       AND transfer_reversal_ref IS NULL;
  END IF;

  -- LEDGER — record the PARTIAL refund movement ONLY when money was actually
  -- returned to the customer (held > 0). entry_type 'refund_partial',
  -- movement_ref = dispute uuid (stable, unique per dispute), ON CONFLICT DO
  -- NOTHING (re-delivery / retry safe). Fee refund recorded in metadata only
  -- (Fee-ledger Option B — no separate platform_fee row). Release/reject write
  -- NO refund row (v_refund_minor = 0).
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
      p_dispute_id::text,
      jsonb_build_object(
        'source',                  v_source,
        'decision',                v_decision,
        'resolution_type',         COALESCE(v_resolution_type, 'refund_partial'),
        'held_minor',              v_refund_minor,
        'released_retained_minor', v_retained_minor,
        'total_minor',             v_total_minor,
        'split_ratio',             v_retained_ratio,   -- provider-retained share
        'refund_ratio',            v_refund_ratio,     -- customer-refunded share
        'fee', jsonb_build_object(
                 'platform_fee_amount',   COALESCE(v_fee_total, 0),
                 'platform_fee_rate',     v_fee_rate,
                 'platform_fee_refunded', v_fee_refunded
               )
      )
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  -- payments / jobs / project: INTENTIONALLY NOT TOUCHED (G6 = Option B). The
  -- payment FSM for a corridor RELEASE/REJECT is owned by the existing
  -- completePayoutCorridorTranche fully_released block; for REFUND/SPLIT the
  -- payment stays as-is and the projection renders from the dispute fields.

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_dispute_resolution(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_dispute_resolution(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_dispute_resolution(uuid) IS
  'P4 Batch 4 · ONE shared corridor split-settler. Settles a resolved dispute '
  '(decision in refund/split/release/reject) by flipping settlement_status '
  'pending→settled, refunding ONLY still-HELD tranches (shared held predicate; '
  'no-op for release/reject), and writing a refund_partial ledger row over the '
  'COALESCE(default_refund_minor snapshot, live held SUM) when money was returned '
  '(fee refund in metadata only — Option B). Does NOT touch payments/jobs/project '
  '(G6=B). Plan→Tranche FOR UPDATE lock (N2/G2). SECURITY DEFINER, service_role '
  'ONLY. Called by completePayoutCorridorTranche (payout.paid) for operator/'
  'consensus resolutions AND by settle_dispute_default (delegation) for the T+80 '
  'auto-default. Idempotent: already-settled rows return unchanged. Dormant behind '
  'FUNDING_DESTINATION_CHARGE_ENABLED at every caller.';

-- ---------------------------------------------------------------------------
-- 2. settle_dispute_default(uuid) — now a THIN DELEGATE (single settle body)
-- ---------------------------------------------------------------------------
-- Keeps the T+80 cron (api/_disputeDefaultCut.ts) and its 1b retry calling
-- settle_dispute_default unchanged while funnelling through the ONE generalized
-- body above (no divergent second implementation). For the cron path the dispute
-- always carries decision='refund' + default_refund_minor (snapshot) +
-- default_applied_at, so the delegated behavior is BYTE-IDENTICAL to Batch 3:
-- snapshot-driven amount, source='t80_default', held-only tranche refund,
-- refund_partial ledger row, settlement flip, payments/jobs/project untouched.
CREATE OR REPLACE FUNCTION public.settle_dispute_default(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN public.settle_dispute_resolution(p_dispute_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_dispute_default(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_dispute_default(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_dispute_default(uuid) IS
  'P4 Batch 4 · thin delegate to settle_dispute_resolution(uuid). Preserved name '
  'for the T+80 cron worker (api/_disputeDefaultCut.ts) + its 1b retry. The actual '
  'settle logic (75/25 partial settle, held-only refund, refund_partial ledger, '
  'settlement flip, G6=B) lives in the single shared body. SECURITY DEFINER, '
  'service_role ONLY. Idempotent. Dormant behind FUNDING_DESTINATION_CHARGE_ENABLED '
  'at the cron caller level.';

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
-- -- Step 1: Restore the standalone Batch 3 settle body by re-applying
-- --         20260614060000_p_default_cut_partial_settle.sql's
-- --         settle_dispute_default(uuid) definition verbatim.
-- -- Step 2: Drop the generalized settler (no other caller once step 1 is done):
-- DROP FUNCTION IF EXISTS public.settle_dispute_resolution(uuid);
-- -- Step 3: Schema cache reload:
-- NOTIFY pgrst, 'reload schema';
--
-- No column/schema/index changes were made by this migration.
-- =============================================================================
