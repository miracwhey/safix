-- Pro gate: offers INSERT
--
-- Adds a RESTRICTIVE policy so only Pro owners can create offers.
-- RESTRICTIVE = AND'd with existing permissive policies; does not replace them.
-- open_quote_composer is not in the AWE allow-list, so no job-context branch.

CREATE POLICY "offers_pro_gate_insert"
  ON public.offers
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pro_owner(auth.uid()));
