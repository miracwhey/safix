-- 20260610153000_h9_confirm_funding_rpc_execute_revoke.sql
-- H9 Defense-in-Depth: confirm_funding_atomic ist SECURITY DEFINER ohne PI-Verify
-- (Live-Def gedumpt 2026-06-10). Einzige legitime Caller sind service-role
-- (api/confirm-funding.ts Admin-Client + api/stripe-webhook.ts reconcileFundingConfirmation).
--
-- CREATE FUNCTION grantet via Default-Privileges EXECUTE an PUBLIC — ohne Revoke
-- kann jeder authenticated User die RPC direkt via PostgREST callen und den
-- API-seitigen Stripe-PI-Verify (H9, api/confirm-funding.ts) umgehen.
--
-- ⚠️ VOR APPLY: Grant-Status in Prod verifizieren (kein blinder Apply):
--   SELECT p.proname, p.proacl,
--          has_function_privilege('authenticated','public.confirm_funding_atomic(uuid,uuid,text)','EXECUTE') AS auth_can_exec,
--          has_function_privilege('anon','public.confirm_funding_atomic(uuid,uuid,text)','EXECUTE') AS anon_can_exec
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'confirm_funding_atomic';
-- Falls auth_can_exec=true ist der API-Fix per PostgREST bypassbar → Apply Pflicht.
-- Falls beide false: Migration ist no-op-sicher (Revokes idempotent), Apply trotzdem ok.

REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) FROM authenticated;

-- service_role verliert durch den PUBLIC-Revoke seinen impliziten Zugriff → explizit granten
GRANT EXECUTE ON FUNCTION public.confirm_funding_atomic(uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
