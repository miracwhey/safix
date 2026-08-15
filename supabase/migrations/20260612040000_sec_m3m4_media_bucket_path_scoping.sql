-- ===========================================================================
-- SEC M4 — media bucket INSERT path-scoping (foldername ownership)
-- ===========================================================================
-- POSTEN: M4 — any authenticated user can upload to any path in the 'media'
--   bucket; no folder-level ownership enforced at the storage layer.
--
-- ROOT CAUSE (migration 20260317000013):
--   CREATE POLICY "authenticated users can upload media"
--     ON storage.objects FOR INSERT TO authenticated
--     WITH CHECK (bucket_id = 'media');
--   Prod-live name: media_bucket_insert_authenticated (same body).
--   No path constraint — user A can INSERT at profile/{user_B_uid}/photo.jpg
--   or showcase/{user_B_provider_id}/clip.mp4.
--
-- PATH PATTERN in use (mediaUploadService.ts buildStoragePath):
--   {entity_type}/{entity_id}/{uuid}.{ext}
--   profile/{auth.uid()}/9f3d.jpg          ← entity_id = caller's auth UID
--   showcase/{providers.id}/clip.mp4       ← entity_id = providers.id (DB UUID)
--   portfolio/{providers.id}/photo.jpg
--   dispute/{disputes.id}/evidence.jpg     ← entity_id = domain table UUID
--   project/{projects.id}/pin.jpg
--   job/{jobs.id}/progress.jpg
--
-- FIX STRATEGY (mirrors 20260509000001 worker-doku-photos pattern):
--   Replace broad INSERT policy with a path-scoped policy using
--   storage.foldername(name) ownership branches:
--
--   Branch 1 — profile/*:
--     foldername[2] must equal auth.uid()::text (strict user ownership).
--     Both customerAvatarService and avatarUploadService pass entityId=auth.uid().
--
--   Branch 2 — showcase/* and portfolio/*:
--     foldername[2] must be a providers.id with profile_id = auth.uid().
--     showcaseUploadService and portfolioItemService pass entityId=providerId.
--
--   Branch 3 — dispute / project / job / message:
--     Path-format enforcement only (first segment in known-valid set).
--     entity_id here is a domain table UUID, not a user id — full ownership
--     stays at the media_uploads RLS layer (original design intent preserved,
--     defense-in-depth). Orphaned blobs without a media_uploads row are
--     inert: no DB reference, path is a random UUID (unguessable).
--
--   Paths with unknown entity_type → WITH CHECK = false → denied.
--
-- M3 (bucket public → private flip): NOT applied — see open_decisions.
--   Existing public URLs stored in media_uploads.public_url are direct CDN
--   URLs (/storage/v1/object/public/media/...). Flipping to private breaks
--   every rendered image and video in disputes, profiles, showcases,
--   portfolios, and project media. Requires a signed-URL migration first.
--
-- GOTCHA: storage.objects policies MUST be plain apply_migration DDL.
--   supabase_storage_admin owns the table; execute_sql + SET ROLE fails.
--
-- SCHEMA CACHE: no PostgREST reload needed — storage policies are enforced
--   by the Supabase storage service, not PostgREST.
-- ===========================================================================

-- Drop both possible names for idempotency
-- (original migration used quoted name; prod shows unquoted name)
DROP POLICY IF EXISTS "authenticated users can upload media" ON storage.objects;
DROP POLICY IF EXISTS media_bucket_insert_authenticated ON storage.objects;

-- ---------------------------------------------------------------------------
-- New path-scoped INSERT policy
-- ---------------------------------------------------------------------------
CREATE POLICY media_insert_path_scoped
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'media'
    AND (

      -- Branch 1: profile/* — entity_id MUST be the uploading user's own UID.
      -- Prevents user A writing to profile/{user_B_uid}/...
      (
        (storage.foldername(name))[1] = 'profile'
        AND (storage.foldername(name))[2] = auth.uid()::text
      )

      OR

      -- Branch 2: showcase/* and portfolio/* — entity_id must be a providers.id
      -- whose profile_id matches the current user.
      -- Prevents user A writing to showcase/{user_B_provider_id}/...
      (
        (storage.foldername(name))[1] IN ('showcase', 'portfolio')
        AND EXISTS (
          SELECT 1
          FROM public.providers
          WHERE id::text = (storage.foldername(name))[2]
            AND profile_id = auth.uid()
        )
      )

      OR

      -- Branch 3: dispute / project / job / message — path-format only.
      -- entity_id is a domain-table UUID (not a user id); ownership is
      -- enforced at the media_uploads RLS layer (defense-in-depth).
      -- Even an orphaned storage blob is harmless without a matching
      -- media_uploads row, and the path's UUID segment is unguessable.
      (
        (storage.foldername(name))[1] IN ('dispute', 'project', 'job', 'message')
      )

    )
  );

-- ===========================================================================
-- ROLLBACK (run manually to revert):
-- ===========================================================================
--   DROP POLICY IF EXISTS media_insert_path_scoped ON storage.objects;
--   CREATE POLICY media_bucket_insert_authenticated
--     ON storage.objects FOR INSERT TO authenticated
--     WITH CHECK (bucket_id = 'media');
-- ===========================================================================
