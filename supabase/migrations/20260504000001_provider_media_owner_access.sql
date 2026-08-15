-- ---------------------------------------------------------------------------
-- Provider Media — Owner-scoped Read & Delete Policies
--
-- Problem
--   public.provider_media currently has only three policies in production:
--     INSERT  – "Provider media: insert own provider"
--               (EXISTS providers WHERE id = provider_id AND profile_id = auth.uid())
--     UPDATE  – "Provider media: update own provider"
--               (same predicate, both USING and WITH CHECK)
--     SELECT  – "Public can read provider media"
--               (EXISTS providers WHERE id = provider_id AND is_public = true)
--
--   Two consequences observed live:
--     1. SELECT visibility is gated on `providers.is_public = true`. An owner
--        whose profile is not yet public cannot read their own provider_media
--        rows. This breaks the avatar-replace flow in
--        src/lib/providerMedia/avatarUploadService.ts:109-114, which does a
--        select-then-update/insert against `provider_media` (kind='avatar')
--        and falls into the INSERT branch when SELECT returns null. A
--        subsequent retry hits the partial unique index
--        `idx_provider_media_provider_kind_singular`
--        (UNIQUE on (provider_id, kind) WHERE kind <> 'portfolio') with
--        Postgres error 23505. Live state on 2026-05-04 confirmed:
--        2 storage objects + 2 media_uploads avatar rows but 0 provider_media
--        avatar rows for the same providers — owner SELECT is blind.
--     2. DELETE has no policy at all. With RLS enabled, default-deny means
--        no DELETE from `provider_media` succeeds for authenticated users.
--        Avatar-replace cleanup
--        (src/lib/providerMedia/avatarUploadService.ts:84-95) and
--        portfolio deletion
--        (src/lib/providerMedia/portfolioItemService.ts:407-440) silently
--        fail or surface a generic error.
--
-- Fix (this migration)
--   Add two owner-scoped policies:
--     * provider_media_select_own — owner reads their own rows regardless of
--       is_public. The existing public-read policy continues to widen access
--       for visitors when is_public=true; PostgreSQL OR-combines policies, so
--       a row visible via either policy remains visible. No public-read
--       semantics are removed.
--     * provider_media_delete_own — owner deletes their own rows.
--   The existing INSERT and UPDATE policies are correct and stay in place;
--   they already enforce owner identity via the same `providers.profile_id =
--   auth.uid()` predicate.
--
-- Idempotent
--   DROP POLICY IF EXISTS guards re-application. Safe to run multiple times.
--
-- Rollout
--   Migration must only be applied after explicit owner sign-off against the
--   shared production database.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS provider_media_select_own ON public.provider_media;
CREATE POLICY provider_media_select_own
  ON public.provider_media
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media.provider_id
        AND p.profile_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS provider_media_delete_own ON public.provider_media;
CREATE POLICY provider_media_delete_own
  ON public.provider_media
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media.provider_id
        AND p.profile_id = auth.uid()
    )
  );
