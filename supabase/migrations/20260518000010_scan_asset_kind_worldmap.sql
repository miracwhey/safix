-- Spatial Core · Block B.1 · Add `worldmap` to scan_asset_kind enum
--
-- Why: B.1 persists ARWorldMap blobs alongside USDZ so re-scans can restore the
--      AR coordinate frame (D2 Layer 3 AR-Hint). Stored as scan_assets row with
--      kind='worldmap', path `{userId}/{scanId}/worldmap/<sha>.bin`.
--
-- Backwards-compat: pure ADD VALUE (non-destructive). Idempotent via IF NOT EXISTS.

ALTER TYPE public.scan_asset_kind ADD VALUE IF NOT EXISTS 'worldmap';

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT unnest(enum_range(NULL::public.scan_asset_kind));
-- Expected: usdz, gltf, scan_json, mesh_summary, thumbnail, floorplan_svg, worldmap
