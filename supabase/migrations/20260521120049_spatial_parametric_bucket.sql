-- Spatial Canonical · Phase C · (C-2) · Parametric-blob storage bucket
--
-- Purpose:
--   The canonical parametric scene blob (gzip RoomScene wire-format) lives in
--   Supabase Storage at `spatial_scenes.parametric_storage_path`.  Phase B
--   wrote only DB-level org RLS — the Storage BUCKET that the pointer column
--   addresses was never created.  Block C-2 (blob hydration) needs a real
--   download target, so this migration creates it.
--
-- Path schema (documented in schema/parametric-json-schema.ts):
--   {userId}/{sceneId}/parametric-{sha}.json.gz
--   → foldername[1] = uploader userId, foldername[2] = sceneId.
--
-- RLS posture:
--   SELECT  — anyone who may VIEW the scene (customer, provider, org member)
--             may read its blob.  Reuses public.spatial_can_view_scene so the
--             provider-org read path matches the spatial_scenes table RLS —
--             a customer-only read policy would 404 the provider download.
--   INSERT/UPDATE/DELETE — the path-owner ({userId}/…) only.  The customer's
--             scan→parametric conversion uploads here; server-side conversion
--             runs as service_role which bypasses RLS entirely.
--
-- Schema cache refresh: not required (no PostgREST-visible table/RPC).
-- Apply after: 20260521120048_spatial_pin_reviews.sql

-- ── Bucket ────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'spatial-parametric',
  'spatial-parametric',
  false,
  10485760, -- 10 MB — gzipped parametric JSON is small; generous ceiling.
  ARRAY['application/gzip','application/octet-stream','application/json']
)
ON CONFLICT (id) DO NOTHING;

-- ── Path helper ───────────────────────────────────────────────────────────────
-- Safely extracts the {sceneId} path segment as uuid, or NULL when the object
-- name is malformed.  An unguarded `segment::uuid` cast inside an RLS USING
-- clause would raise on any non-uuid path and abort the whole storage query.

CREATE OR REPLACE FUNCTION public.spatial_parametric_scene_id(p_object_name text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, storage
AS $$
DECLARE
  v_seg text;
BEGIN
  v_seg := (storage.foldername(p_object_name))[2];
  IF v_seg IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_seg::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.spatial_parametric_scene_id(text) IS
  'Spatial Phase C (C-2): extracts the {sceneId} segment of a spatial-parametric object path as uuid, NULL on malformed input. Used by the storage.objects SELECT policy.';

-- ── RLS policies on storage.objects ───────────────────────────────────────────
-- storage.objects already has RLS enabled (Supabase-managed).

-- SELECT — scene-viewers (customer + provider + org members).
DROP POLICY IF EXISTS spatial_parametric_select ON storage.objects;
CREATE POLICY spatial_parametric_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'spatial-parametric'
    AND public.spatial_can_view_scene(
      public.spatial_parametric_scene_id(name), auth.uid()
    )
  );

-- INSERT — path-owner only ({userId}/…).
DROP POLICY IF EXISTS spatial_parametric_insert ON storage.objects;
CREATE POLICY spatial_parametric_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'spatial-parametric'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE — path-owner only.
DROP POLICY IF EXISTS spatial_parametric_update ON storage.objects;
CREATE POLICY spatial_parametric_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'spatial-parametric'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'spatial-parametric'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE — path-owner only.
DROP POLICY IF EXISTS spatial_parametric_delete ON storage.objects;
CREATE POLICY spatial_parametric_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'spatial-parametric'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS spatial_parametric_delete ON storage.objects;
-- DROP POLICY IF EXISTS spatial_parametric_update ON storage.objects;
-- DROP POLICY IF EXISTS spatial_parametric_insert ON storage.objects;
-- DROP POLICY IF EXISTS spatial_parametric_select ON storage.objects;
-- DROP FUNCTION IF EXISTS public.spatial_parametric_scene_id(text);
-- DELETE FROM storage.buckets WHERE id = 'spatial-parametric';
