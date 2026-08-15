-- Pro gate: change_orders INSERT
--
-- RESTRICTIVE policy: Pro owner OR active-work-exception.
-- AWE branch: job has a funded escrow plan (expired owner completing active work).

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
