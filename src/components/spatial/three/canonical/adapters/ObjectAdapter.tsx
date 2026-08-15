/**
 * Spatial · Canonical · Adapters · ObjectAdapter
 * (Phase 1.5 · Block R2 geometry · Block R4 GLB loader · Block R5 material)
 *
 * Renders a canonical `SpatialObject` as its catalog geometry:
 *
 *   - procedural catalog asset → the L1 box-placeholder mesh
 *     (`buildProceduralAsset`) converted to a `THREE.BufferGeometry`
 *     via the R1 converter.
 *   - GLB catalog asset → the real Polyhaven CC0 model, loaded through
 *     `MeshoptGLTFLoader` behind the shared reference-counted `asset-cache`
 *     (Block R4). While the binary is in flight the dimension-correct
 *     `buildGenericBox` placeholder renders as the `<Suspense>` fallback; a
 *     missing / corrupt GLB is caught by `<ObjectErrorBoundary>` and also
 *     falls back to the generic box (e.g. `furn-floor-lamp-tripod`, which has
 *     no GLB file on disk).
 *   - no `asset_id`, unknown slug, or a build failure → `buildGenericBox`
 *     from the object's `dimensions` so collision/clearance silhouettes
 *     stay accurate.
 *
 * Material (Block R5): the procedural / generic-box path resolves the object's
 * `material_id` override through `<SurfaceMaterial>` — the variant stack can
 * re-finish a placeholder fixture. GLB models keep their embedded Polyhaven
 * materials: a single flat catalog material cannot meaningfully re-skin a
 * multi-mesh authored model (a sofa's fabric + wooden legs), so a `material_id`
 * on a GLB object is intentionally ignored until per-slot material binding
 * lands in Phase 2.
 *
 * Pivot handling: `buildProceduralAsset` / `buildGenericBox` return a mesh
 * whose pivot reference point sits at the local origin. The host re-anchoring
 * below positions the AABB *centre* of the object. To keep that contract, the
 * converted geometry is offset by the pivot→AABB-centre delta on an inner
 * mesh. The GLB path applies the analogous correction: a loaded GLTF scene has
 * its own author-defined pivot, so the model is offset by the delta between
 * the catalog `pivot` reference point of its bounding box and the AABB centre.
 *
 * Host contexts (see H27 audit-fix in the bridge):
 *   - host: 'floor'     → placed at world-Y = 0 + object.dimensions.height_m / 2
 *   - host: 'wall'      → placed inside the wall group, surface offset
 *   - host: 'ceiling'   → placed at world-Y = ceiling.height_m
 *   - host: 'free'      → placed at object.transform.position
 *   - host: 'counter'   → placed on a counter's top surface: the snap-resolved
 *     `transform.position.y` holds the counter-top height, so the object's
 *     centre lands at that height + half its own height (B-2).
 */

import { Suspense, useEffect, useMemo, type ReactElement } from 'react'
import { useThree } from '@react-three/fiber'
import { Box3, BoxGeometry, EdgesGeometry, type BufferGeometry, type Group } from 'three'

import {
  buildGenericBox,
  buildProceduralAsset,
  hasProceduralAsset,
  type ProceduralAssetResult,
} from '../../../../../lib/spatial/canonical/geometry/procedural-assets.ts'
import { getCatalogAsset } from '../../../../../lib/spatial/canonical/catalog/asset-catalog.ts'
import { categoryToDefaultAsset } from '../../../../../lib/spatial/canonical/catalog/categoryToDefaultAsset.ts'
import { fitScaleForDims, extentOfBox } from '../../../../../lib/spatial/canonical/geometry/fitScale.ts'
import { CATEGORY_DEFAULT_MATERIAL } from '../../../../../lib/spatial/canonical/types/objects.ts'
import type { SpatialObject } from '../../../../../lib/spatial/canonical/types/objects.ts'

import { proceduralMeshToBufferGeometry } from '../geometry/proceduralMeshToBufferGeometry.ts'
import { SurfaceMaterial } from '../materials/SurfaceMaterial.tsx'
import { ObjectErrorBoundary } from './ObjectErrorBoundary.tsx'
import { readGlb, releaseGlb, resolveGlbUrl, retainGlb } from '../loaders/glbObjectLoader.ts'
import { PickProxy } from '../PickProxy.tsx'
import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'

interface ObjectAdapterContext {
  /** Wall context — set when this adapter is rendered inside a WallAdapter. */
  wallLength?: number
  wallHeight?: number
  wallThickness?: number
  /** Ceiling context — set when rendered inside a CeilingAdapter. */
  ceilingY?: number
}

interface ObjectAdapterProps {
  object: SpatialObject
  context?: ObjectAdapterContext
}

/** Local dimensions of an object, with the Day-11 fallback for missing data. */
function objectDims(object: SpatialObject): { width_m: number; height_m: number; depth_m: number } {
  return {
    width_m: object.dimensions?.width_m ?? 0.4,
    height_m: object.dimensions?.height_m ?? 0.4,
    depth_m: object.dimensions?.depth_m ?? 0.4,
  }
}

/**
 * Resolve the SpatialObject to a procedural / generic-box result.
 *
 * Used for the procedural catalog path AND as the GLB Suspense / error
 * fallback. Never used for the *successful* GLB path — that renders the real
 * model. The result always carries a dimension-correct AABB so collision and
 * clearance stay accurate regardless of which branch renders.
 */
function resolveBoxResult(object: SpatialObject): ProceduralAssetResult {
  const dims = objectDims(object)
  // Scan objects carry no asset_id — fall back to a category default (GLB slug
  // or, reuse-first, an existing procedural silhouette) so a scanned fixture
  // renders its real model / silhouette instead of a brown box. A set asset_id
  // always wins via the leading `??` arm.
  const slug = object.asset_id ?? categoryToDefaultAsset(object.category) ?? undefined
  if (slug) {
    const catalogAsset = getCatalogAsset(slug)
    if (catalogAsset) {
      if (catalogAsset.geometryKind === 'procedural' && hasProceduralAsset(slug)) {
        try {
          return buildProceduralAsset(slug)
        } catch {
          // A malformed procedural spec must not blank the scene.
          return buildGenericBox(dims, catalogAsset.pivot, slug)
        }
      }
      // GLB asset (or a procedural slug without a placeholder spec): the box
      // carries the catalog dimensions + pivot so placement / collision stay
      // correct while the GLB loads or if it fails.
      return buildGenericBox(dims, catalogAsset.pivot, slug)
    }
  }
  // No asset reference / unknown slug.
  return buildGenericBox(dims)
}

interface XYZ {
  x: number
  y: number
  z: number
}

/** Pivot→AABB-centre offset so a pivot-anchored mesh occupies the AABB centre. */
function pivotToCentreOffset(bbox: { min: XYZ; max: XYZ }): [number, number, number] {
  return [
    -((bbox.min.x + bbox.max.x) / 2),
    -((bbox.min.y + bbox.max.y) / 2),
    -((bbox.min.z + bbox.max.z) / 2),
  ]
}

/**
 * The dimension-correct generic-box / procedural placeholder mesh.
 *
 * Rendered directly for procedural assets, and reused verbatim as the GLB
 * Suspense fallback (while loading) and the `<ObjectErrorBoundary>` fallback
 * (missing / corrupt GLB). The `material_id` override re-finishes the box.
 */
function PlaceholderMesh({
  object,
  isSelected,
  fitToDims,
}: {
  object: SpatialObject
  isSelected?: boolean
  /** When set (scan render-fallback), scale the placeholder to these measured dims. */
  fitToDims?: { w: number; h: number; d: number } | null
}): ReactElement {
  const result = useMemo(() => resolveBoxResult(object), [object])
  const geometry = useMemo<BufferGeometry>(
    () => proceduralMeshToBufferGeometry(result.mesh),
    [result],
  )
  // The converter allocates GPU-backed BufferAttributes that three.js never
  // frees on its own. Dispose on unmount / when the resolved result changes.
  useEffect(() => () => geometry.dispose(), [geometry])

  const offset = pivotToCentreOffset(result.bbox)
  // Conform to the object's declared AABB: a procedural silhouette builds at
  // CATALOG dims, so fit it to the object's measured/edited AABB (feet flush, no
  // float/sink, no pop vs the GLB which fits the same way). For a generic-box
  // result (already built at those dims) the factor is ~1 → no-op. Null defensively
  // skips the wrap if a caller ever passes none.
  const fitScale = useMemo<[number, number, number] | null>(
    () => (fitToDims ? fitScaleForDims(extentOfBox(result.bbox), fitToDims) : null),
    [result, fitToDims],
  )

  // Per-category default finish for the placeholder path (procedural silhouette
  // / generic box / GLB load + error). A resolved material_id still wins inside
  // SurfaceMaterial; this only replaces the old single brown default so a
  // scanned fixture reads as its real material family. Defensive `??` keeps the
  // legacy brown if native data ever emits a category outside the union.
  const tint = CATEGORY_DEFAULT_MATERIAL[object.category] ?? {
    color: '#b6915c',
    roughness: 0.7,
    metalness: 0.05,
  }
  const mesh = (
    <mesh geometry={geometry} position={offset} castShadow receiveShadow>
      <SurfaceMaterial
        materialId={object.material_id}
        defaultColor={tint.color}
        defaultRoughness={tint.roughness}
        defaultMetalness={tint.metalness}
        isSelected={isSelected}
      />
    </mesh>
  )
  return fitScale ? <group scale={fitScale}>{mesh}</group> : mesh
}

/**
 * #1 Selektion-Highlight: Kanten-Drahtgitter + Volumen-Tint der Objekt-AABB.
 * Funktioniert für GLB UND Placeholder gleichermaßen (eingebettete GLB-Materialien
 * nehmen keinen emissive-Boost an).
 *
 * #3 Robustheit/Lesbarkeit (V1.6.1): Farbe ist jetzt Edit-Cyan `#38bdf8` statt
 * des alten Gelbs — das Gelb kollidierte mit dem RotationDial-Ring (`#ffd479`),
 * sodass in einer vollen Szene unklar war, was selektiert (Outline) und was
 * greifbar (Dial) ist. Zusätzlich füllt ein halbtransparenter Box-Tint die AABB,
 * damit auch ein GLB-Möbel klar „leuchtet". Die Kanten haben `depthTest={false}`
 * → durch das Möbel hindurch sichtbar; der Füll-Tint behält den Tiefentest
 * (`depthWrite={false}`), liest sich also als echtes Volumen statt als Overlay.
 */
const SELECTION_COLOR = '#38bdf8'

function SelectionOutline({
  width,
  height,
  depth,
}: {
  width: number
  height: number
  depth: number
}): ReactElement {
  const { edges, box } = useMemo(() => {
    const b = new BoxGeometry(width, height, depth)
    return { edges: new EdgesGeometry(b), box: b }
  }, [width, height, depth])
  useEffect(
    () => () => {
      edges.dispose()
      box.dispose()
    },
    [edges, box],
  )
  return (
    <>
      <mesh geometry={box} renderOrder={1}>
        <meshBasicMaterial
          color={SELECTION_COLOR}
          transparent
          opacity={0.1}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={edges} renderOrder={2}>
        <lineBasicMaterial
          color={SELECTION_COLOR}
          transparent
          opacity={0.95}
          depthTest={false}
        />
      </lineSegments>
    </>
  )
}

/**
 * The real GLB model.
 *
 * Retains a cache reference for the model URL (via `retainGlb` inside a
 * `useMemo` — the established react-three loader pattern: the resource must be
 * acquired *before* the render-phase `readGlb` read), reads the loaded scene
 * via the Suspense resource reader (throws the in-flight promise → `<Suspense>`
 * shows the placeholder; throws an error → the `<ObjectErrorBoundary>` shows
 * the placeholder), and renders a per-instance `.clone()` so this object's
 * transform never mutates the shared template.
 */
function GltfObject({
  url,
  fitToDims,
}: {
  url: string
  /** When set (scan render-fallback), scale the model to these measured dims. */
  fitToDims: { w: number; h: number; d: number } | null
}): ReactElement {
  const renderer = useThree((s) => s.gl)

  // Retain during render — the first retainer triggers the cache
  // `acquireAsset`; concurrent retainers share the in-flight promise. Retaining
  // here (not in an effect) guarantees the Suspense record exists before the
  // `readGlb` read below. The matching release runs in the cleanup effect.
  useMemo(() => retainGlb(url, renderer), [url, renderer])
  useEffect(() => () => releaseGlb(url), [url])

  // Suspense read — throws the in-flight promise (fallback) or the load error
  // (ErrorBoundary → fallback). Returns the shared template once decoded.
  const loaded = readGlb(url)

  // Per-instance clone — shares cached geometry/materials, owns its transform.
  const model = useMemo(() => loaded.scene.clone(true), [loaded])

  // Centre-anchor: move the model's AABB centre to the local origin, matching the
  // procedural path's `pivotToCentreOffset` contract. The host group (floor/wall/
  // ceiling/counter branch in ObjectAdapter) does ALL pivot-specific positioning,
  // so BOTH render paths must hand it a centre-anchored object. (This used to
  // re-anchor the catalog `pivot` reference point — the bottom face for
  // `bottom_center` — which the floor host then lifted again by h/2, floating
  // every GLB floor object by half its height; wall objects protruded by d/2.)
  const offset = useMemo(() => glbCentreOffset(model), [model])

  // Conform to the object's declared AABB: the loaded model is the catalog-sized
  // GLB, but the object's measured/edited AABB may differ — centre-anchoring a
  // catalog-sized model at the host position (e.g. floor y = h/2) would float/sink
  // the feet by (objH − modelH)/2. Scale the centre-anchored model to the declared
  // dims so it fills the AABB and sits flush, matching the footprint / outline /
  // pick proxy and removing the load-time vertical pop. The factor is ~1 (no-op)
  // when the GLB already matches its catalog dims. Null defensively skips the wrap.
  const fitScale = useMemo<[number, number, number] | null>(() => {
    if (!fitToDims) return null
    const box = new Box3().setFromObject(model)
    if (box.isEmpty()) return null
    return fitScaleForDims(extentOfBox(box), fitToDims)
  }, [model, fitToDims])

  const primitive = <primitive object={model} position={offset} />
  return fitScale ? <group scale={fitScale}>{primitive}</group> : primitive
}

/**
 * Offset that moves a loaded GLB model's AABB centre to the local origin — the
 * same contract the procedural path satisfies via `pivotToCentreOffset`. The
 * host group then positions that centre (floor `y=h/2`, wall `z=thk/2+d/2`,
 * ceiling `y=ceilingY−h/2`, counter `y=top+h/2`).
 */
function glbCentreOffset(model: Group): [number, number, number] {
  const box = new Box3().setFromObject(model)
  if (box.isEmpty()) return [0, 0, 0]
  return [
    -((box.min.x + box.max.x) / 2),
    -((box.min.y + box.max.y) / 2),
    -((box.min.z + box.max.z) / 2),
  ]
}

export function ObjectAdapter({ object, context }: ObjectAdapterProps): ReactElement {
  // Re-anchor based on host context. The bridge stamps these contexts; the
  // adapter only finalises the position so identical SpatialObject payloads
  // render in the right place regardless of which parent group they sit in.
  const dims = object.dimensions
  const h = dims?.height_m ?? 0.4
  const d = dims?.depth_m ?? 0.4
  const w = dims?.width_m ?? 0.4

  // Conform the rendered mesh to the object's DECLARED AABB. Every consumer of
  // the dimensions — floor footprint, SelectionOutline (w/h/d), PickProxy ([w,d]),
  // wall host-x, floor host-y, contact shadow — derives from object.dimensions, so
  // the mesh must too. fitScaleForDims is ~1 (no-op) when a GLB already matches its
  // catalog dims, leaving correctly-authored unedited catalog objects untouched; an
  // edited / drifted object (handleObjectEditChange patches dimensions but keeps
  // asset_id) now scales to its new AABB instead of rendering at the stale native
  // size centred on the new origin (the offset regression). Scan-fallback objects
  // (no asset_id, category-default model) already relied on this to sit flush.
  // Memoised so the literal's identity is stable: otherwise the downstream fitScale
  // memo (incl. a Box3 scene-AABB in GltfObject) would recompute every render.
  const fitToDims = useMemo(() => ({ w, h, d }), [w, h, d])

  // #1 Selektion-Highlight: reaktiv aus dem Store; invalidate poked den
  // demand-Loop, damit der Outline-Wechsel im statischen Dollhouse sichtbar wird.
  const isSelected = useCanonicalSceneStore((s) => s.focusedObjectId === object.id)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [isSelected, invalidate])

  let x = object.transform?.position?.x ?? 0
  let y = object.transform?.position?.y ?? 0
  let z = object.transform?.position?.z ?? 0

  // Uniform scale (Phase 5 Pinch-Skalierung schreibt transform.scale). Default
  // 1 für alle bestehenden Objekte → no-op. Rotation um Y nur für floor/free
  // (Customer-Möbel via Dreh-Dial / rotation_around_y_deg).
  const sx = object.transform?.scale?.x ?? 1
  const sy = object.transform?.scale?.y ?? 1
  const sz = object.transform?.scale?.z ?? 1
  const rotationY =
    object.host === 'floor' || object.host === 'free'
      ? ((object.rotation_around_y_deg ?? 0) * Math.PI) / 180
      : 0

  if (object.host === 'floor') {
    // Scale-aware: Basis bleibt auf dem Boden (statt Zentrum bei h/2), damit
    // ein hochskaliertes Möbel nach oben wächst und nicht in den Boden sinkt.
    y = (h * sy) / 2
  } else if (object.host === 'counter') {
    // `transform.position.y` carries the counter-top height (resolveCounterSnap);
    // lift by half the object's own height so it rests ON the surface.
    y = y + h / 2
  } else if (object.host === 'ceiling' && context?.ceilingY !== undefined) {
    y = context.ceilingY - h / 2
  } else if (object.host === 'wall' && context !== undefined) {
    // Inside the wall group; surface_offset places the centre on the inner face.
    z = (context.wallThickness ?? 0.15) / 2 + d / 2 + 0.001
    // F11: derive the vertical placement from the parametric `height_from_floor_m`
    // against the LIVE wall height passed in `context`, not a stale stored
    // `transform.position.y`. The wall group is centred at `height_m / 2`, so a
    // wall-object's local-Y centre = height_from_floor_m + h/2 − wallHeight/2.
    // After a ResizeWallCommand re-anchor the resolved object carries the
    // clamped `height_from_floor_m`, so the renderer follows the shorter wall.
    if (
      object.height_from_floor_m !== undefined &&
      context.wallHeight !== undefined
    ) {
      y = object.height_from_floor_m + h / 2 - context.wallHeight / 2
    }
    // V1.6.1 fix: derive the HORIZONTAL placement from the parametric
    // `offset_along_wall_m` (left edge) against the LIVE wall length — mirror of
    // OpeningAdapter's `centerX`. The wall group is centred at the wall midpoint
    // with local +X along the centerline. Without this, a wall-mounted object
    // (heating/electrical) renders pinned at the wall centre regardless of
    // tap-X placement or drag, because the builder stamps `transform.position.x`
    // = 0 and only `offset_along_wall_m` carries the real horizontal pose.
    if (
      object.offset_along_wall_m !== undefined &&
      context.wallLength !== undefined
    ) {
      x = -context.wallLength / 2 + object.offset_along_wall_m + w / 2
    }
  }

  // Decide the render branch: a GLB catalog asset with a resolvable URL takes
  // the real-model path; everything else renders the placeholder directly.
  const glbUrl = useMemo(() => {
    // Same scan render-fallback as resolveBoxResult: a category default slug
    // when the object carries no asset_id. A GLB-kind default resolves a URL
    // here (real model); a procedural-kind default returns null below →
    // PlaceholderMesh builds the procedural silhouette via resolveBoxResult.
    const slug = object.asset_id ?? categoryToDefaultAsset(object.category) ?? undefined
    if (!slug) return null
    const catalogAsset = getCatalogAsset(slug)
    if (!catalogAsset || catalogAsset.geometryKind !== 'glb') return null
    return resolveGlbUrl(catalogAsset)
  }, [object.asset_id, object.category])

  return (
    <group
      position={[x, y, z]}
      rotation={[0, rotationY, 0]}
      scale={[sx, sy, sz]}
      name={`object-${object.id}`}
    >
      {/* Cluster B: R14-style pick proxy — eine horizontale Footprint-Plane, die
          IMMER da ist (überlebt Suspense + ErrorBoundary-Fallback). Die alte
          group-ref enableSubtreePick feuerte BEVOR das GLB-<primitive> mountete,
          → cold-cache-Modelle landeten nie auf PICK_LAYER und waren un-tappbar.
          Der Proxy markiert sich selbst via eigenen Effect → ein eindeutiger
          Objekt-Hit, unabhängig vom Lade-Timing. */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <PickProxy size={[w, d]} />
      </group>
      {isSelected && <SelectionOutline width={w} height={h} depth={d} />}
      {glbUrl ? (
        <ObjectErrorBoundary
          objectId={object.id}
          fallback={<PlaceholderMesh object={object} isSelected={isSelected} fitToDims={fitToDims} />}
        >
          <Suspense fallback={<PlaceholderMesh object={object} isSelected={isSelected} fitToDims={fitToDims} />}>
            <GltfObject url={glbUrl} fitToDims={fitToDims} />
          </Suspense>
        </ObjectErrorBoundary>
      ) : (
        <PlaceholderMesh object={object} isSelected={isSelected} fitToDims={fitToDims} />
      )}
    </group>
  )
}
