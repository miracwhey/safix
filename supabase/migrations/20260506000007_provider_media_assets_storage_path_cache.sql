-- 20260506000007_provider_media_assets_storage_path_cache.sql
--
-- M1.1 — Cover Cache Patch: add storage_path to sync_provider_media_cover
--
-- Root cause (found in M1 Review Gate):
--   sync_provider_media_cover updated public_url, media_type, poster_url,
--   h264_url but omitted storage_path. deletePortfolioItem reads
--   portfolioItem.storagePath (from provider_media.storage_path) to decide
--   whether to delete the Storage file. Once M2 allows cover-reorder, a
--   cover switch would leave provider_media.storage_path stale, causing
--   the wrong file to be deleted (or not deleted) on the next remove call.
--
-- Fix:
--   1. Replace sync_provider_media_cover to include storage_path in the UPDATE.
--   2. Backfill provider_media.storage_path from the current cover asset for
--      any rows where a mismatch exists.
--   3. Add UNIQUE (portfolio_item_id) WHERE sort_order = 0 to enforce the
--      cover-position convention at the DB level.
--
-- Idempotent: CREATE OR REPLACE + IF NOT EXISTS + ON CONFLICT DO NOTHING.
-- No RLS changes. No new tables. No env vars.

-- ---------------------------------------------------------------------------
-- 1. Replace trigger function — add storage_path to the UPDATE
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

  SELECT public_url, storage_path, media_type, poster_url, h264_url
    INTO v_cover
    FROM public.provider_media_assets
   WHERE portfolio_item_id = v_portfolio_item_id
   ORDER BY sort_order ASC
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.provider_media
       SET public_url    = v_cover.public_url,
           storage_path  = v_cover.storage_path,
           media_type    = v_cover.media_type,
           poster_url    = v_cover.poster_url,
           h264_url      = v_cover.h264_url,
           updated_at    = now()
     WHERE id = v_portfolio_item_id
       AND kind = 'portfolio';
  END IF;

  RETURN NULL;
END;
$$;

-- Trigger itself is unchanged — recreating the function is sufficient.
-- REVOKE stays in place from the previous migration.

-- ---------------------------------------------------------------------------
-- 2. Backfill storage_path for any existing mismatch
--    (idempotent — UPDATE WHERE mismatch exists)
-- ---------------------------------------------------------------------------

UPDATE public.provider_media pm
   SET storage_path = cover.storage_path,
       updated_at   = now()
  FROM (
    SELECT DISTINCT ON (portfolio_item_id)
           portfolio_item_id,
           storage_path
      FROM public.provider_media_assets
     ORDER BY portfolio_item_id, sort_order ASC
  ) AS cover
 WHERE pm.id   = cover.portfolio_item_id
   AND pm.kind = 'portfolio'
   AND pm.storage_path IS DISTINCT FROM cover.storage_path;

-- ---------------------------------------------------------------------------
-- 3. Partial unique index: enforce exactly one cover position per item
--    (safe: all existing items have exactly one asset at sort_order = 0)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_cover_position
  ON public.provider_media_assets (portfolio_item_id)
  WHERE sort_order = 0;
