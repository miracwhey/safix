-- 20260506000006_provider_media_assets.sql
--
-- M1 — provider_media_assets (1:N schema split)
--
-- Introduces the `provider_media_assets` table so that a single portfolio
-- post (`provider_media` row, kind='portfolio') can reference N media items.
--
-- Architecture:
--   provider_media (1)  →  provider_media_assets (N)
--
--   provider_media        = Beitrag-Hülle: metadata, publish state, cover cache
--   provider_media_assets = individual media files (image or video)
--
-- Primary-Asset-Cache strategy:
--   provider_media.{public_url, media_type, poster_url, h264_url} are kept as
--   a denormalized cache of the cover asset (lowest sort_order). A SECURITY
--   DEFINER trigger `sync_provider_media_cover` maintains this cache on any
--   asset INSERT/UPDATE/DELETE so that existing feed queries (M3 scope) and
--   the discovery_providers view continue to work without change.
--
-- Auto-migration:
--   Existing portfolio items with a public_url get one initial asset row seeded
--   from their current provider_media columns (sort_order = 0, cover position).
--   The trigger fires during seeding but writes back the same values — idempotent.
--
-- RLS:
--   Public read  : provider_is_public(provider_id)  — mirrors provider_media
--   Owner read   : EXISTS providers WHERE profile_id = auth.uid()
--   Owner write  : same EXISTS predicate
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS + DROP POLICY IF EXISTS guards.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.provider_media_assets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_item_id uuid        NOT NULL REFERENCES public.provider_media(id) ON DELETE CASCADE,
  provider_id       uuid        NOT NULL REFERENCES public.providers(id),
  sort_order        integer     NOT NULL DEFAULT 0,
  media_type        text        NOT NULL CHECK (media_type IN ('image', 'video')),
  storage_path      text,
  public_url        text        NOT NULL,
  poster_url        text,
  h264_url          text,
  trim_start_ms     integer     NOT NULL DEFAULT 0,
  trim_end_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Primary lookup: all assets for a post, ordered for carousel display
CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_portfolio_item_sort
  ON public.provider_media_assets (portfolio_item_id, sort_order);

-- Provider-scoped lookup for RLS and future analytics
CREATE INDEX IF NOT EXISTS idx_pma_provider_id
  ON public.provider_media_assets (provider_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.provider_media_assets ENABLE ROW LEVEL SECURITY;

-- Public read: any viewer can read assets belonging to public providers
DROP POLICY IF EXISTS pma_select_public ON public.provider_media_assets;
CREATE POLICY pma_select_public
  ON public.provider_media_assets
  FOR SELECT
  USING (public.provider_is_public(provider_id));

-- Owner read: owner sees own assets regardless of is_public
DROP POLICY IF EXISTS pma_select_own ON public.provider_media_assets;
CREATE POLICY pma_select_own
  ON public.provider_media_assets
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media_assets.provider_id
        AND p.profile_id = auth.uid()
    )
  );

-- Owner INSERT
DROP POLICY IF EXISTS pma_insert_own ON public.provider_media_assets;
CREATE POLICY pma_insert_own
  ON public.provider_media_assets
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media_assets.provider_id
        AND p.profile_id = auth.uid()
    )
  );

-- Owner UPDATE
DROP POLICY IF EXISTS pma_update_own ON public.provider_media_assets;
CREATE POLICY pma_update_own
  ON public.provider_media_assets
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media_assets.provider_id
        AND p.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media_assets.provider_id
        AND p.profile_id = auth.uid()
    )
  );

-- Owner DELETE
DROP POLICY IF EXISTS pma_delete_own ON public.provider_media_assets;
CREATE POLICY pma_delete_own
  ON public.provider_media_assets
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.providers p
      WHERE p.id = provider_media_assets.provider_id
        AND p.profile_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Cover-sync trigger
--
-- After any asset change, updates provider_media.{public_url, media_type,
-- poster_url, h264_url} to reflect the current cover asset (MIN sort_order).
-- SECURITY DEFINER bypasses provider_media UPDATE RLS from the trigger context.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_provider_media_cover()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_portfolio_item_id uuid;
  v_cover             record;
BEGIN
  v_portfolio_item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.portfolio_item_id
                              ELSE NEW.portfolio_item_id
                         END;

  SELECT public_url, media_type, poster_url, h264_url
    INTO v_cover
    FROM public.provider_media_assets
   WHERE portfolio_item_id = v_portfolio_item_id
   ORDER BY sort_order ASC
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.provider_media
       SET public_url  = v_cover.public_url,
           media_type  = v_cover.media_type,
           poster_url  = v_cover.poster_url,
           h264_url    = v_cover.h264_url,
           updated_at  = now()
     WHERE id = v_portfolio_item_id
       AND kind = 'portfolio';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_provider_media_cover() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_provider_media_cover ON public.provider_media_assets;
CREATE TRIGGER trg_sync_provider_media_cover
  AFTER INSERT OR UPDATE OR DELETE ON public.provider_media_assets
  FOR EACH ROW EXECUTE FUNCTION public.sync_provider_media_cover();

-- ---------------------------------------------------------------------------
-- Auto-migration: seed one cover asset per existing portfolio item
--
-- The trigger fires for each INSERT and writes back the same values to
-- provider_media — effectively a no-op since the values are identical.
-- ON CONFLICT DO NOTHING makes the migration safe to re-run.
-- ---------------------------------------------------------------------------

INSERT INTO public.provider_media_assets (
  portfolio_item_id,
  provider_id,
  sort_order,
  media_type,
  storage_path,
  public_url,
  poster_url,
  h264_url,
  created_at,
  updated_at
)
SELECT
  pm.id,
  pm.provider_id,
  0,
  COALESCE(pm.media_type, 'image'),
  pm.storage_path,
  pm.public_url,
  pm.poster_url,
  pm.h264_url,
  COALESCE(pm.created_at, now()),
  COALESCE(pm.updated_at, now())
FROM public.provider_media pm
WHERE pm.kind = 'portfolio'
  AND pm.public_url IS NOT NULL
ON CONFLICT (portfolio_item_id, sort_order) DO NOTHING;
