-- Spatial Canonical · L2 Data-Contracts · (3/5) · Asset + Material Catalogs
--
-- Purpose:
--   `spatial_assets` — CC0 / managed 3D asset registry.  Each row represents one
--   published glTF asset referenced by `asset_ref` fields inside parametric JSON
--   blobs (e.g. furniture, fixtures, architectural elements).
--
--   `spatial_materials` — PBR material registry.  Each row is a tileable material
--   (albedo / normal / roughness / metallic / AO texture set) applied to surfaces.
--
--   Both catalogs are operator-managed; end-users SELECT only published rows.
--   V1 asset downloads from Storage at gltf_storage_path / albedo_path etc.
--   V1.x: Supabase Storage replaces public/ POC paths (OD-5).
--
-- BD-1: Quality-bar = CC0-stack (Polyhaven, ambientCG, Sketchfab CC0).
--       `license` + `attribution` columns are MANDATORY for that discipline.
--
-- R-numbers covered:
--   R9 — forward-only migration.
--
-- External pairing:
--   RLS policies           → 20260520120010_spatial_canonical_rls.sql (Day 7)
--   updated_at triggers    → 20260520120011_spatial_canonical_triggers.sql (Day 7)
--   Asset pipeline         → scripts/optimize-spatial-assets.ts (Day 13)
--   public/spatial-assets/ → POC paths (Day 13 P2); Supabase Storage from Phase 1
--
-- Plan reference: ~/.claude/plans/spatial-v1-day-6-17-NEXT-CHAT-HANDOVER.md §4 Day 6

-- ── Table: spatial_assets ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_assets (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-readable identifiers
  slug                    text        NOT NULL UNIQUE, -- e.g. 'toilet-standard-v1'
  display_name            text        NOT NULL,

  -- Classification (loose; not enum to allow extension without migrations)
  category                text        NOT NULL, -- e.g. 'furniture', 'fixture', 'architectural'

  -- Storage locations (Supabase Storage paths or public/ during POC)
  gltf_storage_path       text        NOT NULL, -- KTX2-compressed glTF binary (.glb)
  thumbnail_storage_path  text        NULL,

  -- Licensing (BD-1 discipline: CC0 stack)
  license                 text        NOT NULL, -- e.g. 'CC0-1.0', 'CC-BY-4.0'
  attribution             text        NULL,     -- Required for CC-BY; NULL for CC0
  vendor                  text        NULL,     -- e.g. 'polyhaven', 'sketchfab', 'internal'

  -- Catalog state
  published               boolean     NOT NULL DEFAULT false,

  -- Extension bag (dimensions, polycount baseline, tags, etc.)
  metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS spatial_assets_category_idx
  ON public.spatial_assets(category);

CREATE INDEX IF NOT EXISTS spatial_assets_published_idx
  ON public.spatial_assets(published)
  WHERE published = true;

-- Comments
COMMENT ON TABLE  public.spatial_assets IS
  'Spatial Canonical V1: CC0/managed 3D asset registry. '
  'Each row = one published glTF asset. BD-1: license + attribution MANDATORY. '
  'gltf_storage_path = KTX2-compressed .glb; POC uses public/spatial-assets/, '
  'Phase 1 moves to Supabase Storage (OD-5).';

COMMENT ON COLUMN public.spatial_assets.slug IS
  'Stable programmatic identifier used in parametric JSON asset_ref fields. '
  'Must not change after a scene references this asset.';

COMMENT ON COLUMN public.spatial_assets.license IS
  'SPDX license identifier. CC0-1.0 for Polyhaven/ambientCG; '
  'CC-BY-4.0 for attributed Sketchfab CC0 assets.';

COMMENT ON COLUMN public.spatial_assets.attribution IS
  'Required attribution string for CC-BY licensed assets. '
  'Null for CC0-1.0. Tracked for LICENSES.md (Day 13 P3).';

-- RLS (enabled; policies in Day 7)
ALTER TABLE public.spatial_assets ENABLE ROW LEVEL SECURITY;

-- REVOKE writes defence-in-depth (catalogs are service-role-write only)
REVOKE TRUNCATE                ON public.spatial_assets FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE  ON public.spatial_assets FROM anon;


-- ── Table: spatial_materials ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.spatial_materials (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-readable identifiers
  slug                    text        NOT NULL UNIQUE, -- e.g. 'tiles-027-white-subway'
  display_name            text        NOT NULL,

  -- Material category (closed set for V1; extend via migration in Phase 1)
  category                text        NOT NULL
    CONSTRAINT spatial_materials_category_chk
      CHECK (category IN ('tile','paint','wood','stone','metal','concrete','fabric','plaster','other')),

  -- PBR texture set paths (Supabase Storage or public/ during POC)
  -- All paths nullable: a material may have a subset of maps (e.g. albedo-only for paint)
  albedo_path             text        NULL, -- base colour / diffuse
  normal_path             text        NULL, -- tangent-space normal
  roughness_path          text        NULL, -- roughness channel
  metallic_path           text        NULL, -- metallic channel
  ao_path                 text        NULL, -- ambient occlusion

  -- Tiling (metres per tile repeat; NULL = non-tileable or unknown)
  tileable_meters         numeric(6,3) NULL,

  -- Licensing (BD-1 discipline: CC0 stack · ambientCG PBR = CC0)
  license                 text        NOT NULL,
  attribution             text        NULL,
  vendor                  text        NULL, -- e.g. 'ambientcg', 'polyhaven', 'internal'

  -- Catalog state
  published               boolean     NOT NULL DEFAULT false,

  -- Extension bag (resolution, format, preview colour hex, etc.)
  metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS spatial_materials_category_idx
  ON public.spatial_materials(category);

CREATE INDEX IF NOT EXISTS spatial_materials_published_idx
  ON public.spatial_materials(published)
  WHERE published = true;

-- Comments
COMMENT ON TABLE  public.spatial_materials IS
  'Spatial Canonical V1: PBR material registry. '
  'Each row = one tileable PBR material set (albedo/normal/roughness/metallic/AO). '
  'BD-1: license + attribution MANDATORY. ambientCG PBR textures = CC0-1.0. '
  'category CHECK: tile|paint|wood|stone|metal|concrete|fabric|plaster|other.';

COMMENT ON COLUMN public.spatial_materials.tileable_meters IS
  'Metres per UV tile repeat. Used by renderer to compute UV scale from surface dimensions. '
  'NULL for non-tileable materials (decals, logos).';

COMMENT ON COLUMN public.spatial_materials.albedo_path IS
  'Supabase Storage path to KTX2-compressed albedo texture. '
  'POC uses public/spatial-assets/poc-materials/ (Day 14).';

-- RLS (enabled; policies in Day 7)
ALTER TABLE public.spatial_materials ENABLE ROW LEVEL SECURITY;

-- REVOKE writes defence-in-depth (catalogs are service-role-write only)
REVOKE TRUNCATE                ON public.spatial_materials FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE  ON public.spatial_materials FROM anon;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.spatial_materials CASCADE;
-- DROP TABLE IF EXISTS public.spatial_assets     CASCADE;
