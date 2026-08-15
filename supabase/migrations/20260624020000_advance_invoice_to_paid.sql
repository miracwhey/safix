-- R3 — Invoice→'paid' on full payment release (server-owned, single chokepoint)
--
-- Problem: invoice→'paid' was client-only (syncInvoiceWithPayment) and doubly
-- dead in prod: invoices_update_own RLS is provider-only AND the engine sets
-- due_at_label='Bezahlt' on →paid, which enforce_invoice_immutability rejects
-- (23514). No server path touched the invoice, so a fully-paid invoice hung on
-- 'sent' forever. This makes 'paid' a server-owned transition driven off the
-- canonical payments.status='released' transition.
--
-- Mechanism B (chosen): a single AFTER-UPDATE trigger on `payments` is the
-- grep-auditable chokepoint covering EVERY writer that drives payments→released
-- (corridor payout.paid webhook, legacy capture, dispute release/reject settle,
-- recon cron, and the SECDEF client finalize_payment_state_atomic) without
-- re-deploying any of those money paths. The invoice flips atomically with the
-- payment, eliminating the hang window entirely.
--
-- Prod schema verified before authoring (project itdntawwuzqfwmcwnwjr):
--   * invoices.status/kind/due_at_label = text, invoices.updated_at = bigint
--   * payments.status = text (CHECK includes 'released'), payments.job_id = uuid
--   * enforce_invoice_immutability: draft EXEMPT; status whitelist allows
--     issued→paid and sent→paid (kind-agnostic); updated_at NOT immutable
--   * epoch_ms() exists → bigint (clock_timestamp()*1000)
--   * payments has NO AFTER trigger today (no conflict); BEFORE = enforce_payment_fsm
--     + set_payments_updated_at
--
-- Behavioral repro (aborted-tx on the real schema, all rolled back, 10/10 green):
--   S1 sent→paid · S2 idempotent · S3 cancelled stays · S4 draft stays ·
--   S5 kind='cancellation' NOT flipped · S6 self-gate (payment not released → no
--   flip) · S7 trigger flips on →released · S8 no flip on non-released update ·
--   D1 real settle_dispute_resolution(release) → payment released + invoice paid ·
--   D2 real settle_dispute_resolution(split) → payment stays disputed + invoice
--   stays sent. Payment-guard: APPROVED.
--
-- Audit trail: the invoice→paid flip is an audited-by-projection event — the
-- causal payments→'released' transition is fully audited by each writer
-- (ledger_entries + timeline_signals), and the invoice flip is a deterministic
-- projection of it (stamped via invoices.updated_at). No payment transition is
-- left un-audited. A dedicated invoice-status audit row is intentionally NOT
-- written here (it would add an in-trigger write to the money-movement TX).
--
-- One-invoice-per-job assumption: the UPDATE flips every kind='invoice' row in
-- issued|sent for the job. Today that is exactly one original invoice per job;
-- if multi-original-per-job is ever introduced, revisit this scope.

-- ── 1. The advance RPC ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.advance_invoice_to_paid(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Self-gate: only act when the job's canonical payment is actually 'released'
  -- ('released' is FSM-terminal, so this can never be transiently/falsely true).
  -- Defends against any caller that might invoke this off a 0-row no-op payment
  -- update. Do NOT trust the caller's context alone.
  IF NOT EXISTS (
    SELECT 1 FROM public.payments
    WHERE job_id = p_job_id AND status = 'released'
  ) THEN
    RETURN;
  END IF;

  -- SILENT 0-row filter — NEVER guard-then-RAISE. A RAISE here would roll back
  -- the enclosing payment-release transaction (money stuck). Terminal-safe +
  -- idempotent + §14-safe purely by the WHERE predicate:
  --   already 'paid'        -> 0 rows (idempotent no-op)
  --   'cancelled' / 'draft' -> 0 rows (never un-cancel; never auto-issue — note
  --                            enforce_invoice_immutability EXEMPTS draft, so the
  --                            status filter is the ONLY guard against drafts)
  --   kind <> 'invoice'     -> 0 rows (never flip a Storno/Gutschrift correction
  --                            doc to paid — the immutability whitelist allows
  --                            issued→paid kind-agnostically, so this filter is
  --                            the ONLY guard for correction docs sharing job_id)
  -- issued|sent -> paid mirrors enforce_invoice_immutability's whitelist, so the
  -- write always passes that BEFORE trigger. Sets ONLY status + updated_at; never
  -- due_at_label (immutable -> 23514). updated_at uses the single DB clock so the
  -- realtime echo orders correctly across the two-writer cache seam.
  UPDATE public.invoices
     SET status     = 'paid',
         updated_at = public.epoch_ms()
   WHERE job_id = p_job_id
     AND kind   = 'invoice'
     AND status IN ('issued', 'sent');
END;
$$;

-- Service-role only. The trigger below runs as owner (SECDEF) so it can PERFORM
-- this regardless of the GRANT; the REVOKE blocks any direct client call.
REVOKE EXECUTE ON FUNCTION public.advance_invoice_to_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.advance_invoice_to_paid(uuid) TO service_role;

-- ── 2. The chokepoint trigger on payments ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_advance_invoice_on_payment_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.advance_invoice_to_paid(NEW.job_id);
  RETURN NULL; -- AFTER trigger: return value ignored
END;
$$;

DROP TRIGGER IF EXISTS tg_advance_invoice_on_payment_released ON public.payments;
CREATE TRIGGER tg_advance_invoice_on_payment_released
  AFTER UPDATE ON public.payments
  FOR EACH ROW
  -- Fire ONLY on the transition INTO released — idempotent against webhook
  -- re-delivery / 0-row no-ops, never on deposit (payments stays non-released),
  -- never on refund ('refunded' != 'released'). job_id can be NULL on a
  -- project-only payment; advance_invoice_to_paid(NULL) self-gates to 0 rows.
  WHEN (OLD.status IS DISTINCT FROM 'released' AND NEW.status = 'released')
  EXECUTE FUNCTION public.tg_advance_invoice_on_payment_released();

-- Reload PostgREST schema cache so the new function is exposed immediately.
NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS tg_advance_invoice_on_payment_released ON public.payments;
-- DROP FUNCTION IF EXISTS public.tg_advance_invoice_on_payment_released();
-- DROP FUNCTION IF EXISTS public.advance_invoice_to_paid(uuid);
-- NOTIFY pgrst, 'reload schema';
