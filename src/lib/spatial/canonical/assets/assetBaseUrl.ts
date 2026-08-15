/**
 * Spatial public-asset URL resolver.
 *
 * The canonical catalog references CC0 binaries (HDRIs, PBR materials,
 * GLB fixtures) via storage-style paths like
 * `spatial-assets/materials/floor-wood-oak/albedo.ktx2` or
 * `/spatial-assets/hdri/bathroom_2k.exr`. Locally Vite serves those out
 * of `public/spatial-assets/` (seeded by
 * `scripts/download-spatial-catalog.sh`). In production those binaries
 * live in the `spatial-public-assets` Supabase Storage bucket — a
 * one-shot upload from the local checkout (see
 * `scripts/upload-spatial-public-assets.ts` and migration
 * `20260523120058_spatial_public_assets_bucket.sql`).
 *
 * This helper rewrites every catalog-path read into a real URL. When the
 * `VITE_SPATIAL_ASSETS_BASE_URL` env var is set (Vercel prod), it
 * prepends the bucket URL. When it is unset (local dev), it falls back
 * to the Vite-served `/spatial-assets/...` path so `npm run dev` keeps
 * working untouched.
 */

function readBaseUrlFromEnv(): string | undefined {
  const raw =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env.VITE_SPATIAL_ASSETS_BASE_URL
      : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  // Strip trailing slash so we can unconditionally prepend `/path` below.
  return trimmed.replace(/\/+$/, '')
}

/**
 * Local-dev fallback. Vite serves anything under `public/` at the URL
 * root, so `/spatial-assets/...` reaches the file on disk. The leading
 * slash matters: without it, the browser would resolve the URL relative
 * to the current document and 404 for routes like `/craftsman/jobs/123`.
 */
const LOCAL_FALLBACK_PREFIX = '/spatial-assets'

/**
 * Resolves a catalog storage-path to a real URL the renderer / browser
 * can fetch.
 *
 * Accepted inputs (all normalised to the same output):
 *   - `'spatial-assets/materials/foo/albedo.ktx2'`
 *   - `'/spatial-assets/materials/foo/albedo.ktx2'`
 *   - `'materials/foo/albedo.ktx2'` (already-stripped catalog form)
 *
 * Empty / whitespace input returns an empty string — callers must not
 * fetch from it, but it keeps the function total for chained calls.
 */
export function resolveSpatialAssetUrl(storagePath: string): string {
  if (typeof storagePath !== 'string') return ''
  const trimmed = storagePath.trim()
  if (trimmed.length === 0) return ''

  // Strip any leading slashes and an optional `spatial-assets/` prefix
  // so we can recompose with whichever base we choose.
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, '')
  const withoutPrefix = withoutLeadingSlashes.startsWith('spatial-assets/')
    ? withoutLeadingSlashes.slice('spatial-assets/'.length)
    : withoutLeadingSlashes

  const base = readBaseUrlFromEnv() ?? LOCAL_FALLBACK_PREFIX
  return `${base}/${withoutPrefix}`
}

/**
 * Indicates whether a remote bucket base URL is configured. Useful for
 * surfacing deploy-config warnings (e.g. a banner in dev when prod-style
 * asset paths leak in, or vice-versa).
 */
export function isSpatialAssetBucketConfigured(): boolean {
  return readBaseUrlFromEnv() !== undefined
}
