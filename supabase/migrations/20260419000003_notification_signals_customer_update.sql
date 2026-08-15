-- Fix notification_signals UPDATE policy provider-side JOIN.
--
-- The previous provider-only UPDATE policy (from block8a/secondary_tables)
-- referenced craftsman_user_id. The live schema uses a providers JOIN via
-- provider_id. Bring the incremental migration chain in sync with the live
-- schema's provider-based UPDATE predicate.
--
-- Customer UPDATE access is addressed separately in 20260419000005, which
-- adds a recipient_role column so customer and craftsman read-state cannot
-- interfere with each other.

DROP POLICY IF EXISTS notification_signals_update_own ON public.notification_signals;

CREATE POLICY notification_signals_update_own ON public.notification_signals
  FOR UPDATE USING (
    EXISTS (
      SELECT 1
      FROM jobs j
      LEFT JOIN providers p ON (p.id = j.provider_id)
      WHERE j.id = notification_signals.job_id
        AND p.profile_id = auth.uid()
    )
  );
