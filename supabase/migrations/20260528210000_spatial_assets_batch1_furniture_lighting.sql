-- Spatial Canonical · Batch-1 · Furniture + Lighting expansion (delta on B-6)
--
-- Adds 9 new CC0 GLB catalog entries to spatial_assets, closing high-priority
-- gaps in the V1 catalog (Plan §Phase-1.1 Batch-1):
--
--   Möbel (5):
--     furn-nightstand-2drawer       Quaternius A9vPgVUrF9
--     furn-dresser-tall-3drawer     Quaternius T4uDbyP90C
--     furn-tv-cabinet-lowboard      Kenney     AL6wwiUgP3
--     furn-desk-rectangular         Quaternius V86Go2rlnq
--     furn-office-chair-modern      Kenney     CKSz6PB1vO
--
--   Beleuchtung (3):
--     furn-light-ceiling-flush-mount Quaternius S3HkX8iTl2
--     furn-light-pendant-dome        Quaternius KGq88JUIJo
--     furn-light-table-lamp          Kenney     auXnXwXD7S
--
--   Decor (1):
--     furn-plant-medium             Quaternius bfLOqIV5uP
--
-- All assets verified CC0 via poly.pizza (Quaternius + Kenney = 100% CC0
-- catalogs). HEAD-200 checked on static.poly.pizza CDN URLs.
-- Downloaded to public/spatial-assets/models/_raw/, re-pivoted + re-scaled
-- to catalog dimensions by scripts/repivot-spatial-glb.ts (verified output).
--
-- Catalog: 36 → 45 entries (10 sanitary + 8 kitchen + 8 architecture + 19 furniture).
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts.
-- Schema verified: spatial_assets columns match prod (2026-05-28).
-- Idempotent: INSERT … ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO public.spatial_assets (
  slug, display_name, category, gltf_storage_path, thumbnail_storage_path,
  license, attribution, vendor, published, metadata, geometry_kind,
  object_category, tags, is_counter_host
) VALUES
  (
    'furn-nightstand-2drawer',
    'Nachttisch (2 Schubladen)',
    'furniture',
    'spatial-assets/models/furn-nightstand-2drawer.glb',
    'spatial-assets/thumbnails/furn-nightstand-2drawer.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.5,"depth_m":0.4,"height_m":0.55},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":800,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-nightstand-2drawer.glb","poly_count":800,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-nightstand-2drawer-lod1.glb","poly_count":200,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-nightstand-2drawer-lod2.glb","poly_count":67,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'table', ARRAY['nachttisch','nightstand','tisch','bedside','schlafzimmer']::text[], false
  ),
  (
    'furn-dresser-tall-3drawer',
    'Kommode (3 Schubladen)',
    'furniture',
    'spatial-assets/models/furn-dresser-tall-3drawer.glb',
    'spatial-assets/thumbnails/furn-dresser-tall-3drawer.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.9,"depth_m":0.45,"height_m":1.1},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":600,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-dresser-tall-3drawer.glb","poly_count":600,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-dresser-tall-3drawer-lod1.glb","poly_count":150,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-dresser-tall-3drawer-lod2.glb","poly_count":50,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'wardrobe', ARRAY['kommode','dresser','drawer','schrank','schubladen']::text[], false
  ),
  (
    'furn-tv-cabinet-lowboard',
    'TV-Lowboard',
    'furniture',
    'spatial-assets/models/furn-tv-cabinet-lowboard.glb',
    'spatial-assets/thumbnails/furn-tv-cabinet-lowboard.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.6,"depth_m":0.45,"height_m":0.5},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-tv-cabinet-lowboard.glb","poly_count":500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-tv-cabinet-lowboard-lod1.glb","poly_count":125,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-tv-cabinet-lowboard-lod2.glb","poly_count":42,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'tv_cabinet', ARRAY['tv-möbel','lowboard','cabinet','fernsehmöbel','medienschrank']::text[], false
  ),
  (
    'furn-desk-rectangular',
    'Schreibtisch',
    'furniture',
    'spatial-assets/models/furn-desk-rectangular.glb',
    'spatial-assets/thumbnails/furn-desk-rectangular.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.4,"depth_m":0.7,"height_m":0.75},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":600,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-desk-rectangular.glb","poly_count":600,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-desk-rectangular-lod1.glb","poly_count":150,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-desk-rectangular-lod2.glb","poly_count":50,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'table', ARRAY['schreibtisch','desk','arbeitsplatz','büro','tisch']::text[], false
  ),
  (
    'furn-office-chair-modern',
    'Bürostuhl',
    'furniture',
    'spatial-assets/models/furn-office-chair-modern.glb',
    'spatial-assets/thumbnails/furn-office-chair-modern.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.6,"height_m":1.1},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":700,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-office-chair-modern.glb","poly_count":700,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-office-chair-modern-lod1.glb","poly_count":175,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-office-chair-modern-lod2.glb","poly_count":58,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'chair', ARRAY['bürostuhl','office chair','desk chair','arbeitsstuhl','rollstuhl']::text[], false
  ),
  (
    'furn-light-ceiling-flush-mount',
    'Deckenleuchte',
    'furniture',
    'spatial-assets/models/furn-light-ceiling-flush-mount.glb',
    'spatial-assets/thumbnails/furn-light-ceiling-flush-mount.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.4,"depth_m":0.4,"height_m":0.12},"pivot":"ceiling_top_center","snap_rule":{"target_host":"ceiling","align_to_normal":false},"polycount_lod0":200,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-ceiling-flush-mount.glb","poly_count":200,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-ceiling-flush-mount-lod1.glb","poly_count":50,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-ceiling-flush-mount-lod2.glb","poly_count":17,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['deckenleuchte','ceiling light','flush mount','lampe','licht']::text[], false
  ),
  (
    'furn-light-pendant-dome',
    'Pendelleuchte',
    'furniture',
    'spatial-assets/models/furn-light-pendant-dome.glb',
    'spatial-assets/thumbnails/furn-light-pendant-dome.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.35,"depth_m":0.35,"height_m":0.5},"pivot":"ceiling_top_center","snap_rule":{"target_host":"ceiling","align_to_normal":false},"polycount_lod0":300,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-pendant-dome.glb","poly_count":300,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-pendant-dome-lod1.glb","poly_count":75,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-pendant-dome-lod2.glb","poly_count":25,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['pendelleuchte','pendant','hängelampe','lampe','licht']::text[], false
  ),
  (
    'furn-light-table-lamp',
    'Tischlampe',
    'furniture',
    'spatial-assets/models/furn-light-table-lamp.glb',
    'spatial-assets/thumbnails/furn-light-table-lamp.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.25,"depth_m":0.25,"height_m":0.45},"pivot":"bottom_center","snap_rule":{"target_host":"counter","align_to_normal":false,"min_distance_to_corner_m":0.02},"polycount_lod0":250,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-light-table-lamp.glb","poly_count":250,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-light-table-lamp-lod1.glb","poly_count":63,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-light-table-lamp-lod2.glb","poly_count":21,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'lamp', ARRAY['tischlampe','table lamp','lampe','licht','desk lamp']::text[], false
  ),
  (
    'furn-plant-medium',
    'Zimmerpflanze',
    'furniture',
    'spatial-assets/models/furn-plant-medium.glb',
    'spatial-assets/thumbnails/furn-plant-medium.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.4,"depth_m":0.4,"height_m":0.8},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-plant-medium.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-plant-medium-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-plant-medium-lod2.glb","poly_count":34,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'plant', ARRAY['pflanze','plant','houseplant','zimmerpflanze','topfpflanze']::text[], false
  )
ON CONFLICT (slug) DO NOTHING;

-- Sanity check: published row count after insert.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.spatial_assets WHERE published = true;
  RAISE NOTICE '[batch1] spatial_assets published count = %', v_count;
END $$;
