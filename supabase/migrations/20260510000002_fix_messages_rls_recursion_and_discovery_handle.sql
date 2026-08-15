-- Fix 1: mthread_worker_select — infinite recursion
--
-- Old policy joined message_thread_participants, which has mtp_select that
-- references message_threads → cycle. New policy only checks team_members.
-- Workers of a provider can see all provider threads (slightly broader than
-- participant-only, acceptable for the chat surface).

DROP POLICY IF EXISTS mthread_worker_select ON message_threads;

CREATE POLICY mthread_worker_select ON message_threads
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.profile_id = auth.uid()
        AND tm.provider_id = message_threads.provider_id
        AND tm.is_active = true
    )
  );

-- Fix 2: visible_discovery_providers — missing handle column
--
-- discovery_providers base view has handle; the filtered view omitted it.
-- Code in discoveryService.ts selects handle for @username routing.

CREATE OR REPLACE VIEW public.visible_discovery_providers
  WITH (security_invoker = false)
AS
SELECT
  provider_id,
  profile_id,
  company_name,
  description,
  city,
  trade_categories,
  avatar_url,
  rating,
  rating_count,
  verified,
  is_public,
  provider_created_at,
  provider_updated_at,
  display_name,
  phone,
  role,
  craftsman_role,
  onboarding_done,
  is_operator,
  handle
FROM discovery_providers
WHERE is_public = true AND onboarding_done = true;
