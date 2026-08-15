-- Spatial Canonical · Batch-2 addendum · decor-rug (enum-extension)
--
-- Adds the 1 catalog entry that completes the decor set: a flat floor rug.
-- Needs a new ObjectCategory value `rug` (host floor, asset-category furniture,
-- zero clearance so furniture can be placed on top). Enum delta lands in
-- src/lib/spatial/canonical/types/objects.ts alongside this row.
--
--   decor-rug   rug   Quaternius 7H5qKjuxVY
--
-- CC0 via poly.pizza (Quaternius). Downloaded to models/_raw/, re-pivoted +
-- re-scaled to catalog dimensions by scripts/repivot-spatial-glb.ts.
--
-- Catalog: 77 → 78 entries (13 sanitary + 10 kitchen + 17 architecture + 38 furniture).
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts.
-- object_category is plain text (no enum/CHECK) — no ALTER TYPE needed.
-- Idempotent: INSERT … ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO public.spatial_assets (
  slug, display_name, category, gltf_storage_path, thumbnail_storage_path,
  license, attribution, vendor, published, metadata, geometry_kind,
  object_category, tags, is_counter_host
) VALUES
  (
    'decor-rug',
    'Teppich',
    'furniture',
    'spatial-assets/models/decor-rug.glb',
    'spatial-assets/thumbnails/decor-rug.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":2.0,"depth_m":1.4,"height_m":0.02},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":50,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/decor-rug.glb","poly_count":50,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/decor-rug-lod1.glb","poly_count":13,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/decor-rug-lod2.glb","poly_count":4,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'rug', ARRAY['teppich','rug','carpet','läufer','vorleger','wohnzimmer']::text[], false
  )
ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.spatial_assets WHERE published = true;
  RAISE NOTICE '[batch2-rug] spatial_assets published count = %', v_count;
END $$;

NOTIFY pgrst, 'reload schema';
