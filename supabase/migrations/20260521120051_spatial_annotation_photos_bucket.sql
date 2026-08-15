-- Spatial Canonical · Phase C · (C-10 · Seam 12) · Annotation-photo bucket
--
-- Annotation pins (AnnotationEditorSheet) could attach photos, but Phase B
-- held them as browser object-URLs that vanish when the sheet closes — a
-- silent loss of a problem photo (liability). Block C-10 uploads them to
-- Storage; this migration creates the bucket + RLS.
--
-- Path schema (shared with spatial-parametric): {userId}/{sceneId}/{file}
--   → foldername[1] = uploader, foldername[2] = sceneId. The SELECT policy
--   reuses public.spatial_parametric_scene_id (migration 120049).
--
-- Apply after: 20260521120050_spatial_rescan_customer_read.sql

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'spatial-annotation-photos',
  'spatial-annotation-photos',
  false,
  20971520, -- 20 MB per photo
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- SELECT — scene-viewers (customer + provider org members).
DROP POLICY IF EXISTS spatial_annotation_photos_select ON storage.objects;
CREATE POLICY spatial_annotation_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'spatial-annotation-photos'
    AND public.spatial_can_view_scene(
      public.spatial_parametric_scene_id(name), auth.uid()
    )
  );

-- INSERT — path-owner only ({userId}/…).
DROP POLICY IF EXISTS spatial_annotation_photos_insert ON storage.objects;
CREATE POLICY spatial_annotation_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'spatial-annotation-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE — path-owner only.
DROP POLICY IF EXISTS spatial_annotation_photos_update ON storage.objects;
CREATE POLICY spatial_annotation_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'spatial-annotation-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'spatial-annotation-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- DELETE — path-owner only.
DROP POLICY IF EXISTS spatial_annotation_photos_delete ON storage.objects;
CREATE POLICY spatial_annotation_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'spatial-annotation-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS spatial_annotation_photos_delete ON storage.objects;
-- DROP POLICY IF EXISTS spatial_annotation_photos_update ON storage.objects;
-- DROP POLICY IF EXISTS spatial_annotation_photos_insert ON storage.objects;
-- DROP POLICY IF EXISTS spatial_annotation_photos_select ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'spatial-annotation-photos';
