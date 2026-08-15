-- Pro gate: funding_requests INSERT
--
-- RESTRICTIVE policy: only Pro owners may create funding requests.
-- request_funding is NOT in the AWE allow-list (expired owners cannot initiate
-- new funding), so no escrow-exception branch.

CREATE POLICY "funding_requests_pro_gate_insert"
  ON public.funding_requests
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pro_owner(auth.uid()));
