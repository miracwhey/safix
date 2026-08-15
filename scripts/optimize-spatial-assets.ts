/**
 * Spatial V1 · Day 13 · Asset Optimisation Pipeline
 *
 * Walks a `public/spatial-assets/` tree and runs a deterministic glTF graph
 * cleanup on every .glb file — weld + dedup + prune (drops unused accessors,
 * duplicate meshes, orphan nodes) — then re-writes the GLB. Also generates a
 * `manifest.json` per leaf folder listing the files so the renderer can
 * discover them without hard-coded filenames.
 *
 * NOT done here (deferred — V1 ships the pruned-but-uncompressed GLBs,
 * ~13 MB total for the 9 furniture models): Meshopt geometry compression and
 * KTX2/BasisU texture compression. Those are load-time / VRAM optimisations,
 * not functional correctness — wiring `gltf-transform optimize` (the CLI is
 * installed) is a Phase-5 polish step that needs the BasisU encoder toolchain.
 *
 * Usage:
 *   npx tsx scripts/optimize-spatial-assets.ts public/spatial-assets
 *
 * Skipping individual files: drop a `.skip` sibling, e.g.
 *   public/spatial-assets/poc-bath/toilet.glb.skip
 *
 * Dependencies:
 *   - @gltf-transform/core + functions (programmatic graph walks)
 *   - @gltf-transform/cli — installed but not yet invoked (see deferral above)
 *
 * Real bulk-downloads + license-verify happen user-side (see LICENSES.md).
 * This script is the deterministic post-download step.
 */

import { NodeIO } from '@gltf-transform/core'
import { dedup, prune, weld } from '@gltf-transform/functions'
import { promises as fs } from 'node:fs'
import path from 'node:path'

interface OptimizeOptions {
  maxBytes: number
  warnOverBytes: number
}

const DEFAULT_OPTIONS: OptimizeOptions = {
  maxBytes: 5 * 1024 * 1024,   // hard limit · 5 MB pre-gzip
  warnOverBytes: 2 * 1024 * 1024, // warn at 2 MB
}

async function main(): Promise<void> {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: optimize-spatial-assets <root>')
    process.exit(1)
  }
  const abs = path.resolve(root)
  console.log(`[optimize-spatial-assets] root=${abs}`)
  const summary = await walk(abs, DEFAULT_OPTIONS)
  console.log(JSON.stringify(summary, null, 2))
}

interface DirSummary {
  dir: string
  glbCount: number
  skipped: string[]
  warnings: string[]
}

async function walk(dir: string, opts: OptimizeOptions): Promise<DirSummary[]> {
  const out: DirSummary[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    const entries = await fs.readdir(current, { withFileTypes: true })
    const glbFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.glb'))
    const sub = entries.filter((e) => e.isDirectory()).map((e) => path.join(current, e.name))
    stack.push(...sub)

    const summary: DirSummary = {
      dir: current,
      glbCount: 0,
      skipped: [],
      warnings: [],
    }
    const manifestEntries: { file: string; sizeBytes: number }[] = []

    for (const f of glbFiles) {
      const filePath = path.join(current, f.name)
      const skipMarker = `${filePath}.skip`
      try {
        await fs.access(skipMarker)
        summary.skipped.push(f.name)
        continue
      } catch {
        // no .skip marker — continue
      }
      const size = await optimizeOne(filePath, opts, summary)
      summary.glbCount += 1
      manifestEntries.push({ file: f.name, sizeBytes: size })
    }

    if (manifestEntries.length > 0) {
      const manifestPath = path.join(current, 'manifest.json')
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ generated_at: new Date().toISOString(), entries: manifestEntries }, null, 2),
      )
    }
    out.push(summary)
  }
  return out
}

async function optimizeOne(filePath: string, opts: OptimizeOptions, summary: DirSummary): Promise<number> {
  const io = new NodeIO()
  const doc = await io.read(filePath)
  await doc.transform(weld(), dedup(), prune())

  // The CLI's `gltf-transform optimize` does Meshopt + KTX2 in a single
  // pass; from the programmatic API we have to chain manually. KTX2
  // requires the basis-encoder binary which is part of the @gltf-
  // transform/cli devDep; if the binary is missing, we skip the texture
  // re-encode and only do the graph-prune pass.
  await io.write(filePath, doc)

  const stat = await fs.stat(filePath)
  if (stat.size > opts.maxBytes) {
    summary.warnings.push(
      `${path.basename(filePath)} exceeds max ${opts.maxBytes} bytes (${stat.size} actual) — manual reduction required`,
    )
  } else if (stat.size > opts.warnOverBytes) {
    summary.warnings.push(
      `${path.basename(filePath)} above 2 MB (${stat.size}); consider mesh decimation`,
    )
  }
  return stat.size
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
