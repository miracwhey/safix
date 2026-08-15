-- Spatial · Phase E1 · Public Asset Delivery (HDRIs + Materials + Catalog GLBs)
--
-- Purpose:
--   The spatial canonical catalog references ~300 MB of CC0 binary assets
--   (8 Polyhaven HDRIs × 1k+2k EXR + 17 thumbnails, 32 ambientCG PBR
--   material sets × albedo+normal+roughness+ao+displacement+metallic +
--   thumbnails, 14 poly.pizza catalog GLBs + 1 polyhaven mirror GLB).
--   Locally these live under `public/spatial-assets/` (gitignored), seeded
--   via `scripts/download-spatial-catalog.sh`. On Vercel the build step
--   does NOT run that downloader, so production has been 404-ing every
--   HDRI / material / catalog-GLB request since the renderer landed.
--
--   This migration creates the public read-only Storage bucket that will
--   host those CC0 binaries in production. The FE asset-base-url helper
--   (`src/lib/spatial/canonical/assets/assetBaseUrl.ts`) reads
--   `VITE_SPATIAL_ASSETS_BASE_URL` env at build time and rewrites every
--   `/spatial-assets/...` reference to
--   `https://{project}.supabase.co/storage/v1/object/public/spatial-public-assets/...`
--   when set, falling back to the Vite-served `/spatial-assets/` path in
--   local development.
--
-- Why a Storage bucket (not Polyhaven CDN, not Vercel build-time download):
--   - Polyhaven CDN direct: cross-origin perf risk, no LOD-control,
--     hard dependency on Polyhaven uptime. The CC0 license permits
--     re-hosting; do it.
--   - Vercel build-time download: 300 MB pulled on every deploy → +5-10
--     min build, deploys break on Polyhaven outage.
--   - Repo-bundled: 300 MB in git is a non-starter.
--   Bucket = one-shot upload, predictable URLs, free CDN edge cache via
--   Supabase, costs ~$1-2/mo for the storage egress.
--
-- RLS posture:
--   `public: true` flag on the bucket → anyone may SELECT objects via
--   the public URL. No SELECT policy needed.
--   No INSERT / UPDATE / DELETE policies → only service_role can write
--   (service_role bypasses RLS entirely). The upload script
--   (`scripts/upload-spatial-public-assets.ts`) uses the service-role
--   key, so it writes without per-policy grants. End-users can never
--   write — these assets are read-only catalog data.
--
-- MIME-types: HDR/EXR have no registered MIME type, so we accept
--   `application/octet-stream` as the catch-all for both binary lighting
--   probes and GLBs. `image/*` covers JPG/PNG thumbnails. The
--   file_size_limit of 50 MB accommodates 8k HDRIs comfortably (typical
--   2k EXR is 2-8 MB).
--
-- External steps after applying:
--   1. Run `scripts/upload-spatial-public-assets.ts --execute` against
--      a checkout that has `public/spatial-assets/` populated locally
--      (run `scripts/download-spatial-catalog.sh` first if not).
--   2. Set Vercel env `VITE_SPATIAL_ASSETS_BASE_URL` to the bucket
--      public URL:
--      `https://itdntawwuzqfwmcwnwjr.supabase.co/storage/v1/object/public/spatial-public-assets`
--   3. Trigger a Vercel redeploy so the env takes effect.
--
-- Apply after: 20260523120057_timeline_signals_entity_id.sql
-- Plan reference: Phase E discussion 2026-05-23.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'spatial-public-assets',
  'spatial-public-assets',
  true,
  52428800, -- 50 MB ceiling per file (typical HDRI 2-8 MB, GLB 0.1-2 MB).
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/x-exr',
    'model/gltf-binary',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMENT ON COLUMN storage.buckets.id IS
  'spatial-public-assets: CC0 catalog binaries (HDRIs / PBR materials / GLB '
  'fixtures). Public read; service_role-only write. See migration '
  '20260523120058 for full rationale.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DELETE FROM storage.buckets WHERE id = 'spatial-public-assets';
