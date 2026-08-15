-- ---------------------------------------------------------------------------
-- Provider Media Table
--
-- Stores structured media references for provider profiles (avatars,
-- portfolio images, cover photos).  This completes the provider_media
-- persistence layer that existing services (providerMediaService,
-- avatarUploadService) already depend on.
--
-- The avatar upload flow uses an UPSERT with ON CONFLICT (provider_id, kind)
-- so that re-uploading an avatar replaces the previous record in place.
--
-- Columns are derived from ProviderMediaRow in providerMediaTypes.ts:
--   id, provider_id, kind, storage_path, public_url, caption,
--   sort_order, created_at, updated_at
--
-- RLS policies:
--   - All authenticated users can read provider_media (public profiles)
--   - Only the owning provider can insert / update / delete their own rows
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_media (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid        NOT NULL REFERENCES public.providers(id),
  kind            text        NOT NULL DEFAULT '',
  storage_path    text,
  public_url      text,
  caption         text,
  sort_order      integer     DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Unique constraint used by avatarUploadService.ts UPSERT:
--   { onConflict: 'provider_id,kind', ignoreDuplicates: false }
-- This ensures only one avatar per provider, one cover per provider, etc.
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_media_provider_kind
  ON public.provider_media (provider_id, kind);

-- Index: look up all media for a specific provider
CREATE INDEX IF NOT EXISTS idx_provider_media_provider_id
  ON public.provider_media (provider_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.provider_media ENABLE ROW LEVEL SECURITY;

-- Public read: provider media is visible to all authenticated users
-- (needed for Explore feed avatar batch queries and profile views)
CREATE POLICY provider_media_select_authenticated ON public.provider_media
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Insert: only the owning provider (via providers.profile_id = auth.uid())
CREATE POLICY provider_media_insert_own ON public.provider_media
  FOR INSERT
  WITH CHECK (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
    )
  );

-- Update: only the owning provider
CREATE POLICY provider_media_update_own ON public.provider_media
  FOR UPDATE
  USING (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
    )
  );

-- Delete: only the owning provider
CREATE POLICY provider_media_delete_own ON public.provider_media
  FOR DELETE
  USING (
    provider_id IN (
      SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
    )
  );
