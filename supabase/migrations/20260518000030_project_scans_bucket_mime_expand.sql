-- Spatial Core · Block X.1 · Expand project-scans bucket MIME allowlist + raise size cap
--
-- Until now the bucket only accepted `model/vnd.usdz+zip` (USDZ) at 20 MB.
-- Block X adds the convert-pipeline output (glTF/glb) and Block I will add
-- PDF + SVG + JSON reports — all of these need to land in the same bucket so
-- the {user}/{scan}/{kind}/... path-RLS keeps governing access.
--
-- New MIME allowlist:
--   model/vnd.usdz+zip       — USDZ (Apple, scan capture)
--   model/gltf+json          — glTF (textual)
--   model/gltf-binary        — glb (convert output, primary web format)
--   application/json         — scan.json + mesh_summary.json
--   image/svg+xml            — floorplan.svg
--   image/png                — thumbnails (renderer output)
--   image/webp               — thumbnails (modern client output)
--   application/octet-stream — ARWorldMap NSKeyedArchiver blobs (D2 Layer 3)
--
-- Size cap raised from 20 MB → 50 MB. USDZ from RoomPlan tops out around
-- 10-15 MB; glb after Meshopt + KTX2 is 2-5 MB; ARWorldMap can be 5-30 MB
-- on large rooms. The hard cap on TUS chunk size (6 MB per Supabase) is
-- unaffected by the bucket cap — TUS streams pieces, the cap applies to
-- the final assembled object.

UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY[
    'model/vnd.usdz+zip',
    'model/gltf+json',
    'model/gltf-binary',
    'application/json',
    'image/svg+xml',
    'image/png',
    'image/webp',
    'application/octet-stream'
  ],
  file_size_limit = 52428800  -- 50 MiB
WHERE id = 'project-scans';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- UPDATE storage.buckets
-- SET allowed_mime_types = ARRAY['model/vnd.usdz+zip'],
--     file_size_limit = 20971520  -- 20 MiB
-- WHERE id = 'project-scans';
