/**
 * Spatial V1 · B-6 · poly.pizza GLB re-pivot + re-scale pipeline
 *
 * poly.pizza CC0 GLBs (Quaternius / Kenney) ship in the model author's own
 * units and origin — a sofa is ~5.5 "units" wide, a Kenney bookcase sits in a
 * corner-origin. Dropping them into the renderer raw would render a 5-metre
 * sofa floating off the floor. The canonical renderer (`ObjectAdapter`) does
 * NOT fit a GLB to its catalog box — it only re-anchors the catalog `pivot`
 * reference point — so the binary itself must already be in real-world metres
 * matching the catalog `dimensions`.
 *
 * This script normalises every raw GLB staged under `models/_raw/{slug}.glb`:
 *
 *   1. flatten the node graph + bake every node transform into geometry
 *      (`clearNodeTransform`) — afterwards world space == local space.
 *   2. measure the world bounding box.
 *   3. non-uniform scale so the bbox exactly equals the catalog `dimensions`
 *      (width→X, height→Y, depth→Z). Exact-fit keeps collision / snap /
 *      clearance — which all read `dimensions` — consistent with the mesh.
 *      The stylized low-poly models tolerate the small per-axis stretch.
 *   4. translate to the canonical frame: floor-aligned (min-Y → 0), centred
 *      in X / Z. This matches what `ObjectAdapter.glbPivotOffset` expects for
 *      a `bottom_center` pivot (offset collapses to zero).
 *   5. weld + dedup + prune the graph.
 *
 * Source of truth: `ASSET_CATALOG` — every `geometry_kind: 'glb'` slug with a
 * staged `_raw` file is processed; the rest (e.g. the Polyhaven mirror) is
 * left untouched.
 *
 * Re-run after a fresh download:
 *   bash scripts/download-spatial-catalog.sh        # fills models/_raw/
 *   npx tsx scripts/repivot-spatial-glb.ts
 */

import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { NodeIO } from '@gltf-transform/core'
import { clearNodeTransform, dedup, flatten, prune, weld } from '@gltf-transform/functions'

import { ASSET_CATALOG } from '../src/lib/spatial/canonical/catalog/asset-catalog.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = join(HERE, '..', 'public', 'spatial-assets', 'models')
const RAW_DIR = join(MODELS_DIR, '_raw')

const io = new NodeIO()

/** Read every POSITION element of a primitive, return a flat [x,y,z][] view via accessor. */
type Vec3 = [number, number, number]

function transformAccessor(
  accessor: import('@gltf-transform/core').Accessor,
  fn: (v: Vec3) => Vec3,
): void {
  const el: number[] = []
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, el)
    const out = fn([el[0], el[1], el[2]])
    accessor.setElement(i, out)
  }
}

async function processSlug(slug: string, dims: { width_m: number; depth_m: number; height_m: number }): Promise<void> {
  const rawPath = join(RAW_DIR, `${slug}.glb`)
  const outPath = join(MODELS_DIR, `${slug}.glb`)
  const doc = await io.read(rawPath)
  const root = doc.getRoot()

  // 1 — flatten the hierarchy, then bake every remaining node transform into
  // geometry so world space == local space (parents first).
  await doc.transform(flatten())
  const bake = (node: import('@gltf-transform/core').Node): void => {
    node.listChildren().forEach(bake)
    clearNodeTransform(node)
  }
  for (const scene of root.listScenes()) scene.listChildren().forEach(bake)

  // Collect the unique vertex-attribute accessors (a stream may be shared by
  // several primitives — transform it exactly once).
  const positions = new Set<import('@gltf-transform/core').Accessor>()
  const normals = new Set<import('@gltf-transform/core').Accessor>()
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute('POSITION')
      if (p) positions.add(p)
      const n = prim.getAttribute('NORMAL')
      if (n) normals.add(n)
    }
  }

  // 2 — world bounding box.
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const acc of positions) {
    transformAccessor(acc, (v) => {
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k]
        if (v[k] > max[k]) max[k] = v[k]
      }
      return v
    })
  }
  const bw = max[0] - min[0]
  const bh = max[1] - min[1]
  const bd = max[2] - min[2]
  if (bw <= 0 || bh <= 0 || bd <= 0) {
    throw new Error(`[repivot] ${slug}: degenerate raw bbox ${bw}×${bh}×${bd}`)
  }

  // 3 — non-uniform scale to the catalog dimensions.
  const sx = dims.width_m / bw
  const sy = dims.height_m / bh
  const sz = dims.depth_m / bd
  // 4 — translate: floor-aligned (min-Y → 0), centred in X / Z.
  const tx = -sx * ((min[0] + max[0]) / 2)
  const ty = -sy * min[1]
  const tz = -sz * ((min[2] + max[2]) / 2)

  for (const acc of positions) {
    transformAccessor(acc, (v) => [sx * v[0] + tx, sy * v[1] + ty, sz * v[2] + tz])
  }
  // Normals transform by the inverse-transpose of the scale, then renormalise.
  for (const acc of normals) {
    transformAccessor(acc, (v) => {
      const n: Vec3 = [v[0] / sx, v[1] / sy, v[2] / sz]
      const len = Math.hypot(n[0], n[1], n[2]) || 1
      return [n[0] / len, n[1] / len, n[2] / len]
    })
  }

  // 5 — graph cleanup.
  await doc.transform(weld(), dedup(), prune())

  // Verify the result fits the catalog box.
  const vmin: Vec3 = [Infinity, Infinity, Infinity]
  const vmax: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute('POSITION')
      if (!p) continue
      transformAccessor(p, (v) => {
        for (let k = 0; k < 3; k++) {
          if (v[k] < vmin[k]) vmin[k] = v[k]
          if (v[k] > vmax[k]) vmax[k] = v[k]
        }
        return v
      })
    }
  }
  const r3 = (n: number): number => Math.round(n * 1000) / 1000
  mkdirSync(MODELS_DIR, { recursive: true })
  await io.write(outPath, doc)
  console.log(
    `  ✓ ${slug}  ${r3(vmax[0] - vmin[0])}×${r3(vmax[1] - vmin[1])}×${r3(vmax[2] - vmin[2])} m` +
      `  (target ${dims.width_m}×${dims.height_m}×${dims.depth_m})  minY=${r3(vmin[1])}`,
  )
}

async function main(): Promise<void> {
  if (!existsSync(RAW_DIR)) {
    console.error(`✗ ${RAW_DIR} missing — run: bash scripts/download-spatial-catalog.sh`)
    process.exit(1)
  }
  const glbAssets = ASSET_CATALOG.filter((a) => a.geometryKind === 'glb')
  console.log(`→ Re-pivot ${glbAssets.length} GLB catalog slots (processing staged _raw files)`)
  let done = 0
  let skipped = 0
  for (const asset of glbAssets) {
    if (!existsSync(join(RAW_DIR, `${asset.slug}.glb`))) {
      console.log(`  · ${asset.slug} — no _raw file, skip (keeps existing models/ binary)`)
      skipped++
      continue
    }
    await processSlug(asset.slug, asset.dimensions)
    done++
  }
  console.log(`✓ re-pivot done — ${done} processed · ${skipped} skipped`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
