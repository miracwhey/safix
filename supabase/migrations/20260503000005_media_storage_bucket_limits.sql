-- ---------------------------------------------------------------------------
-- BLOCK M1: Storage-bucket defence-in-depth
--
-- Sets explicit `file_size_limit` and `allowed_mime_types` on the `media`
-- bucket so that even a hostile client that bypasses the JS validation in
-- `validateMediaFile` and the magic-byte check in `runPreUploadPipeline`
-- still cannot upload an oversized file or an unsupported MIME.
--
-- Limits mirror the application-layer caps:
--   * 200 MB hard ceiling (matches MAX_VIDEO_SIZE_BYTES; images are capped
--     much lower at the application layer but the bucket cannot enforce a
--     per-MIME limit, so we use the larger of the two).
--   * MIME whitelist matches ALLOWED_IMAGE_MIME_TYPES + ALLOWED_VIDEO_MIME_TYPES
--     in `src/lib/media/mediaUploadService.ts`.
--
-- Idempotent: re-running the UPDATE is a no-op once the values are in place.
-- ---------------------------------------------------------------------------

UPDATE storage.buckets
SET
  file_size_limit = 209715200,  -- 200 MiB
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
WHERE id = 'media';
