-- Pro gate: invoices INSERT
--
-- RESTRICTIVE policy: Pro owner OR active-work-exception.
-- AWE branch: job has a funded escrow plan (issue_invoice is in AWE allow-list).

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
