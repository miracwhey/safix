-- =============================================================================
-- Migration: Block P Run 2 — T+80 dispute-default-cut
-- Written against LIVE prod schema (project itdntawwuzqfwmcwnwjr, 2026-06-14).
-- DO NOT APPLY without explicit user confirm.
--
-- What this migration does:
--   1. ADD COLUMN disputes.default_applied_at timestamptz — nullable, no default,
--      no backfill. Idempotency anchor: once set, the worker skips the row.
--      Also serves as rule/judgment audit split (T+80 auto vs operator decision).
--   2. apply_dispute_default_refund(uuid) — SECDEF, service_role only.
--      Called by the daily cron for disputes where: status is open/under_review/
--      customer_waiting/provider_waiting, decision IS NULL, default_applied_at IS
--      NULL, and funded_at ≤ now() - interval '80 days' (cron pre-filters; RPC
--      just enforces the state gate).
--      Applies AGB default = full refund (provisional + right-of-recourse):
--        - Marks dispute resolved/refund/refund_full/pending.
--        - Sets default_applied_at = now().
--        - Writes dispute_status_history with source='system'.
--        - Drives pending acceptance terminal (R3.2 class).
--        - Updates jobs.dispute_status = 'resolved'.
--      IDEMPOTENT: if gate conditions are not met (operator/consensus already
--      acted, or already called), returns current row unchanged — no error.
--   3. settle_dispute_default(uuid) — SECDEF, service_role only.
--      Called by the T+80 cron worker after the Stripe refund (reverse_transfer +
--      refund_fee) succeeds. Flips settlement_status pending→settled, marks escrow
--      plan 'refunded', marks eligible tranches 'refunded', writes ledger row,
--      AND advances payments.status + jobs/project payment_state to 'refunded'
--      (payment-FSM sync — see note below), all in one transaction.
--      IDEMPOTENT: already-settled → returns row unchanged.
--
-- TRIGGER NOTE (disputes_status_change_guard — P4A current state):
--   Both functions are SECURITY DEFINER called by service_role (no JWT).
--   auth.uid() IS NULL → the existing branch (b) admits the write unconditionally.
--   No new sentinel is needed; do NOT replicate settle_consensus_split's
--   `IF v_uid IS NULL THEN RAISE 'unauthenticated'` guard — for these RPCs,
--   v_uid IS NULL is the NORMAL case.
--
-- OPTION A: post-release clawback is in scope but DORMANT. The worker does NOT
--   pre-filter plans by tranche release state. A full refund with reverse_transfer
--   on the destination charge inherently claws back deposit + final transfers
--   (negative Connect balance → SEPA pull via debit_negative_balances, which is a
--   FLIP-time Connect setting, NOT built/enabled now). Everything is gated behind
--   env FUNDING_DESTINATION_CHARGE_ENABLED === 'true'. Flag NOT SET in prod =>
--   byte-identical dormant.
--
-- Prod currently has 0 rows in disputes/escrow_payment_plans/escrow_tranches/
--   ledger_entries/acceptances — this migration is 0-row-safe and non-destructive.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add default_applied_at to disputes
-- ---------------------------------------------------------------------------
-- Nullable, no default, no backfill.
-- Existing rows stay NULL (byte-identical to current state).
-- Serves dual purpose:
--   (a) idempotency anchor — worker WHERE default_applied_at IS NULL pre-filters;
--       RPC gate checks it again under FOR UPDATE lock (no TOCTOU).
--   (b) audit trail — timestamps the moment AGB T+80 default fired, distinct from
--       operator/consensus resolved_at, so post-hoc rule vs judgment is queryable.
ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS default_applied_at timestamptz;

COMMENT ON COLUMN public.disputes.default_applied_at IS
  'P4 Run 2: set by apply_dispute_default_refund when the AGB T+80 default fires. '
  'NULL = no auto-default applied. Non-NULL = timestamp of the system default. '
  'Idempotency anchor: once set, the worker and RPC skip the row. '
  'Distinct from resolved_at: resolved_at can be set by operator/consensus; '
  'default_applied_at = only ever set by the automated default path.';

-- ---------------------------------------------------------------------------
-- 2. apply_dispute_default_refund(p_dispute_id uuid)
-- ---------------------------------------------------------------------------
-- Called by the daily cron for disputes that have reached T+80 with no
-- consensus and no operator action. Applies the AGB default = FULL refund,
-- provisional + right-of-recourse.
--
-- Called by service_role only (cron / Edge Function orchestration).
-- auth.uid() IS NULL in this context → disputes_status_change_guard branch (b)
-- admits the UPDATE unconditionally — no sentinel needed.
--
-- Idempotency gate (FOR UPDATE lock → no race):
--   Proceeds ONLY when ALL conditions hold:
--     - status IN ('open','under_review','customer_waiting','provider_waiting')
--     - decision IS NULL        (operator/consensus has not already decided)
--     - default_applied_at IS NULL  (not already applied)
--   If any condition is false, returns the current dispute row unchanged (no RAISE).
--   This means operator/consensus decisions always win; concurrent cron calls are safe.
CREATE OR REPLACE FUNCTION public.apply_dispute_default_refund(
  p_dispute_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status             text;
  v_decision           text;
  v_settlement_status  text;
  v_default_applied_at timestamptz;
  v_job_id             uuid;
  v_result             jsonb;
BEGIN
  -- Lock the dispute row for the duration of this transaction.
  -- Prevents concurrent cron calls from double-applying the default.
  SELECT d.status, d.decision, d.settlement_status, d.default_applied_at, d.job_id
    INTO v_status, v_decision, v_settlement_status, v_default_applied_at, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  -- Row not found (job_id IS NULL is the sentinel — job_id is NOT NULL on disputes).
  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- RACE / IDEMPOTENCY GATE.
  -- Return the current row unchanged whenever:
  --   • status is already terminal (resolved/closed/cancelled)
  --   • a decision has already been recorded by operator or consensus
  --   • the default has already been applied (default_applied_at IS NOT NULL)
  -- This makes the call safe to retry and ensures operator/consensus always wins.
  IF NOT (
    v_status IN ('open', 'under_review', 'customer_waiting', 'provider_waiting')
    AND v_decision IS NULL
    AND v_default_applied_at IS NULL
  ) THEN
    SELECT row_to_json(d)::jsonb INTO v_result
      FROM public.disputes d
     WHERE d.id = p_dispute_id;
    RETURN v_result;
  END IF;

  -- Apply the AGB T+80 default: full refund, provisional.
  -- resolved_at = COALESCE preserves it if already set (unlikely given gate above,
  -- but defensive).
  UPDATE public.disputes
     SET status             = 'resolved',
         decision           = 'refund',
         resolution_type    = 'refund_full',
         settlement_status  = 'pending',
         default_applied_at = now(),
         resolved_at        = COALESCE(resolved_at, now()),
         updated_at         = now()
   WHERE id = p_dispute_id;

  -- Audit trail.
  -- source = 'system' (valid per dispute_status_history.source CHECK).
  INSERT INTO public.dispute_status_history
    (dispute_id, previous_status, next_status, source, note, metadata, job_id)
  VALUES (
    p_dispute_id,
    v_status,
    'resolved',
    'system',
    'AGB T+80 default refund',
    jsonb_build_object('auto_default', true, 'rule', 'AGB_T80_default'),
    v_job_id
  );

  -- R3.2 zombie-acceptance hygiene (verbatim pattern from operator_resolve_dispute_refund).
  -- Drives the related pending acceptance terminal so the auto-release sweep can never
  -- release a now-refunded final tranche to the provider.
  -- acceptances.updated_at is bigint epoch-ms (NOT timestamptz).
  UPDATE public.acceptances
     SET status     = 'disputed',
         updated_at = (extract(epoch FROM now()) * 1000)::bigint
   WHERE job_id = v_job_id
     AND status = 'pending';

  -- Sync jobs projection.
  UPDATE public.jobs
     SET dispute_status = 'resolved'
   WHERE id = v_job_id;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_dispute_default_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_dispute_default_refund(uuid) TO service_role;

COMMENT ON FUNCTION public.apply_dispute_default_refund(uuid) IS
  'P4 Run 2 · T+80 default cut: applies AGB default = full refund for a dispute '
  'that has reached T+80 with no consensus and no operator action. '
  'SECURITY DEFINER. service_role ONLY (cron + Edge Function orchestration). '
  'Idempotent: gate returns current row unchanged if operator/consensus already '
  'acted or the default was already applied. '
  'Gated behind FUNDING_DESTINATION_CHARGE_ENABLED=true at the cron caller level; '
  'dormant when flag is not set.';

-- ---------------------------------------------------------------------------
-- 3. settle_dispute_default(p_dispute_id uuid)
-- ---------------------------------------------------------------------------
-- Called by the T+80 cron worker after the Stripe refund (reverse_transfer +
-- refund_fee) succeeds. Flips settlement_status pending→settled, marks the escrow
-- plan 'refunded', marks eligible tranches 'refunded', writes a ledger 'refund'
-- row, and advances payments.status + jobs.status/payment_state +
-- project.payment_state to 'refunded' — all atomically.
--
-- PAYMENT-FSM SYNC (finding 1): open_dispute_atomic set payments.status to
-- 'disputed', and the provider-authoritative refund webhook REFUSES disputed→
-- refunded (PROVIDER_RECOVERY_TO_REFUNDED excludes 'disputed'), so a Stripe
-- refund webhook can never converge the payment. The cron also bypasses the
-- refundEscrowWorkflow → syncPaymentStateToJobAndProject layer. Without the sync
-- below the dispute/plan/tranches would read 'refunded' while payments stayed
-- 'disputed' and the job/project never completed — a cross-surface divergence
-- that breaks the Payment/Job/Project consistency invariant. So this RPC drives
-- the SAME sync as the operator refund path (refundEscrowPayment →
-- syncPaymentStateToJobAndProject / reconcileJobFromPayment), atomically with the
-- settlement above. payments/jobs updated_at are maintained by their
-- set_updated_at triggers; jobs_terminal_status_guard admits this write
-- (service-role auth.uid() IS NULL; waiting_payment is non-terminal).
--
-- Precondition: dispute must be status='resolved' AND decision='refund'.
-- apply_dispute_default_refund must have run first; normal call order is:
--   1. cron → apply_dispute_default_refund  (decision + settlement_status=pending)
--   2. cron → settle_dispute_default  (settlement_status=settled + ledger + FSM sync)
--
-- Idempotent: if settlement_status is already 'settled', returns the row unchanged.
-- Safe for cron retry (the in-progress retry selection re-drives a failed settle).
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
  v_payment_id        uuid;
  v_project_id        text;   -- jobs.project_id is text; projects.id is uuid
  v_result            jsonb;
BEGIN
  -- Lock the dispute row.
  SELECT d.status, d.decision, d.settlement_status, d.job_id
    INTO v_status, v_decision, v_settlement_status, v_job_id
    FROM public.disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'dispute_not_found: %', p_dispute_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: already settled → return current row unchanged.
  -- Safe for webhook retry (feedback_agentic_loop_retry_reexecutes_side_effects).
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
  SELECT epp.id, epp.total_amount, epp.currency
    INTO v_plan_id, v_total, v_currency
    FROM public.escrow_payment_plans epp
   WHERE epp.job_id = v_job_id
   LIMIT 1;

  -- Resolve payment for ledger deduplication key.
  -- NEVER insert a NULL payment_id ledger row: the unique index
  -- (payment_id, entry_type, movement_ref) treats NULL as distinct so
  -- ON CONFLICT DO NOTHING would not deduplicate. Guard with IS NOT NULL below.
  SELECT p.id INTO v_payment_id
    FROM public.payments p
   WHERE p.job_id = v_job_id
   LIMIT 1;

  -- Flip settlement on the dispute.
  UPDATE public.disputes
     SET settlement_status = 'settled',
         updated_at        = now()
   WHERE id = p_dispute_id;

  -- Mark escrow plan + eligible tranches refunded.
  IF v_plan_id IS NOT NULL THEN
    UPDATE public.escrow_payment_plans
       SET status     = 'refunded',
           updated_at = now()
     WHERE id = v_plan_id;

    -- Skip tranches that are already refunded or already have a transfer reversal
    -- (transfer_reversal_ref IS NOT NULL means Stripe already reversed it separately).
    UPDATE public.escrow_tranches
       SET status     = 'refunded',
           updated_at = now()
     WHERE plan_id = v_plan_id
       AND status NOT IN ('refunded')
       AND transfer_reversal_ref IS NULL;
  END IF;

  -- Ledger: record the full refund movement.
  -- Only when a payment row exists — never insert NULL payment_id.
  IF v_payment_id IS NOT NULL THEN
    INSERT INTO public.ledger_entries
      (payment_id, job_id, dispute_id, entry_type, amount, currency, movement_ref, metadata)
    VALUES (
      v_payment_id,
      v_job_id,
      p_dispute_id,
      'refund',
      COALESCE(v_total, 0),
      COALESCE(v_currency, 'EUR'),
      p_dispute_id::text,          -- movement_ref = dispute uuid (stable, unique per dispute)
      jsonb_build_object('source', 't80_default')
    )
    ON CONFLICT (payment_id, entry_type, movement_ref) DO NOTHING;
  END IF;

  -- Payment-FSM sync (finding 1): converge payments / jobs / project to
  -- 'refunded' in the SAME transaction as the settlement above, because the
  -- provider-authoritative refund webhook refuses disputed→refunded and the cron
  -- bypasses the refundEscrowWorkflow sync layer. Mirrors reconcileJobFromPayment.

  -- Payment: advance the resolved PaymentIntent's payment row to 'refunded'.
  -- No payments FSM trigger blocks disputed→refunded; updated_at is set by the
  -- set_payments_updated_at trigger. Skip when no payment row exists.
  IF v_payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET status = 'refunded'
     WHERE id = v_payment_id;
  END IF;

  -- Job: payment_state always converges to 'refunded'; advance status to
  -- 'completed' ONLY from 'waiting_payment' (mirrors reconcileJobFromPayment and
  -- the client refundEscrowWorkflow guard). updated_at is set by set_jobs_updated_at;
  -- jobs_terminal_status_guard admits this write under the service-role context.
  -- RETURNING captures project_id (text) for the downstream project sync.
  UPDATE public.jobs
     SET payment_state = 'refunded',
         status        = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END
   WHERE id = v_job_id
   RETURNING project_id INTO v_project_id;

  -- Project: downstream payment_state sync (mirrors syncPaymentStateToJobAndProject).
  -- jobs.project_id is text; projects.id is uuid → cast. Skip when absent/blank.
  IF v_project_id IS NOT NULL AND v_project_id <> '' THEN
    UPDATE public.projects
       SET payment_state = 'refunded'
     WHERE id = v_project_id::uuid;
  END IF;

  SELECT row_to_json(d)::jsonb INTO v_result
    FROM public.disputes d
   WHERE d.id = p_dispute_id;
  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_dispute_default(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_dispute_default(uuid) TO service_role;

COMMENT ON FUNCTION public.settle_dispute_default(uuid) IS
  'P4 Run 2 · T+80 default cut: settles a default-refund dispute after Stripe '
  'confirms reverse_transfer + refund_application_fee. Flips settlement_status '
  'pending→settled, marks escrow plan + eligible tranches refunded, writes ledger, '
  'and advances payments.status + jobs.status/payment_state + project.payment_state '
  'to refunded (payment-FSM sync, atomic with the settlement). '
  'SECURITY DEFINER. service_role ONLY (T+80 cron worker). '
  'Idempotent: already-settled rows are returned unchanged without error. '
  'Gated behind FUNDING_DESTINATION_CHARGE_ENABLED=true at the caller level; '
  'dormant when flag is not set.';

-- ---------------------------------------------------------------------------
-- 4. Schema cache reload
-- ---------------------------------------------------------------------------
-- Required after every MCP-apply migration (feedback_postgrest_schema_cache_reload).
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK
-- (run manually to undo — NOT via apply_migration)
-- =============================================================================
--
-- -- Step 1: Drop both RPCs:
-- DROP FUNCTION IF EXISTS public.apply_dispute_default_refund(uuid);
-- DROP FUNCTION IF EXISTS public.settle_dispute_default(uuid);
--
-- -- Step 2: Drop the new column (only safe because prod has 0 dispute rows):
-- ALTER TABLE public.disputes DROP COLUMN IF EXISTS default_applied_at;
--
-- -- Step 3: Schema cache reload:
-- NOTIFY pgrst, 'reload schema';
--
-- NOTE: The disputes_status_change_guard trigger is NOT modified by this migration
-- and therefore does NOT need to be restored on rollback.
-- =============================================================================
