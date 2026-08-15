-- ---------------------------------------------------------------------------
-- BLOCK 58C: Media Foundation Aligned to FixUp Product Logic
--
-- Adds `media_role` column to the existing `media_uploads` table so that
-- records can express their *purpose* within an entity, independent of the
-- entity_type+entity_id routing key.
--
-- Supported media_role values (extensible, not DB-enforced):
--
--   For entity_type = 'profile':
--     avatar          – primary profile picture shown in cards/feeds
--     cover           – optional banner / cover image
--     gallery         – additional profile trust images
--
--   For entity_type = 'dispute':
--     evidence        – file uploaded as evidence for operator review
--
--   For entity_type = 'showcase':
--     showcase        – provider work photo or short reel video
--
--   For entity_type = 'project':
--     project_photo   – customer project request image
--
--   For entity_type = 'job':
--     progress        – in-progress work documentation photo
--     completion      – job completion proof photo
--
-- Defaults to '' (empty) for records created before this migration so that
-- existing rows remain valid.
-- ---------------------------------------------------------------------------

ALTER TABLE public.media_uploads
  ADD COLUMN IF NOT EXISTS media_role text NOT NULL DEFAULT '';

-- Index: look up all records for a specific entity + role combination
-- (e.g. all 'showcase' videos for a provider, all 'evidence' for a dispute)
CREATE INDEX IF NOT EXISTS idx_media_uploads_entity_role
  ON public.media_uploads (entity_type, entity_id, media_role);
