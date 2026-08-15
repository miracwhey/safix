-- B5 — Recon-heal: converge a fully-released corridor plan whose canonical
-- payment never settled to 'released'.
--
-- Context: in the destination-charge corridor the release-tranche path moves the
-- TRANCHE (eligible→release_pending→released via payout.paid) but never the
-- canonical `payments` row. The authoritative payment settle happens in the
-- stripe-webhook A1 block on the FINAL payout.paid (gated plan.status=
-- 'fully_released' → payment in_escrow/…→released + job/project sync). That block
-- is correct for delivered webhooks, but Stripe does not retry a webhook forever:
-- a missed/undelivered final payout.paid leaves the plan 'fully_released' with the
-- payment stuck in a pre-settle state and the §14 invoice hung on 'sent'. There is
-- no heal path today (the payout-corridor cron only re-pokes eligible_for_release
-- tranches). This RPC is that heal, called each tick by reconcilePayoutCorridor.
--
-- It is the defense-in-depth complement to the webhook A1 block — NOT the primary
-- path. (The write-skew the old webhook comment feared is already closed:
-- complete_tranche_payout takes `SELECT 1 FROM escrow_payment_plans … FOR UPDATE`
-- before the rollup, so fully_released is computed correctly.)
--
-- Prod schema verified before authoring (project itdntawwuzqfwmcwnwjr):
--   * enforce_payment_fsm step (1): auth.uid() IS NULL ⇒ RETURN NEW — a service_role
--     / SECDEF write bypasses the FSM, so payment in_escrow→released is permitted
--     here exactly as in the webhook A1 block.
--   * PROVIDER_RECOVERY_TO_RELEASED = {deposit_paid,in_escrow,work_in_progress,
--     release_pending} — the releasable pre-settle set mirrored below; 'disputed',
--     'released', 'refunded' are deliberately excluded (dispute path / already-
--     terminal own those).
--   * jobs.payment_released_at = bigint (epoch ms) → epoch_ms(); jobs.project_id =
--     text (uuid stored as text) → ::uuid; jobs/projects.updated_at = timestamptz.
--   * payments.amount_released / total_amount = numeric.
-- Mirrors reconcileJobFromPayment (full-release branch) for the job/project sync.

CREATE OR REPLACE FUNCTION public.reconcile_fully_released_corridor_payments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       RECORD;
  v_healed integer := 0;
BEGIN
  FOR r IN
    SELECT p.id AS payment_id, p.job_id, p.status AS pay_status, p.total_amount,
           j.project_id
      FROM public.payments p
      JOIN public.escrow_payment_plans epp
        ON epp.job_id = p.job_id AND epp.status = 'fully_released'
      JOIN public.jobs j ON j.id = p.job_id
     -- Releasable pre-settle states only. 'disputed' (dispute path owns it),
     -- 'released' (already settled — idempotent skip) and 'refunded' are excluded.
     WHERE p.status IN ('deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending')
     FOR UPDATE OF p SKIP LOCKED
  LOOP
    -- payment → released. enforce_payment_fsm is bypassed (NULL uid, step 1);
    -- the optimistic guard is belt-and-braces (row is already FOR UPDATE-locked).
    -- The R3 trigger tg_advance_invoice_on_payment_released fires here → invoice
    -- (issued|sent, kind='invoice') flips to 'paid'.
    UPDATE public.payments
       SET status          = 'released',
           amount_released = COALESCE(r.total_amount, 0)
     WHERE id = r.payment_id
       AND status = r.pay_status;

    -- job sync — mirror reconcileJobFromPayment full-release branch. The CASE
    -- right-hand sides read the OLD (pre-update) status, so status + the
    -- payment_released_at stamp advance together only from 'waiting_payment'.
    UPDATE public.jobs
       SET payment_state       = 'released',
           status              = CASE WHEN status = 'waiting_payment' THEN 'completed' ELSE status END,
           payment_released_at = CASE WHEN status = 'waiting_payment' THEN public.epoch_ms() ELSE payment_released_at END,
           updated_at          = now()
     WHERE id = r.job_id;

    -- project downstream sync (jobs.project_id is text → cast).
    IF r.project_id IS NOT NULL AND r.project_id <> '' THEN
      UPDATE public.projects
         SET payment_state = 'released',
             updated_at    = now()
       WHERE id = r.project_id::uuid;
    END IF;

    v_healed := v_healed + 1;
  END LOOP;

  RETURN v_healed;
END;
$$;

-- Service-role only (the payout-corridor cron). Not a client-callable surface.
REVOKE EXECUTE ON FUNCTION public.reconcile_fully_released_corridor_payments() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_fully_released_corridor_payments() TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.reconcile_fully_released_corridor_payments();
-- NOTIFY pgrst, 'reload schema';
