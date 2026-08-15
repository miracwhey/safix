-- Spatial Canonical · Phase 2 · DE-Hero refined procedural-Generators
--
-- Adds 9 new brand-neutral DIN-conform procedural-architecture catalog entries
-- (Plan §Phase-2). Refined slugs for high-fidelity rendering of DE-spezifischer
-- Wand-Infrastruktur — older arch-* slugs stay for backward-compat with
-- already-placed objects in existing scenes.
--
-- Heating (2):
--   arch-radiator-panel-typ22       Plattenheizkörper Typ-22 DIN
--   arch-radiator-convector-floor   Bodenkonvektor mit Gitterrost
--
-- Electrical (5):
--   arch-outlet-schuko-de           Schuko-Steckdose DIN 49441 einzel
--   arch-outlet-schuko-de-double    Schuko-Doppelsteckdose
--   arch-switch-rocker-55           Wippschalter 55×55 System-55
--   arch-switch-rocker-double       Doppel-Wippschalter
--   arch-distribution-box-hager     Sicherungskasten brand-neutral
--   arch-junction-box-cylinder      Abzweigdose Kaiser-Style
--
-- Sanitary (1):
--   arch-mirror-cabinet-led         Spiegelschrank mit LED-Streifen
--
-- All assets pure TypeScript-procedural (procedural-assets.ts) — zero asset
-- download, parametric-deterministic, brand-neutral. Polycount budget: each
-- generator <500 tris (Plan §Phase-2 spec).
--
-- Catalog: 64 → 73 entries (11 sanitary + 10 kitchen + 17 architecture + 35 furniture).
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts +
-- src/lib/spatial/canonical/geometry/procedural-assets.ts.
-- Idempotent: INSERT … ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO public.spatial_assets (
  slug, display_name, category, gltf_storage_path, thumbnail_storage_path,
  license, attribution, vendor, published, metadata, geometry_kind,
  object_category, tags, is_counter_host
) VALUES
  -- ── Heating · 2 ──────────────────────────────────────────────────────────
  (
    'arch-radiator-panel-typ22',
    'Plattenheizkörper Typ-22',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":1.0,"depth_m":0.07,"height_m":0.6},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.15},"polycount_lod0":432,"lod_levels":null}'::jsonb,
    'procedural', 'radiator', ARRAY['heizkörper','plattenheizkörper','typ-22','radiator','din']::text[], false
  ),
  (
    'arch-radiator-convector-floor',
    'Bodenkonvektor',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":1.0,"depth_m":0.25,"height_m":0.08},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.0},"polycount_lod0":348,"lod_levels":null}'::jsonb,
    'procedural', 'radiator', ARRAY['konvektor','boden','heizung','bodenkonvektor','radiator']::text[], false
  ),
  -- ── Electrical · 6 ────────────────────────────────────────────────────────
  (
    'arch-outlet-schuko-de',
    'Schuko-Steckdose (DIN 49441)',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.08,"depth_m":0.022,"height_m":0.08},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.30},"polycount_lod0":156,"lod_levels":null}'::jsonb,
    'procedural', 'electrical_outlet', ARRAY['steckdose','schuko','outlet','din 49441','einzel']::text[], false
  ),
  (
    'arch-outlet-schuko-de-double',
    'Schuko-Doppelsteckdose',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.16,"depth_m":0.022,"height_m":0.08},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.30},"polycount_lod0":288,"lod_levels":null}'::jsonb,
    'procedural', 'electrical_outlet', ARRAY['steckdose','schuko','doppel','2-fach','outlet']::text[], false
  ),
  (
    'arch-switch-rocker-55',
    'Wippschalter 55',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.08,"depth_m":0.021,"height_m":0.08},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":1.05},"polycount_lod0":36,"lod_levels":null}'::jsonb,
    'procedural', 'light_switch', ARRAY['schalter','wippschalter','system-55','switch','licht']::text[], false
  ),
  (
    'arch-switch-rocker-double',
    'Doppel-Wippschalter',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.16,"depth_m":0.021,"height_m":0.08},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":1.05},"polycount_lod0":60,"lod_levels":null}'::jsonb,
    'procedural', 'light_switch', ARRAY['schalter','doppel','2-fach','wipp','switch']::text[], false
  ),
  (
    'arch-distribution-box-hager',
    'Sicherungskasten',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.3,"depth_m":0.1,"height_m":0.4},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":1.5},"polycount_lod0":312,"lod_levels":null}'::jsonb,
    'procedural', NULL, ARRAY['sicherungskasten','verteilerkasten','ls-schalter','unterverteilung']::text[], false
  ),
  (
    'arch-junction-box-cylinder',
    'Abzweigdose',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.1,"depth_m":0.045,"height_m":0.1},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":2.2},"polycount_lod0":160,"lod_levels":null}'::jsonb,
    'procedural', NULL, ARRAY['abzweigdose','verbindungsdose','kaiser','unterputz']::text[], false
  ),
  -- ── Sanitary · 1 ──────────────────────────────────────────────────────────
  (
    'arch-mirror-cabinet-led',
    'Spiegelschrank mit LED',
    'architecture',
    NULL, NULL,
    'CC0-1.0', NULL, 'procedural', true,
    '{"dimensions":{"width_m":0.8,"depth_m":0.15,"height_m":0.7},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":1.4},"polycount_lod0":36,"lod_levels":null}'::jsonb,
    'procedural', 'mirror', ARRAY['spiegelschrank','spiegel','led','cabinet','bad']::text[], false
  )
ON CONFLICT (slug) DO NOTHING;

-- Sanity check: published row count after insert.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.spatial_assets WHERE published = true;
  RAISE NOTICE '[phase2] spatial_assets published count = %', v_count;
END $$;

-- Defensive: PostgREST schema-cache reload (mem:postgrest_schema_cache_reload).
NOTIFY pgrst, 'reload schema';
