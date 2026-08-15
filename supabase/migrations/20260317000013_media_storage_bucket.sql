-- ---------------------------------------------------------------------------
-- BLOCK 58 follow-up: Create the `media` storage bucket
--
-- The media_uploads migration (20260317000008) documents the bucket
-- assumption but never creates the bucket itself.  Without this migration
-- every upload fails with "Bucket not found".
--
-- Bucket config:
--   name   : media
--   public : true   (objects readable by URL; write gated by policies)
--
-- Storage RLS policies:
--   authenticated users may upload and delete their own objects.
--   Public read is implicit for public buckets (no SELECT policy needed).
-- ---------------------------------------------------------------------------

-- 1. Create the bucket (idempotent)
INSERT INTO storage.buckets (id, name, public)
VALUES ('media', 'media', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Allow authenticated users to upload files
--    Ownership enforcement for uploads happens at the application layer
--    (media_uploads table RLS) because storage path entity_id varies by
--    entity type (auth UID for profile, provider DB ID for showcase, etc.).
DROP POLICY IF EXISTS "authenticated users can upload media" ON storage.objects;
CREATE POLICY "authenticated users can upload media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'media');

-- 3. Allow authenticated users to delete files they uploaded.
--    The application layer (deleteMediaFile) validates ownership via the
--    media_uploads table before calling storage.remove().
DROP POLICY IF EXISTS "authenticated users can delete media" ON storage.objects;
CREATE POLICY "authenticated users can delete media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'media' AND owner = auth.uid()::text);
