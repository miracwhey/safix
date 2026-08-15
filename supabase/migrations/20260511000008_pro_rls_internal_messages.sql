-- Pro gate: internal_messages INSERT
--
-- RESTRICTIVE policy: only Pro owners may post internal messages.
-- message_threads has no job_id column so a per-thread escrow check is not
-- feasible at the DB layer; AWE for messaging is enforced at the API/workflow
-- layer via isMessageAllowedInThread.

CREATE POLICY "internal_messages_pro_gate_insert"
  ON public.internal_messages
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pro_owner(auth.uid()));
