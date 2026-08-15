-- Fix AWE escrow status values in RESTRICTIVE Pro RLS policies.
--
-- The original policies referenced escrow_payment_plans.status values that do
-- not exist in the DB schema CHECK constraint:
--   BAD:  'deposit_held', 'funded', 'work_in_progress', 'release_pending'
--   GOOD: 'funded_in_escrow', 'partially_released'
--
-- The wrong values caused hasActiveEscrowForJob() to ALWAYS return false,
-- permanently blocking expired owners from AWE actions even on funded jobs.
--
-- Apply this migration on any environment where the original policies were
-- already applied. Idempotent: DROP IF EXISTS before CREATE.

-- change_orders
DROP POLICY IF EXISTS "change_orders_pro_gate_insert" ON public.change_orders;

CREATE POLICY "change_orders_pro_gate_insert"
  ON public.change_orders
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_pro_owner(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.escrow_payment_plans epp
      WHERE epp.job_id = change_orders.job_id
        AND epp.status IN ('funded_in_escrow', 'partially_released')
    )
  );

-- invoices
DROP POLICY IF EXISTS "invoices_pro_gate_insert" ON public.invoices;

CREATE POLICY "invoices_pro_gate_insert"
  ON public.invoices
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_pro_owner(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.escrow_payment_plans epp
      WHERE epp.job_id = invoices.job_id
        AND epp.status IN ('funded_in_escrow', 'partially_released')
    )
  );
