/**
 * One-shot upload of `public/spatial-assets/**` to the
 * `spatial-public-assets` Supabase Storage bucket (migration
 * `20260523120058_spatial_public_assets_bucket.sql`).
 *
 * Use cases:
 *   1. First-time bring-up of the bucket (after seeding the local catalog
 *      with `bash scripts/download-spatial-catalog.sh`).
 *   2. Re-upload after a catalog refresh (the script always upserts, so
 *      existing files are overwritten with the new content).
 *
 * Modes:
 *   --dry-run   (default) — walks the tree, prints what WOULD be uploaded.
 *                            Use first to sanity-check the file set.
 *   --execute             — actually uploads. Requires SUPABASE_SERVICE_ROLE_KEY.
 *
 * Run:
 *   npx tsx scripts/upload-spatial-public-assets.ts            # dry-run
 *   npx tsx scripts/upload-spatial-public-assets.ts --execute  # upload
 *
 * Env (read directly from process.env; export via shell or `.env` loader):
 *   VITE_SUPABASE_URL              project URL (e.g. https://xxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY      admin key (required for --execute)
 * Example:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/upload-spatial-public-assets.ts --execute
 *
 * Skipped:
 *   - asset-manifest.json (catalog metadata; not a runtime asset).
 *   - any file in `models/_raw/` (intermediate, not catalog-referenced).
 *   - files >50 MB (bucket file_size_limit).
 *
 * Idempotent: re-runs upsert; existing public URLs stay stable.
 */

import { statSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, extname, posix } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC_DIR = join(ROOT, 'public', 'spatial-assets')
const BUCKET_ID = 'spatial-public-assets'
const MAX_BYTES = 50 * 1024 * 1024

const SKIP_FILES = new Set(['asset-manifest.json', '.gitkeep', '.gitignore', 'LICENSES.md'])
const SKIP_DIR_NAMES = new Set(['_raw', 'thumbnails-staged'])

const EXEC = process.argv.includes('--execute')
/** Optional `--prefix <sub/path/>` — only upload files whose bucket path starts with it. */
const PREFIX_ARG_IDX = process.argv.indexOf('--prefix')
const PREFIX = PREFIX_ARG_IDX >= 0 ? (process.argv[PREFIX_ARG_IDX + 1] ?? '') : ''

interface FileEntry {
  abs: string
  rel: string
  bytes: number
}

function* walk(dir: string): Generator<FileEntry> {
  for (const name of readdirSync(dir)) {
    if (SKIP_FILES.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(name)) continue
      yield* walk(abs)
      continue
    }
    if (!st.isFile()) continue
    yield {
      abs,
      // posix-style path is what Supabase Storage expects under the bucket root.
      rel: relative(SRC_DIR, abs).split(/[\\/]+/).join(posix.sep),
      bytes: st.size,
    }
  }
}

function contentTypeFor(rel: string): string {
  const ext = extname(rel).toLowerCase()
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.exr':
      return 'image/x-exr'
    case '.glb':
      return 'model/gltf-binary'
    default:
      return 'application/octet-stream'
  }
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

async function main(): Promise<void> {
  try {
    statSync(SRC_DIR)
  } catch {
    console.error(`✗ Source dir missing: ${SRC_DIR}`)
    console.error('  Run `bash scripts/download-spatial-catalog.sh` first.')
    process.exit(1)
  }

  const files: FileEntry[] = []
  let totalBytes = 0
  let oversized = 0
  for (const e of walk(SRC_DIR)) {
    if (PREFIX && !e.rel.startsWith(PREFIX)) continue
    if (e.bytes > MAX_BYTES) {
      console.warn(`⚠ skip oversized (${fmtBytes(e.bytes)}): ${e.rel}`)
      oversized++
      continue
    }
    files.push(e)
    totalBytes += e.bytes
  }

  console.log('')
  console.log(`Source dir : ${SRC_DIR}`)
  console.log(`Bucket     : ${BUCKET_ID}`)
  if (PREFIX) console.log(`Prefix     : ${PREFIX}`)
  console.log(`Files      : ${files.length} (${fmtBytes(totalBytes)} total)`)
  if (oversized > 0) console.log(`Skipped    : ${oversized} oversized`)
  console.log(`Mode       : ${EXEC ? 'EXECUTE' : 'dry-run'}`)
  console.log('')

  if (!EXEC) {
    for (const f of files.slice(0, 20)) {
      console.log(`  [dry] ${f.rel}  (${fmtBytes(f.bytes)})`)
    }
    if (files.length > 20) console.log(`  … and ${files.length - 20} more`)
    console.log('')
    console.log('Pass --execute to actually upload.')
    return
  }

  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('✗ Missing env: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let ok = 0
  let fail = 0
  for (const f of files) {
    const body = readFileSync(f.abs)
    const ct = contentTypeFor(f.rel)
    const { error } = await supabase.storage
      .from(BUCKET_ID)
      .upload(f.rel, body, { upsert: true, contentType: ct })
    if (error) {
      console.error(`✗ ${f.rel} — ${error.message}`)
      fail++
      continue
    }
    ok++
    if (ok % 25 === 0 || ok === files.length) {
      console.log(`  uploaded ${ok}/${files.length}`)
    }
  }

  console.log('')
  console.log(`Done. Uploaded ${ok}/${files.length}. Failures: ${fail}.`)
  if (fail > 0) process.exit(1)
}

void main()
