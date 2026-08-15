-- =============================================================================
-- Migration: Block P · #6 — settle_dispute_resolution release/reject FSM sync
-- Sequenced AFTER 20260614070000_p4_batch4_split_settle_relocation.sql (which
-- CREATEs settle_dispute_resolution). This is CREATE OR REPLACE on top of it.
-- DO NOT APPLY standalone — apply 070000 first, then this (both dormant). Passive
-- migration; prod-apply is a separate, explicitly-confirmed step.
--
-- WHY (the disputed→released ownership gap — corridor-gated, dormant today)
--   Under the destination-charge corridor (FUNDING_DESTINATION_CHARGE_ENABLED ON)
--   an operator/consensus dispute resolved with decision RELEASE or REJECT settles
--   via the async payout bridge → the payout.paid webhook calls
--   settle_dispute_resolution. That settler (070000) flips the DISPUTE to settled
--   but DELIBERATELY does NOT touch payments/jobs/project (G6 = Option B), and the
--   webhook's own fully_released block REFUSES to move a payment out of 'disputed'
--   (isValidWebhookTransition excludes 'disputed'; "dispute path owns this"). So
--   for a corridor-settled RELEASE/REJECT NEITHER side syncs the payment FSM: the
--   dispute is settled + the craftsman tranche is released, yet payments.status
--   stays 'disputed' (and jobs/projects.payment_state diverge). Cross-surface
--   consistency invariant violated; any surface reading payment.state directly
--   shows a stuck dispute after a completed release.
--   (Live flag-OFF operator release/reject is unaffected: it settles synchronously
--   client-side via releaseEscrowPayment→finalize_payment_state_atomic.)
--
-- WHAT this migration does (additive, idempotent, 0-row-safe — CREATE OR REPLACE
--   only; no schema/column/index changes):
--   CREATE OR REPLACE settle_dispute_resolution(uuid) — body BYTE-IDENTICAL to
--   20260614070000 EXCEPT:
--     (a) a new v_project_id local, and
--     (b) for decision IN ('release','reject') an ADDITIVE payment-FSM sync that
--         converges payments / jobs / project to 'released' in the SAME tx as the
--         settlement flip — mirroring the proven 20260614040000 default-settle sync
--         (which targets 'refunded') but targeting 'released'.
--   REFUND / SPLIT stay Option B (payment left as-is; projection renders the
--   refund_partial 'Teilrückerstattung'). The held-tranche refund + refund_partial
--   ledger + the COALESCE(snapshot, live held SUM) amount logic are unchanged.
--   settle_dispute_default(uuid) (the thin delegate from 070000) is left UNTOUCHED:
--   it forwards here, and the T+80 cron only ever passes decision='refund', so the
--   new release/reject branch never fires from the cron (its refund settle is
--   byte-identical to before).
--
-- TERMINAL STATE: payments 'disputed'→'released' (stateMachine.ts:12 allows it);
--   jobs.payment_state→'released' + status waiting_payment→completed; projects
--   .payment_state→'released'. release = craftsman paid; reject = claim dismissed,
--   original payment stands → both land on 'released'. The payments UPDATE is
--   guarded `AND status='disputed'` so it is idempotent and never clobbers a
--   concurrent chargeback/dispute that moved the payment elsewhere.
--
-- DORMANCY: the release/reject branch is reachable ONLY via the payout.paid webhook
--   (corridor-only: a resolved corridor payout cannot exist flag-OFF) — same
--   dormancy guarantee as 070000. service_role-only. Prod currently has 0 disputes.
-- =============================================================================

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
  v_project_id        text;       -- #6: jobs.project_id (text) for the release/reject project sync
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

  -- ── #6: PAYMENT-FSM SYNC for RELEASE / REJECT (additive) ──────────────────
  -- For a corridor-settled RELEASE/REJECT the dispute is settled + the craftsman
  -- tranche released, but NEITHER the webhook (refuses disputed→released) NOR the
  -- Option-B settler above moves the payment FSM. Converge payments / jobs /
  -- project to 'released' in THIS transaction so no surface shows a stuck dispute
  -- after a completed release. Mirrors 20260614040000's default-settle sync, with
  -- target 'released' instead of 'refunded'. REFUND/SPLIT are NOT synced here
  -- (Option B): the payment stays as-is and the projection renders refund_partial.
  IF v_decision IN ('release', 'reject') THEN
    -- Payment: disputed→released. Guarded `AND status='disputed'` → idempotent and
    -- never clobbers a concurrent chargeback/dispute. No payments FSM trigger
    -- blocks this; stateMachine.ts:12 admits disputed→released.
    IF v_payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET status = 'released'
       WHERE id = v_payment_id
         AND status = 'disputed';
    END IF;

    -- Job: payment_state→'released'; status advances to 'completed' ONLY from
    -- 'waiting_payment' (mirrors reconcileJobFromPayment / the client release
    -- guard). jobs_terminal_status_guard admits this under the service-role
    -- context (auth.uid() IS NULL). RETURNING captures project_id (text).
    UPDATE public.jobs
       SET payment_state = 'released',
           status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
           updated_at    = now()
     WHERE id = v_job_id
     RETURNING project_id INTO v_project_id;

    -- Project: downstream payment_state sync. jobs.project_id is text; projects.id
    -- is uuid → cast. Skip when absent/blank.
    IF v_project_id IS NOT NULL AND v_project_id <> '' THEN
      UPDATE public.projects
         SET payment_state = 'released',
             updated_at     = now()
       WHERE id = v_project_id::uuid;
    END IF;
  END IF;
  -- REFUND / SPLIT: payments/jobs/project INTENTIONALLY NOT TOUCHED (G6 = Option
  -- B) — the payment stays as-is and the projection renders the refund_partial
  -- 'Teilrückerstattung' from the dispute fields.

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_dispute_resolution(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_dispute_resolution(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_dispute_resolution(uuid) IS
  'P4 Batch 4 + #6 · ONE shared corridor split-settler. Settles a resolved dispute '
  '(decision in refund/split/release/reject): flips settlement_status pending→settled, '
  'refunds ONLY still-HELD tranches for refund/split (shared held predicate; no-op for '
  'release/reject), writes a refund_partial ledger row over COALESCE(default_refund_minor '
  'snapshot, live held SUM) when money was returned (fee in metadata — Option B). For '
  'release/reject it ALSO converges payments/jobs/project→released (#6 FSM sync, mirrors '
  '20260614040000); refund/split stay Option B (payment untouched, projection renders '
  'refund_partial). Plan→Tranche FOR UPDATE lock (N2/G2). SECURITY DEFINER, service_role '
  'ONLY. Called by completePayoutCorridorTranche (payout.paid) and settle_dispute_default '
  '(delegation, T+80 refund). Idempotent. Dormant behind FUNDING_DESTINATION_CHARGE_ENABLED.';

-- ---------------------------------------------------------------------------
-- Schema cache reload (feedback_postgrest_schema_cache_reload).
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK (run manually — NOT via apply_migration)
--   Re-apply 20260614070000_p4_batch4_split_settle_relocation.sql's
--   settle_dispute_resolution(uuid) body verbatim (restores G6=B for all decisions,
--   dropping the release/reject FSM sync). Then: NOTIFY pgrst, 'reload schema';
--   No column/schema/index changes were made by this migration.
-- =============================================================================
