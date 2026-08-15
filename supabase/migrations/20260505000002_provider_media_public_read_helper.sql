-- 20260505000002_provider_media_public_read_helper.sql
--
-- Reels Visibility Fix — restore public-read on portfolio reels for non-owner
-- viewers without re-exposing PII columns on `providers`.
--
-- Pre-state (verified live 2026-05-05 against itdntawwuzqfwmcwnwjr)
--   public.providers RLS policies (effective):
--     • Providers: read own       (authenticated, profile_id = auth.uid())
--     • Providers: insert own
--     • Providers: update own
--     • NO public-read policy. (`providers_select_public` was removed by
--       20260430000003_providers_pii_lockdown.sql to keep PII gated.)
--
--   public.provider_media RLS policies (effective):
--     • Public can read provider media
--         roles=public,
--         qual = EXISTS (SELECT 1 FROM providers p
--                        WHERE p.id = provider_media.provider_id
--                          AND p.is_public = true)
--     • provider_media_select_own (authenticated, owner via providers)
--     • Insert / Update / Delete: owner-scoped.
--
-- Problem
--   The EXISTS-subquery inside the public-read policy executes under the
--   calling user's RLS context. Because no public-read policy exists on
--   `providers` anymore, non-owner viewers see zero rows in `providers`,
--   so EXISTS returns false and `provider_media` SELECT is denied.
--   Symptom: customers (and any non-owner provider) see zero reels in
--   /explore. Owners see only their own reels via `provider_media_select_own`.
--
-- Fix
--   Introduce a SECURITY DEFINER helper `provider_is_public(uuid)` that
--   checks `providers.is_public` while bypassing the caller's RLS. Replace
--   the failing EXISTS-direct policy with one that calls the helper. PII
--   exposure is unchanged — the function returns only a boolean and reads
--   only `is_public`, never any sensitive column.
--
-- Idempotent
--   CREATE OR REPLACE FUNCTION + DROP POLICY IF EXISTS guard re-application.
--
-- Rollout
--   Owner-sign-off obtained 2026-05-05 (Reels Hardening Block).
--
-- Risk
--   Low. Function is STABLE + read-only, scoped to a single boolean column.
--   No new write paths, no new column reads beyond what the prior policy
--   already evaluated. Search-path is pinned to defeat shadowing attacks.

CREATE OR REPLACE FUNCTION public.provider_is_public(p_provider_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.providers
    WHERE id = p_provider_id AND is_public = true
  );
$$;

REVOKE ALL ON FUNCTION public.provider_is_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provider_is_public(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.provider_is_public(uuid) IS
  'SECURITY DEFINER helper for provider_media public-read RLS. Returns true '
  'when the providers row exists and has is_public=true. Bypasses the '
  'caller-side RLS gap on providers introduced by the 7.1G PII lockdown. '
  'Used exclusively by the "Public can read provider media" policy.';

DROP POLICY IF EXISTS "Public can read provider media" ON public.provider_media;
CREATE POLICY "Public can read provider media"
  ON public.provider_media
  FOR SELECT
  USING (public.provider_is_public(provider_id));
