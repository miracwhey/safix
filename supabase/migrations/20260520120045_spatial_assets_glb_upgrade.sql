-- Spatial Canonical · B-6 · Asset GLB upgrade (delta on 20260520120021)
--
-- Promotes 14 catalog slots to real CC0 GLB models sourced from poly.pizza
-- (Quaternius / Kenney low-poly, re-pivoted + re-scaled to the catalog
-- dimensions by scripts/repivot-spatial-glb.ts):
--   - 5 fixtures  procedural -> glb : toilet · pedestal sink · built-in tub ·
--     fridge · countertop microwave
--   - 9 furniture vendor polyhaven -> poly.pizza (consistent stylized look)
--
-- 'furn-mirror-round-wall' is intentionally NOT touched — no CC0 match, it
-- stays on the Polyhaven model. The 7 other fixture slots stay procedural
-- (their only CC0 match is a freestanding appliance vs. a built-in component,
-- or an orientation-sensitive wall/corner mount).
--
-- Source of truth: src/lib/spatial/canonical/catalog/asset-catalog.ts
-- Real prod schema verified 2026-05-21: spatial_assets has geometry_kind,
-- gltf_storage_path, vendor, metadata(jsonb) — no glb_url/polycount_lod0 cols.
-- Idempotent: per-slug UPDATE, safe to re-run.

UPDATE public.spatial_assets SET
  display_name = 'Stand-WC',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/sanitary-toilet-standard-floor.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/sanitary-toilet-standard-floor.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.37,"depth_m":0.7,"height_m":0.63},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":402,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-toilet-standard-floor.glb","poly_count":402,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-toilet-standard-floor-lod1.glb","poly_count":101,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-toilet-standard-floor-lod2.glb","poly_count":32,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'sanitary-toilet-standard-floor';

UPDATE public.spatial_assets SET
  display_name = 'Standwaschbecken',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/sanitary-sink-pedestal-classic.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/sanitary-sink-pedestal-classic.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.5,"depth_m":0.42,"height_m":0.91},"pivot":"bottom_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.85},"polycount_lod0":632,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-sink-pedestal-classic.glb","poly_count":632,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-sink-pedestal-classic-lod1.glb","poly_count":158,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-sink-pedestal-classic-lod2.glb","poly_count":51,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'sanitary-sink-pedestal-classic';

UPDATE public.spatial_assets SET
  display_name = 'Einbau-Badewanne',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/sanitary-bathtub-builtin-rectangle.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/sanitary-bathtub-builtin-rectangle.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":1.7,"depth_m":0.75,"height_m":0.56},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":1204,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/sanitary-bathtub-builtin-rectangle.glb","poly_count":1204,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/sanitary-bathtub-builtin-rectangle-lod1.glb","poly_count":301,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/sanitary-bathtub-builtin-rectangle-lod2.glb","poly_count":96,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'sanitary-bathtub-builtin-rectangle';

UPDATE public.spatial_assets SET
  display_name = 'Standkühlschrank',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/kitchen-refrigerator-freestanding-tall.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/kitchen-refrigerator-freestanding-tall.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.7,"depth_m":0.76,"height_m":1.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":404,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/kitchen-refrigerator-freestanding-tall.glb","poly_count":404,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/kitchen-refrigerator-freestanding-tall-lod1.glb","poly_count":101,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/kitchen-refrigerator-freestanding-tall-lod2.glb","poly_count":32,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'kitchen-refrigerator-freestanding-tall';

UPDATE public.spatial_assets SET
  display_name = 'Mikrowelle',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/kitchen-microwave-countertop.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/kitchen-microwave-countertop.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.5,"depth_m":0.405,"height_m":0.3},"pivot":"bottom_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":0.6},"polycount_lod0":256,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/kitchen-microwave-countertop.glb","poly_count":256,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/kitchen-microwave-countertop-lod1.glb","poly_count":64,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/kitchen-microwave-countertop-lod2.glb","poly_count":20,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'kitchen-microwave-countertop';

UPDATE public.spatial_assets SET
  display_name = '3-Sitzer-Sofa',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-sofa-3seater-fabric-grey.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-sofa-3seater-fabric-grey.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":2.1,"depth_m":0.92,"height_m":0.85},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":1460,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-sofa-3seater-fabric-grey.glb","poly_count":1460,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-sofa-3seater-fabric-grey-lod1.glb","poly_count":365,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-sofa-3seater-fabric-grey-lod2.glb","poly_count":117,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-sofa-3seater-fabric-grey';

UPDATE public.spatial_assets SET
  display_name = 'Sessel',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-armchair-fabric-rounded.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-armchair-fabric-rounded.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.85,"depth_m":0.85,"height_m":0.95},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":852,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-armchair-fabric-rounded.glb","poly_count":852,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-armchair-fabric-rounded-lod1.glb","poly_count":213,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-armchair-fabric-rounded-lod2.glb","poly_count":68,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-armchair-fabric-rounded';

UPDATE public.spatial_assets SET
  display_name = 'Couchtisch rund',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-coffee-table-round-wood.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-coffee-table-round-wood.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.9,"depth_m":0.9,"height_m":0.42},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":592,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-coffee-table-round-wood.glb","poly_count":592,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-coffee-table-round-wood-lod1.glb","poly_count":148,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-coffee-table-round-wood-lod2.glb","poly_count":47,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-coffee-table-round-wood';

UPDATE public.spatial_assets SET
  display_name = 'Esstisch (6 Personen)',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-dining-table-rectangle-6.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-dining-table-rectangle-6.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":1.8,"depth_m":0.9,"height_m":0.75},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":1500,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-dining-table-rectangle-6.glb","poly_count":1500,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-dining-table-rectangle-6-lod1.glb","poly_count":375,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-dining-table-rectangle-6-lod2.glb","poly_count":120,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-dining-table-rectangle-6';

UPDATE public.spatial_assets SET
  display_name = 'Esszimmerstuhl',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-dining-chair-wood-fabric.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-dining-chair-wood-fabric.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.46,"depth_m":0.52,"height_m":0.9},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":216,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-dining-chair-wood-fabric.glb","poly_count":216,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-dining-chair-wood-fabric-lod1.glb","poly_count":54,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-dining-chair-wood-fabric-lod2.glb","poly_count":17,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-dining-chair-wood-fabric';

UPDATE public.spatial_assets SET
  display_name = 'Doppelbett mit Kopfteil',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-bed-double-frame-headboard.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-bed-double-frame-headboard.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":1.6,"depth_m":2.1,"height_m":1},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":4712,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-bed-double-frame-headboard.glb","poly_count":4712,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-bed-double-frame-headboard-lod1.glb","poly_count":1178,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-bed-double-frame-headboard-lod2.glb","poly_count":377,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-bed-double-frame-headboard';

UPDATE public.spatial_assets SET
  display_name = 'Kleiderschrank',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-wardrobe-3door-tall.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-wardrobe-3door-tall.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":1.5,"depth_m":0.6,"height_m":2.1},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":2988,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-wardrobe-3door-tall.glb","poly_count":2988,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-wardrobe-3door-tall-lod1.glb","poly_count":747,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-wardrobe-3door-tall-lod2.glb","poly_count":239,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-wardrobe-3door-tall';

UPDATE public.spatial_assets SET
  display_name = 'Offenes Regal',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-shelf-open-5tier-wood.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-shelf-open-5tier-wood.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.9,"depth_m":0.35,"height_m":1.8},"pivot":"bottom_center","snap_rule":{"target_host":"wall","align_to_normal":true,"default_height_from_floor_m":1},"polycount_lod0":320,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-shelf-open-5tier-wood.glb","poly_count":320,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-shelf-open-5tier-wood-lod1.glb","poly_count":80,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-shelf-open-5tier-wood-lod2.glb","poly_count":26,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-shelf-open-5tier-wood';

UPDATE public.spatial_assets SET
  display_name = 'Stehlampe',
  geometry_kind = 'glb',
  gltf_storage_path = 'spatial-assets/models/furn-floor-lamp-tripod.glb',
  thumbnail_storage_path = 'spatial-assets/thumbnails/furn-floor-lamp-tripod.jpg',
  vendor = 'poly.pizza',
  metadata = '{"dimensions":{"width_m":0.5,"depth_m":0.5,"height_m":1.6},"pivot":"bottom_center","snap_rule":{"target_host":"floor","align_to_normal":false,"min_distance_to_corner_m":0.05},"polycount_lod0":152,"lod_levels":[{"level":0,"glb_url":"spatial-assets/models/furn-floor-lamp-tripod.glb","poly_count":152,"distance_m_max":2},{"level":1,"glb_url":"spatial-assets/models/furn-floor-lamp-tripod-lod1.glb","poly_count":38,"distance_m_max":8},{"level":2,"glb_url":"spatial-assets/models/furn-floor-lamp-tripod-lod2.glb","poly_count":12,"distance_m_max":1000000}]}'::jsonb,
  updated_at = now()
WHERE slug = 'furn-floor-lamp-tripod';

