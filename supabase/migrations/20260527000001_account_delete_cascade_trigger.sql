-- 20260527000001 · Phase 5 Spatial V1.6 · DSGVO cascade trigger (safety-net)
--
-- Hybrid DSGVO-Cascade strategy:
--   • Primary path: api/delete-account.ts (Vercel) clears Storage SYNCHRONOUSLY
--     before calling admin.auth.admin.deleteUser → guarantees orphan-free DB
--     state on the happy path and writes an account_deletion_log row with
--     source='vercel'.
--   • Safety-net (this trigger): fires AFTER DELETE on auth.users for ANY
--     deletion path (admin-console, direct SQL, future RPC). Dispatches the
--     same cleanup logic via pg_net → Edge Function `account-cascade-cleanup`,
--     which writes an audit row with source='trigger'.
--
-- The trigger is FIRE-AND-FORGET: errors never block auth.users DELETE,
-- because letting a 500 from pg_net abort the user deletion would leave the
-- account in an inconsistent state (Supabase admin already returned ok to
-- the caller). EXCEPTION WHEN OTHERS swallows everything; failures are
-- visible via net._http_response + the audit table (missing source='trigger'
-- row signals a delivery failure for the DSGVO auditor).
--
-- ── Dependencies ────────────────────────────────────────────────────────
--   • Extension `pg_net` (installed v0.19.5 — see 20260503000003).
--   • Extension `supabase_vault` (installed v0.3.1).
--   • Vault secrets (seeded out-of-band, NOT in this migration):
--       account_cascade_cleanup.url           — Edge Function URL
--       account_cascade_cleanup.shared_secret — value of x-fixup-trigger-secret
--   • Edge Function `account-cascade-cleanup` deployed with verify_jwt=false.

CREATE OR REPLACE FUNCTION public.handle_auth_user_delete_cascade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  -- 1. Vault lookup. Missing secrets → no-op (must not block DELETE during
  --    initial bring-up before secrets have been seeded).
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'account_cascade_cleanup.url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'account_cascade_cleanup.shared_secret'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'account-cascade: vault unavailable (sqlstate=%, msg=%) — skipping',
      SQLSTATE, SQLERRM;
    RETURN OLD;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'account-cascade: vault entries account_cascade_cleanup.url '
                 'or account_cascade_cleanup.shared_secret missing — skipping';
    RETURN OLD;
  END IF;

  -- 2. Fire async HTTP. pg_net returns a request_id immediately; we don't
  --    await the response. Failures are logged to net._http_response.
  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body := jsonb_build_object('user_id', OLD.id::text),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'account-cascade: pg_net.http_post failed (sqlstate=%, msg=%)',
      SQLSTATE, SQLERRM;
  END;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.handle_auth_user_delete_cascade() IS
  'Phase 5 Spatial V1.6 · Hybrid DSGVO-Cascade safety-net. Vercel-Route '
  '(api/delete-account.ts) is primary and synchronous; this trigger catches '
  'alternative delete paths (admin-console, direct SQL, future RPC) via '
  'pg_net → Edge Function account-cascade-cleanup. EXCEPTION WHEN OTHERS '
  'swallows everything so auth.users DELETE is never blocked.';

DROP TRIGGER IF EXISTS auth_users_after_delete_cascade ON auth.users;

CREATE TRIGGER auth_users_after_delete_cascade
  AFTER DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_delete_cascade();

-- Trigger function runs as SECURITY DEFINER (owner = postgres). Revoke
-- EXECUTE from anon/authenticated so they cannot directly invoke it via
-- RPC (e.g. supabase.rpc('handle_auth_user_delete_cascade')) — this is
-- defense-in-depth; trigger callers don't need EXECUTE grants.
REVOKE ALL ON FUNCTION public.handle_auth_user_delete_cascade() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_delete_cascade() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS auth_users_after_delete_cascade ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_auth_user_delete_cascade();
