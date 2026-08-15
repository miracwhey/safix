-- ---------------------------------------------------------------------------
-- BLOCK 58: Media Upload & Storage Foundation
--
-- Creates the media_uploads table: a general-purpose persisted media record
-- that links uploaded files (stored in Supabase Storage) to platform entities.
--
-- Storage bucket assumption:
--   Bucket name : media
--   Bucket type : public (all objects readable by URL; write via RLS)
--   Path layout : {entity_type}/{entity_id}/{uuid}.{ext}
--     Examples  :
--       profile/{user_id}/abc123.jpg        (provider avatar)
--       projects/{project_id}/def456.png    (project image)
--       disputes/{dispute_id}/ghi789.jpg    (dispute evidence)
--
-- This table stores the metadata / reference record. The file itself lives
-- in Supabase Storage. Callers should always read `public_url` for display
-- and treat `file_path` as the internal storage key.
--
-- Supported entity_type values (extensible; not enforced by DB):
--   profile  – provider/user profile media (avatars, cover photos)
--   project  – project request images
--   message  – chat attachment images
--   dispute  – dispute evidence images
--   job      – job progress / completion photos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.media_uploads (
  id              text        PRIMARY KEY,
  owner_user_id   text        NOT NULL,
  entity_type     text        NOT NULL DEFAULT '',
  entity_id       text        NOT NULL DEFAULT '',
  file_path       text        NOT NULL DEFAULT '',
  public_url      text        NOT NULL DEFAULT '',
  mime_type       text        NOT NULL DEFAULT '',
  media_type      text        NOT NULL DEFAULT 'image',
  created_at      bigint      NOT NULL DEFAULT 0
);

-- Index: look up all media for a specific entity (e.g. all photos on a job)
CREATE INDEX IF NOT EXISTS idx_media_uploads_entity
  ON public.media_uploads (entity_type, entity_id);

-- Index: look up all media owned by a user
CREATE INDEX IF NOT EXISTS idx_media_uploads_owner
  ON public.media_uploads (owner_user_id);

-- Index: chronological ordering
CREATE INDEX IF NOT EXISTS idx_media_uploads_created_at
  ON public.media_uploads (created_at DESC);

ALTER TABLE public.media_uploads ENABLE ROW LEVEL SECURITY;

-- Users may view their own uploads or uploads linked to entities they
-- participate in. Start with simple owner-based access; extend per entity_type
-- as additional flows are hardened.
DROP POLICY IF EXISTS media_uploads_select_own ON public.media_uploads;
CREATE POLICY media_uploads_select_own ON public.media_uploads
  FOR SELECT USING (
    owner_user_id = auth.uid()::text
  );

-- Only the owning user may insert their uploads.
DROP POLICY IF EXISTS media_uploads_insert_own ON public.media_uploads;
CREATE POLICY media_uploads_insert_own ON public.media_uploads
  FOR INSERT WITH CHECK (
    owner_user_id = auth.uid()::text
  );

-- Owners may delete their own uploads.
DROP POLICY IF EXISTS media_uploads_delete_own ON public.media_uploads;
CREATE POLICY media_uploads_delete_own ON public.media_uploads
  FOR DELETE USING (
    owner_user_id = auth.uid()::text
  );
