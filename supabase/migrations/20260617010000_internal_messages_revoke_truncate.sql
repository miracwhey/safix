-- =============================================================================
-- Block F hygiene — revoke RLS-bypassing TRUNCATE on public.internal_messages
-- =============================================================================
-- internal_messages (team/system chat) is read by the client (SELECT, RLS-gated)
-- and written only by the service_role admin path (api/team/absence-notify.ts
-- INSERT). TRUNCATE bypasses RLS entirely and is never a legitimate client op —
-- both anon and authenticated currently hold it (default-privilege footgun, same
-- class as the payments TRUNCATE cleaned in 20260617000000). Strip it.
--
-- Verified against live prod 2026-06-17: grantees anon + authenticated each hold
-- SELECT,TRUNCATE,REFERENCES,TRIGGER; no app code path issues TRUNCATE.
-- SELECT stays (client renders rows under RLS); INSERT is service_role-only.
-- =============================================================================

REVOKE TRUNCATE ON public.internal_messages FROM anon, authenticated;
