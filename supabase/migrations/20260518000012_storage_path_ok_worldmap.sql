-- Spatial Core · Block B.1 · Extend `spatial_scan_storage_path_ok` for `worldmap`
--
-- Migration `20260518000010_scan_asset_kind_worldmap.sql` added the `worldmap`
-- enum value, but the storage RLS validator in `20260518000007_scan_storage_subpath_rls.sql`
-- predates that and falls through to `ELSE false` — every `worldmap` upload
-- attempt is rejected.
--
-- Fix: idempotent CREATE OR REPLACE with the same body plus a `worldmap`
-- branch. ARWorldMap blobs are NSKeyedArchiver output → opaque binary; we
-- accept `.bin` (matches `EXTENSION_BY_KIND.worldmap` in uploadScanAsset.ts).

CREATE OR REPLACE FUNCTION public.spatial_scan_storage_path_ok(p_name text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_parts text[];
  v_kind  text;
  v_file  text;
  v_lower text;
BEGIN
  IF position('..' in p_name) <> 0 THEN
    RETURN false;
  END IF;

  v_parts := storage.foldername(p_name);
  IF array_length(v_parts, 1) IS NULL OR array_length(v_parts, 1) < 3 THEN
    RETURN false;
  END IF;

  v_kind := v_parts[3];
  v_file := substring(p_name from '[^/]+$');
  v_lower := lower(coalesce(v_file, ''));

  RETURN CASE v_kind
    WHEN 'usdz'          THEN v_lower LIKE '%.usdz'
    WHEN 'gltf'          THEN v_lower LIKE '%.glb' OR v_lower LIKE '%.gltf'
    WHEN 'scan_json'     THEN v_lower LIKE '%.json'
    WHEN 'mesh_summary'  THEN v_lower LIKE '%.json'
    WHEN 'thumbnail'     THEN v_lower LIKE '%.png' OR v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg'
    WHEN 'floorplan_svg' THEN v_lower LIKE '%.svg'
    WHEN 'worldmap'      THEN v_lower LIKE '%.bin'
    ELSE false
  END;
END;
$$;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Re-run migration 20260518000007 to drop the worldmap branch.
