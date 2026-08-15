-- Pro gate: team_members INSERT
--
-- RESTRICTIVE policy: only Pro owners may add team members.
-- The authenticated caller IS the provider owner (verified via providers.profile_id
-- in the existing permissive policy); is_pro_owner checks their subscription.

CREATE POLICY "team_members_pro_gate_insert"
  ON public.team_members
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_pro_owner(auth.uid()));
