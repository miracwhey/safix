/**
 * One-shot cleanup of orphan POC-Folders in spatial-public-assets Storage Bucket.
 *
 * Context (2026-05-28 Phase 0.6.9):
 *   The bucket carries legacy paths from the pre-V1.5 staging phase:
 *     - poc-materials/   (53 files, ~117 MB · ambientCG PBR set staging)
 *     - poc-hdri/        (4 files,  ~35 MB · HDRI staging)
 *
 *   Local mirrors of those folders were deleted in Phase 0.6.1; the bucket
 *   counterparts are now unreferenced (the catalog points at materials/ and
 *   hdri/, not poc-*). storage.remove() through the official client deletes
 *   both metadata + underlying S3 blob (memory:feedback_supabase_storage_delete_leaks_blob).
 *
 *   storage.list() via the JS client returned empty even with the service-role
 *   key — likely an RLS-policy edge case for the storage admin schema. The
 *   path list is therefore enumerated explicitly (sourced from postgres
 *   `SELECT name FROM storage.objects WHERE bucket_id = 'spatial-public-assets'
 *   AND (name LIKE 'poc-materials/%' OR name LIKE 'poc-hdri/%')` ran 2026-05-28).
 *
 * Modes:
 *   --dry-run   (default) — prints the names that WOULD be deleted.
 *   --execute             — actually calls storage.remove().
 *
 * Env (required for either mode):
 *   VITE_SUPABASE_URL              project URL
 *   SUPABASE_SERVICE_ROLE_KEY      admin key
 *
 * Run:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/cleanup-bucket-orphans.ts            # dry-run
 *   npx tsx scripts/cleanup-bucket-orphans.ts --execute  # delete
 */

import { createClient } from '@supabase/supabase-js'

const BUCKET_ID = 'spatial-public-assets'
const EXEC = process.argv.includes('--execute')

const ORPHAN_PATHS: readonly string[] = Object.freeze([
  // HDRIs · 4 (35 MB)
  'poc-hdri/bathroom_2k.exr',
  'poc-hdri/bathroom_4k.exr',
  'poc-hdri/en_suite_2k.exr',
  'poc-hdri/studio_small_03_2k.exr',
  // PBR Materials · 53 (117 MB) — 5 ambientCG sets × 10-11 files each
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_AmbientOcclusion.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_Color.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_Displacement.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_NormalDX.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_NormalGL.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG_Roughness.jpg',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG.blend',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG.mtlx',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG.tres',
  'poc-materials/Concrete047A/Concrete047A_2K-JPG.usdc',
  'poc-materials/Concrete047A/Concrete047A.png',
  'poc-materials/Plaster001/Plaster001_2K-JPG_Color.jpg',
  'poc-materials/Plaster001/Plaster001_2K-JPG_Displacement.jpg',
  'poc-materials/Plaster001/Plaster001_2K-JPG_NormalDX.jpg',
  'poc-materials/Plaster001/Plaster001_2K-JPG_NormalGL.jpg',
  'poc-materials/Plaster001/Plaster001_2K-JPG_Roughness.jpg',
  'poc-materials/Plaster001/Plaster001_2K-JPG.blend',
  'poc-materials/Plaster001/Plaster001_2K-JPG.mtlx',
  'poc-materials/Plaster001/Plaster001_2K-JPG.tres',
  'poc-materials/Plaster001/Plaster001_2K-JPG.usdc',
  'poc-materials/Plaster001/Plaster001.png',
  'poc-materials/Tiles027/Tiles027_2K-JPG_AmbientOcclusion.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG_Color.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG_Displacement.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG_NormalDX.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG_NormalGL.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG_Roughness.jpg',
  'poc-materials/Tiles027/Tiles027_2K-JPG.blend',
  'poc-materials/Tiles027/Tiles027_2K-JPG.mtlx',
  'poc-materials/Tiles027/Tiles027_2K-JPG.tres',
  'poc-materials/Tiles027/Tiles027_2K-JPG.usdc',
  'poc-materials/Tiles027/Tiles027.png',
  'poc-materials/Tiles074/Tiles074_2K-JPG_Color.jpg',
  'poc-materials/Tiles074/Tiles074_2K-JPG_Displacement.jpg',
  'poc-materials/Tiles074/Tiles074_2K-JPG_NormalDX.jpg',
  'poc-materials/Tiles074/Tiles074_2K-JPG_NormalGL.jpg',
  'poc-materials/Tiles074/Tiles074_2K-JPG_Roughness.jpg',
  'poc-materials/Tiles074/Tiles074_2K-JPG.blend',
  'poc-materials/Tiles074/Tiles074_2K-JPG.mtlx',
  'poc-materials/Tiles074/Tiles074_2K-JPG.tres',
  'poc-materials/Tiles074/Tiles074_2K-JPG.usdc',
  'poc-materials/Tiles074/Tiles074.png',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_AmbientOcclusion.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_Color.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_Displacement.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_NormalDX.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_NormalGL.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG_Roughness.jpg',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG.blend',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG.mtlx',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG.tres',
  'poc-materials/WoodFloor007/WoodFloor007_2K-JPG.usdc',
  'poc-materials/WoodFloor007/WoodFloor007.png',
])

async function main(): Promise<void> {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) {
    console.error('✗ Missing env: VITE_SUPABASE_URL')
    process.exit(1)
  }
  if (!key) {
    console.error('✗ Missing env: SUPABASE_SERVICE_ROLE_KEY')
    console.error('  Try: set -a; source .env.local; set +a')
    process.exit(1)
  }

  console.log(`Bucket  : ${BUCKET_ID}`)
  console.log(`Targets : ${ORPHAN_PATHS.length} paths (4 HDRIs + 53 PBR-Material-Files)`)
  console.log(`Mode    : ${EXEC ? 'EXECUTE' : 'dry-run'}`)
  console.log('')

  if (!EXEC) {
    for (const p of ORPHAN_PATHS.slice(0, 8)) console.log(`  [dry] ${p}`)
    if (ORPHAN_PATHS.length > 8) console.log(`  … and ${ORPHAN_PATHS.length - 8} more`)
    console.log('')
    console.log('Pass --execute to actually delete.')
    return
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // storage.remove() takes up to 1000 paths per call.
  const BATCH = 500
  let ok = 0
  let fail = 0
  for (let i = 0; i < ORPHAN_PATHS.length; i += BATCH) {
    const batch = [...ORPHAN_PATHS.slice(i, i + BATCH)]
    const { data, error } = await supabase.storage.from(BUCKET_ID).remove(batch)
    if (error) {
      console.error(`  ✗ batch ${i / BATCH + 1}: ${error.message}`)
      fail += batch.length
      continue
    }
    ok += data?.length ?? batch.length
    console.log(`  removed ${ok}/${ORPHAN_PATHS.length}`)
  }

  console.log('')
  console.log(`Done. Removed ${ok}/${ORPHAN_PATHS.length}. Failures: ${fail}.`)
  if (fail > 0) process.exit(1)
}

void main()
