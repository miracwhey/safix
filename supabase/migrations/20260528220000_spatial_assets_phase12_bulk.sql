-- Spatial Canonical · Phase 1.2 · Quaternius+Kenney bulk expansion (delta on Batch-1)
--
-- Adds 19 new CC0 GLB catalog entries to spatial_assets, closing Plan §Phase-1.2
-- (Roadmap 2026-05-28). Scope-cut from initial 30 → 19:
--
--   • Skipped 5 architecture doors/windows: existing arch-* are procedural by
--     design (asset-catalog.ts §307-309 comment, parametric scales per wall).
--   • Skipped 4 enum-extension-needing slugs (washing_machine, toilet_paper_holder,
--     curtains, fireplace) — deferred to Batch-2 with src/lib/spatial/canonical/
--     types/objects.ts ObjectCategory enum delta.
--   • Skipped 2 with no CC0 match (sliding-glass-door, framed-painting).
--
-- Möbel (10):
--   furn-bunk-bed              Quaternius XpysaEDXJQ  bed
--   furn-bed-king              Quaternius 3kiLmRcb1o  bed
--   furn-bed-single            Kenney     sn8az3odMR  bed
--   furn-stool-round           Quaternius TvaOenUAni  chair
--   furn-table-round-small     Quaternius oEArSZykyi  table
--   furn-table-round-large     Kenney     AXbvcMDC8j  table
--   furn-couch-l-sectional     Quaternius 1kwsjhpY84  sofa
--   furn-couch-2seater         Quaternius vRMLQC5Dfg  sofa
--   furn-cabinet-tall-storage  Kenney     dUd80gOqgO  wardrobe
--   furn-sideboard-modern      Quaternius CBUx8ZMVAO  wardrobe
--
-- Beleuchtung (4):
--   furn-light-chandelier      Quaternius q3k8I8YYX9  lamp (ceiling)
--   furn-light-wall-sconce     Kenney     74FEuNrLJ5  lamp (wall override)
--   furn-light-floor-arc       Quaternius eBQtooeh43  lamp (floor override)
--   furn-light-desk-task       Quaternius uJDWrSJGVH  lamp (counter override)
--
-- Decor (2):
--   decor-cactus               Quaternius HsEJgRLQWX  plant
--   decor-houseplant-tall      Quaternius MbhbP7JrTI  plant
--
-- Sanitary (1):
--   sanitary-towel-rack        Quaternius 8R9fXwL11r  towel_rail (wall)
--
-- Kitchen (2):
--   kitchen-oven-standing      Quaternius VNjPRwui7t  oven
--   kitchen-stove-cooktop      Kenney     kTJU2y4R15  cooktop
--
-- All assets verified CC0 via poly.pizza (Quaternius + Kenney = 100% CC0).
-- HEAD-200 on static.poly.pizza CDN URLs. Re-pivoted + re-scaled to catalog
-- dimensions by scripts/repivot-spatial-glb.ts (output sizes verified match target).
--
-- Catalog: 45 → 64 entries (11 sanitary + 10 kitchen + 8 architecture + 35 furniture).
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts.
-- Idempotent: INSERT … ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO public.spatial_assets (
  slug, display_name, category, gltf_storage_path, thumbnail_storage_path,
  license, attribution, vendor, published, metadata, geometry_kind,
  object_category, tags, is_counter_host
) VALUES
  -- ── Möbel · 10 ────────────────────────────────────────────────────────────
  (
    'furn-bunk-bed',
    'Etagenbett',
    'furniture',
    'spatial-assets/models/furn-bunk-bed.glb',
    'spatial-assets/thumbnails/furn-bunk-bed.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.0,"depth_m":2.0,"height_m":1.65},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":1500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-bunk-bed.glb","poly_count":1500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-bunk-bed-lod1.glb","poly_count":375,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-bunk-bed-lod2.glb","poly_count":125,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'bed', ARRAY['etagenbett','bunk bed','doppelstockbett','bett','kinder']::text[], false
  ),
  (
    'furn-bed-king',
    'King-Size-Bett',
    'furniture',
    'spatial-assets/models/furn-bed-king.glb',
    'spatial-assets/thumbnails/furn-bed-king.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.8,"depth_m":2.1,"height_m":1.0},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":4000,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-bed-king.glb","poly_count":4000,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-bed-king-lod1.glb","poly_count":1000,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-bed-king-lod2.glb","poly_count":334,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'bed', ARRAY['king-size','bett','bed','doppelbett groß']::text[], false
  ),
  (
    'furn-bed-single',
    'Einzelbett',
    'furniture',
    'spatial-assets/models/furn-bed-single.glb',
    'spatial-assets/thumbnails/furn-bed-single.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.9,"depth_m":2.0,"height_m":0.8},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-bed-single.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-bed-single-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-bed-single-lod2.glb","poly_count":34,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'bed', ARRAY['einzelbett','single bed','bett','jugendbett']::text[], false
  ),
  (
    'furn-stool-round',
    'Hocker',
    'furniture',
    'spatial-assets/models/furn-stool-round.glb',
    'spatial-assets/thumbnails/furn-stool-round.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.4,"depth_m":0.4,"height_m":0.45},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":744,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-stool-round.glb","poly_count":744,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-stool-round-lod1.glb","poly_count":186,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-stool-round-lod2.glb","poly_count":62,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'chair', ARRAY['hocker','stool','sitzhocker']::text[], false
  ),
  (
    'furn-table-round-small',
    'Beistelltisch rund',
    'furniture',
    'spatial-assets/models/furn-table-round-small.glb',
    'spatial-assets/thumbnails/furn-table-round-small.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.55,"depth_m":0.55,"height_m":0.45},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-table-round-small.glb","poly_count":500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-table-round-small-lod1.glb","poly_count":125,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-table-round-small-lod2.glb","poly_count":42,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'table', ARRAY['beistelltisch','side table','tisch','rund','klein']::text[], false
  ),
  (
    'furn-table-round-large',
    'Esstisch rund',
    'furniture',
    'spatial-assets/models/furn-table-round-large.glb',
    'spatial-assets/thumbnails/furn-table-round-large.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.2,"depth_m":1.2,"height_m":0.75},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-table-round-large.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-table-round-large-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-table-round-large-lod2.glb","poly_count":34,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'table', ARRAY['esstisch','dining table','tisch','rund','groß']::text[], false
  ),
  (
    'furn-couch-l-sectional',
    'Eck-Sofa (L-Form)',
    'furniture',
    'spatial-assets/models/furn-couch-l-sectional.glb',
    'spatial-assets/thumbnails/furn-couch-l-sectional.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":2.4,"depth_m":1.8,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":2000,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-couch-l-sectional.glb","poly_count":2000,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-couch-l-sectional-lod1.glb","poly_count":500,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-couch-l-sectional-lod2.glb","poly_count":167,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'sofa', ARRAY['eck-sofa','l-couch','sectional','sofa','wohnzimmer']::text[], false
  ),
  (
    'furn-couch-2seater',
    '2-Sitzer-Sofa',
    'furniture',
    'spatial-assets/models/furn-couch-2seater.glb',
    'spatial-assets/thumbnails/furn-couch-2seater.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.5,"depth_m":0.9,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":1200,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-couch-2seater.glb","poly_count":1200,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-couch-2seater-lod1.glb","poly_count":300,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-couch-2seater-lod2.glb","poly_count":100,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'sofa', ARRAY['2-sitzer','couch','sofa','loveseat']::text[], false
  ),
  (
    'furn-cabinet-tall-storage',
    'Schrank schmal hoch',
    'furniture',
    'spatial-assets/models/furn-cabinet-tall-storage.glb',
    'spatial-assets/thumbnails/furn-cabinet-tall-storage.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.8,"depth_m":0.4,"height_m":1.9},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-cabinet-tall-storage.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-cabinet-tall-storage-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-cabinet-tall-storage-lod2.glb","poly_count":34,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'wardrobe', ARRAY['schrank','cabinet','tall storage','hoch']::text[], false
  ),
  (
    'furn-sideboard-modern',
    'Sideboard',
    'furniture',
    'spatial-assets/models/furn-sideboard-modern.glb',
    'spatial-assets/thumbnails/furn-sideboard-modern.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.6,"depth_m":0.45,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":600,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-sideboard-modern.glb","poly_count":600,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-sideboard-modern-lod1.glb","poly_count":150,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-sideboard-modern-lod2.glb","poly_count":50,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'wardrobe', ARRAY['sideboard','kommode','anrichte','wohnzimmer']::text[], false
  ),
  -- ── Beleuchtung · 4 ──────────────────────────────────────────────────────────
  (
    'furn-light-chandelier',
    'Kronleuchter',
    'furniture',
    'spatial-assets/models/furn-light-chandelier.glb',
    'spatial-assets/thumbnails/furn-light-chandelier.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.6,"height_m":0.7},"pivot":"ceiling_top_center","snap_rule":{"target_host":"ceiling","align_to_normal":false},"polycount_lod0":1500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-chandelier.glb","poly_count":1500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-chandelier-lod1.glb","poly_count":375,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-chandelier-lod2.glb","poly_count":125,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['kronleuchter','chandelier','lampe','licht','decke']::text[], false
  ),
  (
    'furn-light-wall-sconce',
    'Wandleuchte',
    'furniture',
    'spatial-assets/models/furn-light-wall-sconce.glb',
    'spatial-assets/thumbnails/furn-light-wall-sconce.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.22,"depth_m":0.18,"height_m":0.32},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true},"polycount_lod0":200,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-wall-sconce.glb","poly_count":200,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-wall-sconce-lod1.glb","poly_count":50,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-wall-sconce-lod2.glb","poly_count":17,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['wandleuchte','wall sconce','lampe','licht','wand']::text[], false
  ),
  (
    'furn-light-floor-arc',
    'Bogen-Stehlampe',
    'furniture',
    'spatial-assets/models/furn-light-floor-arc.glb',
    'spatial-assets/thumbnails/furn-light-floor-arc.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.5,"depth_m":1.2,"height_m":1.8},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-floor-arc.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-floor-arc-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-floor-arc-lod2.glb","poly_count":34,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['stehlampe','bogenlampe','floor lamp','arc','lampe']::text[], false
  ),
  (
    'furn-light-desk-task',
    'Schreibtischlampe',
    'furniture',
    'spatial-assets/models/furn-light-desk-task.glb',
    'spatial-assets/thumbnails/furn-light-desk-task.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.2,"depth_m":0.35,"height_m":0.45},"pivot":"bottom_center","snap_rule":{"target_host":"counter","align_to_normal":false,"min_distance_to_corner_m":0.02},"polycount_lod0":300,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-desk-task.glb","poly_count":300,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-desk-task-lod1.glb","poly_count":75,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-desk-task-lod2.glb","poly_count":25,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['schreibtischlampe','desk lamp','task light','lampe','büro']::text[], false
  ),
  -- ── Decor · 2 ────────────────────────────────────────────────────────────────
  (
    'decor-cactus',
    'Kaktus',
    'furniture',
    'spatial-assets/models/decor-cactus.glb',
    'spatial-assets/thumbnails/decor-cactus.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.25,"depth_m":0.25,"height_m":0.45},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":300,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/decor-cactus.glb","poly_count":300,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/decor-cactus-lod1.glb","poly_count":75,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/decor-cactus-lod2.glb","poly_count":25,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'plant', ARRAY['kaktus','cactus','pflanze','topfpflanze']::text[], false
  ),
  (
    'decor-houseplant-tall',
    'Pflanze hoch',
    'furniture',
    'spatial-assets/models/decor-houseplant-tall.glb',
    'spatial-assets/thumbnails/decor-houseplant-tall.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.5,"depth_m":0.5,"height_m":1.4},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":600,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/decor-houseplant-tall.glb","poly_count":600,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/decor-houseplant-tall-lod1.glb","poly_count":150,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/decor-houseplant-tall-lod2.glb","poly_count":50,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'plant', ARRAY['pflanze hoch','tall plant','monstera','pflanze','topfpflanze']::text[], false
  ),
  -- ── Sanitary · 1 ──────────────────────────────────────────────────────────────
  (
    'sanitary-towel-rack',
    'Handtuchhalter',
    'sanitary',
    'spatial-assets/models/sanitary-towel-rack.glb',
    'spatial-assets/thumbnails/sanitary-towel-rack.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.08,"height_m":0.4},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true},"polycount_lod0":200,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-towel-rack.glb","poly_count":200,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-towel-rack-lod1.glb","poly_count":50,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-towel-rack-lod2.glb","poly_count":17,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'towel_rail', ARRAY['handtuchhalter','towel rack','towel rail','halter']::text[], false
  ),
  -- ── Kitchen · 2 ──────────────────────────────────────────────────────────────
  (
    'kitchen-oven-standing',
    'Backofen Standgerät',
    'kitchen',
    'spatial-assets/models/kitchen-oven-standing.glb',
    'spatial-assets/thumbnails/kitchen-oven-standing.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.6,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/kitchen-oven-standing.glb","poly_count":500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/kitchen-oven-standing-lod1.glb","poly_count":125,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/kitchen-oven-standing-lod2.glb","poly_count":42,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'oven', ARRAY['backofen','ofen','oven','standgerät','küche']::text[], false
  ),
  (
    'kitchen-stove-cooktop',
    'Herd mit Kochfeld',
    'kitchen',
    'spatial-assets/models/kitchen-stove-cooktop.glb',
    'spatial-assets/thumbnails/kitchen-stove-cooktop.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.6,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":350,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/kitchen-stove-cooktop.glb","poly_count":350,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/kitchen-stove-cooktop-lod1.glb","poly_count":88,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/kitchen-stove-cooktop-lod2.glb","poly_count":30,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'cooktop', ARRAY['herd','kochfeld','cooktop','stove','küche']::text[], false
  )
ON CONFLICT (slug) DO NOTHING;

-- Sanity check: published row count after insert.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.spatial_assets WHERE published = true;
  RAISE NOTICE '[phase12] spatial_assets published count = %', v_count;
END $$;

-- Defensive: PostgREST schema-cache reload (mem:postgrest_schema_cache_reload).
NOTIFY pgrst, 'reload schema';
