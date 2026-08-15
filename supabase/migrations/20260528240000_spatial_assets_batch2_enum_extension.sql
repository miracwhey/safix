-- Spatial Canonical · Batch-2 · Enum-extension CC0 GLBs (delta on Phase-2)
--
-- Adds the 4 catalog entries deferred from Phase 1.2 because they each needed
-- a new ObjectCategory value (the enum delta now landed in
-- src/lib/spatial/canonical/types/objects.ts):
--
--   sanitary-washing-machine       washing_machine       Quaternius UFxsKNSl8W
--   sanitary-toilet-paper-holder   toilet_paper_holder   Quaternius pZojeda7ye
--   decor-curtains-double          curtains              Quaternius kkeII96j9N
--   decor-fireplace                fireplace             Quaternius nzxZYIOCIr
--
-- All assets verified CC0 via poly.pizza (Quaternius = 100% CC0 catalog).
-- Downloaded to public/spatial-assets/models/_raw/, re-pivoted + re-scaled to
-- catalog dimensions by scripts/repivot-spatial-glb.ts (verified output).
--
-- Catalog: 73 → 77 entries (13 sanitary + 10 kitchen + 17 architecture + 37 furniture).
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts.
-- Schema verified: object_category is plain text (no enum/CHECK) — no ALTER TYPE
-- needed; new values insert directly (prod check 2026-05-28).
-- Idempotent: INSERT … ON CONFLICT (slug) DO NOTHING — safe to re-run.

INSERT INTO public.spatial_assets (
  slug, display_name, category, gltf_storage_path, thumbnail_storage_path,
  license, attribution, vendor, published, metadata, geometry_kind,
  object_category, tags, is_counter_host
) VALUES
  (
    'sanitary-washing-machine',
    'Waschmaschine',
    'sanitary',
    'spatial-assets/models/sanitary-washing-machine.glb',
    'spatial-assets/thumbnails/sanitary-washing-machine.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.6,"depth_m":0.6,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":600,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-washing-machine.glb","poly_count":600,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-washing-machine-lod1.glb","poly_count":150,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-washing-machine-lod2.glb","poly_count":48,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'washing_machine', ARRAY['waschmaschine','washing machine','washer','wäsche','frontlader']::text[], false
  ),
  (
    'sanitary-toilet-paper-holder',
    'Toilettenpapierhalter',
    'sanitary',
    'spatial-assets/models/sanitary-toilet-paper-holder.glb',
    'spatial-assets/thumbnails/sanitary-toilet-paper-holder.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":0.16,"depth_m":0.1,"height_m":0.12},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.75},"polycount_lod0":200,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-toilet-paper-holder.glb","poly_count":200,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-toilet-paper-holder-lod1.glb","poly_count":50,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-toilet-paper-holder-lod2.glb","poly_count":16,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'toilet_paper_holder', ARRAY['toilettenpapierhalter','toilet paper holder','klopapierhalter','papierhalter']::text[], false
  ),
  (
    'decor-curtains-double',
    'Vorhänge (Paar)',
    'furniture',
    'spatial-assets/models/decor-curtains-double.glb',
    'spatial-assets/thumbnails/decor-curtains-double.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.5,"depth_m":0.12,"height_m":2.2},"pivot":"wall_back_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.05},"polycount_lod0":400,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/decor-curtains-double.glb","poly_count":400,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/decor-curtains-double-lod1.glb","poly_count":100,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/decor-curtains-double-lod2.glb","poly_count":32,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'curtains', ARRAY['vorhänge','vorhang','curtains','gardine','drapes','fenster']::text[], false
  ),
  (
    'decor-fireplace',
    'Kamin',
    'furniture',
    'spatial-assets/models/decor-fireplace.glb',
    'spatial-assets/thumbnails/decor-fireplace.jpg',
    'CC0-1.0', NULL, 'poly.pizza', true,
    '{"dimensions":{"width_m":1.1,"depth_m":0.4,"height_m":1.15},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":700,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/decor-fireplace.glb","poly_count":700,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/decor-fireplace-lod1.glb","poly_count":175,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/decor-fireplace-lod2.glb","poly_count":56,"distance_m_max":1000000}]}'::jsonb,
    'glb', 'fireplace', ARRAY['kamin','fireplace','feuerstelle','ofen','wohnzimmer']::text[], false
  )
ON CONFLICT (slug) DO NOTHING;

-- Sanity check: published row count after insert.
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.spatial_assets WHERE published = true;
  RAISE NOTICE '[batch2] spatial_assets published count = %', v_count;
END $$;

-- Defensive: refresh PostgREST schema cache so the new rows are visible
-- immediately via the API layer.
NOTIFY pgrst, 'reload schema';
