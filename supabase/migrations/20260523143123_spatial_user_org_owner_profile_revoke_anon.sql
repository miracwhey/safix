-- Spatial · Security · REVOKE anon EXECUTE on spatial_user_org_owner_profile
--
-- Purpose:
--   The Worker-Self-Visibility helper `spatial_user_org_owner_profile(uuid)`
--   (migration 20260523120056) was granted EXECUTE to BOTH `authenticated`
--   and `anon`. The companion policy `offers_select_team_member` is scoped
--   `TO authenticated`, so anon callers have no legitimate path that needs
--   this helper. Granting anon EXECUTE was a copy-paste from helpers that
--   intentionally support pre-auth lookups; this one does not.
--
--   Direct-call risk: SECURITY DEFINER + `p_uid` parameter means an anon
--   REST-RPC caller can probe arbitrary uuids and learn whether they
--   belong to a provider-org (and which `profile_id` is the org owner).
--   Low-severity correlation-leak (uuid → uuid mapping, no PII surface)
--   but unnecessary attack surface.
--
--   Sibling helpers `spatial_user_provider_org(uuid)`,
--   `spatial_user_team_role(uuid)`, `create_spatial_offer(...)` are all
--   anon EXECUTE = false. This migration aligns
--   `spatial_user_org_owner_profile` with the same default.
--
-- Verification (read-only, pre-migration):
--   SELECT has_function_privilege('anon', 'public.spatial_user_org_owner_profile(uuid)', 'EXECUTE');
--   -- → true (target state: false)
--
-- Production state assumed:
--   - Function `public.spatial_user_org_owner_profile(uuid)` exists
--     (migration 20260523120056, applied).
--   - Policy `offers_select_team_member` uses it (still works after
--     REVOKE because the policy runs as `authenticated`).
--   - No app code path calls this helper as anon (REST exposure was
--     accidental).
--
-- External steps:
--   None. REVOKE-only, no env vars, no edge-function changes.

REVOKE EXECUTE ON FUNCTION public.spatial_user_org_owner_profile(uuid) FROM anon;

-- Defense in depth: also REVOKE FROM PUBLIC (already REVOKE'd by the
-- original migration but keep the assertion for re-run safety).
REVOKE EXECUTE ON FUNCTION public.spatial_user_org_owner_profile(uuid) FROM PUBLIC;

-- Re-affirm the intended grants (idempotent).
GRANT EXECUTE ON FUNCTION public.spatial_user_org_owner_profile(uuid) TO authenticated;

-- ─── Self-verification (rolled back via DO + RAISE) ─────────────────────────
DO $$
DECLARE
  v_anon_can boolean;
  v_auth_can boolean;
BEGIN
  SELECT has_function_privilege('anon', 'public.spatial_user_org_owner_profile(uuid)', 'EXECUTE')
    INTO v_anon_can;
  SELECT has_function_privilege('authenticated', 'public.spatial_user_org_owner_profile(uuid)', 'EXECUTE')
    INTO v_auth_can;
  IF v_anon_can THEN
    RAISE EXCEPTION 'POST-MIGRATION ASSERT FAILED: anon still has EXECUTE on spatial_user_org_owner_profile';
  END IF;
  IF NOT v_auth_can THEN
    RAISE EXCEPTION 'POST-MIGRATION ASSERT FAILED: authenticated lost EXECUTE on spatial_user_org_owner_profile';
  END IF;
END
$$;
