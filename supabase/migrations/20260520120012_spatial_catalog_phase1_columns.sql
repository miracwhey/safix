-- Spatial Canonical · Phase 1 · Catalog schema alignment (Day 18)
--
-- Purpose:
--   The Day-6 catalog tables (20260520120003) were authored before the Phase-1
--   curation docs. The verified curation (`spatial-v1-material-curation.md` ·
--   `spatial-v1-asset-source-map.md`) needs columns the original tables lack.
--   This migration aligns the schema with the catalog TS source-of-truth in
--   `src/lib/spatial/canonical/catalog/` so the seed migrations
--   (20260520120020 / 20260520120021) can mirror it row-for-row.
--
-- spatial_materials gains:
--   surface_category   — picker Category-Pill (Wand/Boden/Counter/Metall/Dekor)
--   section            — Typ-Sektion label for the grouped picker grid
--   displacement_path   — curation ships a 5-map PBR stack incl. displacement
--   tile_scale_u_m / _v_m — non-square UV tiling (e.g. 0.2 × 2.4 oak panels);
--                        the original `tileable_meters` only models square tiles
--   tags                — DE+EN search synonyms (Mockup 42 §3a search)
--   is_procedural       — decor-mirror is a procedural MeshPhysicalMaterial
--   category CHECK extended with 'brick' + 'ceramic'
--
-- spatial_assets gains:
--   geometry_kind       — 'glb' (downloaded model) | 'procedural' (L1 placeholder)
--   object_category     — fine scene-graph ObjectCategory (NULL for openings)
--   tags                — search synonyms
--   gltf_storage_path made NULLABLE — procedural placeholders have no GLB file
--
-- R-numbers covered:
--   R9 — forward-only migration.
--
-- Apply scope:
--   Phase 1 runs against the InMemory catalog repository; this migration is
--   NOT required on prod until Phase 5 (Day-7 SQL apply). Passive schema step.
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-18-BUILD-HANDOVER.md §5

-- ── spatial_materials ────────────────────────────────────────────────────────

ALTER TABLE public.spatial_materials
  ADD COLUMN IF NOT EXISTS surface_category  text,
  ADD COLUMN IF NOT EXISTS section           text,
  ADD COLUMN IF NOT EXISTS displacement_path text,
  ADD COLUMN IF NOT EXISTS tile_scale_u_m    numeric(7,3),
  ADD COLUMN IF NOT EXISTS tile_scale_v_m    numeric(7,3),
  ADD COLUMN IF NOT EXISTS tags              text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS is_procedural     boolean NOT NULL DEFAULT false;

-- Extend the material-type CHECK: the curation adds white brick (Bricks060)
-- and white ceramic (Tiles107) which the original closed set did not cover.
ALTER TABLE public.spatial_materials
  DROP CONSTRAINT IF EXISTS spatial_materials_category_chk;
ALTER TABLE public.spatial_materials
  ADD CONSTRAINT spatial_materials_category_chk
    CHECK (category IN (
      'tile','paint','wood','stone','metal','concrete','fabric','plaster',
      'brick','ceramic','other'
    ));

-- surface_category is the picker pill axis (orthogonal to material-type).
ALTER TABLE public.spatial_materials
  DROP CONSTRAINT IF EXISTS spatial_materials_surface_category_chk;
ALTER TABLE public.spatial_materials
  ADD CONSTRAINT spatial_materials_surface_category_chk
    CHECK (surface_category IS NULL
      OR surface_category IN ('wall','floor','counter','metal','decor'));

-- A textured material must ship an albedo map; a procedural one must not.
ALTER TABLE public.spatial_materials
  DROP CONSTRAINT IF EXISTS spatial_materials_texture_presence_chk;
ALTER TABLE public.spatial_materials
  ADD CONSTRAINT spatial_materials_texture_presence_chk
    CHECK (is_procedural = true OR albedo_path IS NOT NULL);

CREATE INDEX IF NOT EXISTS spatial_materials_surface_category_idx
  ON public.spatial_materials(surface_category);
CREATE INDEX IF NOT EXISTS spatial_materials_tags_gin_idx
  ON public.spatial_materials USING gin(tags);

COMMENT ON COLUMN public.spatial_materials.surface_category IS
  'Picker Category-Pill: wall|floor|counter|metal|decor. Which surface the '
  'material applies to — orthogonal to category (the physical material type).';
COMMENT ON COLUMN public.spatial_materials.section IS
  'Human-readable Typ-Sektion label for the grouped picker grid (Mockup 42 §3b).';
COMMENT ON COLUMN public.spatial_materials.tile_scale_u_m IS
  'UV tile size along U in meters. Supersedes tileable_meters (square-only); '
  'tileable_meters is kept for back-compat but unused by V1 seeds.';
COMMENT ON COLUMN public.spatial_materials.is_procedural IS
  'True for non-textured procedural materials (decor-mirror = MeshPhysicalMaterial).';

-- ── spatial_assets ───────────────────────────────────────────────────────────

ALTER TABLE public.spatial_assets
  ADD COLUMN IF NOT EXISTS geometry_kind   text NOT NULL DEFAULT 'glb',
  ADD COLUMN IF NOT EXISTS object_category text,
  ADD COLUMN IF NOT EXISTS tags            text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.spatial_assets
  DROP CONSTRAINT IF EXISTS spatial_assets_geometry_kind_chk;
ALTER TABLE public.spatial_assets
  ADD CONSTRAINT spatial_assets_geometry_kind_chk
    CHECK (geometry_kind IN ('glb','procedural'));

-- Procedural box-placeholders (asset-source-map §0) have no GLB file: the
-- original NOT NULL on gltf_storage_path must be relaxed.
ALTER TABLE public.spatial_assets
  ALTER COLUMN gltf_storage_path DROP NOT NULL;

-- ...but a GLB asset MUST carry a path, and a procedural asset MUST NOT.
ALTER TABLE public.spatial_assets
  DROP CONSTRAINT IF EXISTS spatial_assets_glb_path_chk;
ALTER TABLE public.spatial_assets
  ADD CONSTRAINT spatial_assets_glb_path_chk
    CHECK (
      (geometry_kind = 'glb'        AND gltf_storage_path IS NOT NULL)
   OR (geometry_kind = 'procedural' AND gltf_storage_path IS NULL)
    );

CREATE INDEX IF NOT EXISTS spatial_assets_geometry_kind_idx
  ON public.spatial_assets(geometry_kind);
CREATE INDEX IF NOT EXISTS spatial_assets_tags_gin_idx
  ON public.spatial_assets USING gin(tags);

COMMENT ON COLUMN public.spatial_assets.geometry_kind IS
  'glb = downloaded CC0 model in Storage; procedural = L1 box-placeholder '
  '(Phase-1, no GLB file). Phase 2 swaps procedural→glb behind the same slug.';
COMMENT ON COLUMN public.spatial_assets.object_category IS
  'Fine scene-graph ObjectCategory (toilet, oven, ...). NULL for architectural '
  'openings (doors/windows) which are WallOpening nodes, not SpatialObjects.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- ALTER TABLE public.spatial_assets    ALTER COLUMN gltf_storage_path SET NOT NULL;
-- ALTER TABLE public.spatial_assets    DROP CONSTRAINT IF EXISTS spatial_assets_glb_path_chk;
-- ALTER TABLE public.spatial_assets    DROP CONSTRAINT IF EXISTS spatial_assets_geometry_kind_chk;
-- ALTER TABLE public.spatial_assets    DROP COLUMN IF EXISTS geometry_kind, DROP COLUMN IF EXISTS object_category, DROP COLUMN IF EXISTS tags;
-- ALTER TABLE public.spatial_materials DROP COLUMN IF EXISTS surface_category, DROP COLUMN IF EXISTS section,
--   DROP COLUMN IF EXISTS displacement_path, DROP COLUMN IF EXISTS tile_scale_u_m, DROP COLUMN IF EXISTS tile_scale_v_m,
--   DROP COLUMN IF EXISTS tags, DROP COLUMN IF EXISTS is_procedural;
