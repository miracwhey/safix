-- 20260628000300_revoke_guard_fn_execute.sql
--
-- HARDENING (Authz Batch 1a — follow-up) — revoke direct RPC EXECUTE on the three
-- new BEFORE UPDATE trigger guard functions.
--
-- WHY: CREATE FUNCTION grants EXECUTE to PUBLIC (and thus anon/authenticated) by
-- default. Supabase security advisor flags these as
-- anon/authenticated_security_definer_function_executable — the functions are
-- reachable via /rest/v1/rpc/<name>. A direct RPC call would error (a trigger
-- function has no NEW/OLD context), so the exploit risk is low, but the clean
-- posture is to revoke so they are ONLY ever invoked by their triggers.
--
-- NOTE: revoking EXECUTE does NOT affect trigger execution — the BEFORE UPDATE
-- triggers fire via the trigger mechanism (table-owner context), not the caller's
-- EXECUTE privilege. REVOKE FROM PUBLIC alone leaves anon/authenticated intact, so
-- they are listed explicitly.
--
-- ROLLBACK (not recommended):
--   GRANT EXECUTE ON FUNCTION public.change_orders_tamper_guard() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.offers_tamper_guard() TO PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.disputes_metadata_guard() TO PUBLIC;

REVOKE EXECUTE ON FUNCTION public.change_orders_tamper_guard() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.offers_tamper_guard()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.disputes_metadata_guard()    FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
