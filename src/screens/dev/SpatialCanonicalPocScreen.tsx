/**
 * Dev-only POC screen — `/dev/spatial-poc`
 *
 * A verification surface (NOT production logic) for the Phase-1.5 canonical
 * renderer. Gated behind `import.meta.env.DEV` — never reachable in a
 * production build (see `App.tsx` route guard).
 *
 * Block R6 promotes the screen from a synthetic 4-wall box to a full
 * verification scene that exercises every Phase-1.5 renderer path at once:
 *
 *   - R2  procedural assets — sanitary / kitchen catalog slugs render as the
 *         L1 box-placeholder geometry,
 *   - R4  GLB furniture — `furn-sofa-3seater-fabric-grey`,
 *         `furn-armchair-fabric-rounded`, `furn-coffee-table-round-wood` load
 *         the real Polyhaven CC0 models (generic-box fallback while loading /
 *         on a missing file),
 *   - R5  PBR materials — wall / floor / ceiling carry catalog `material_id`
 *         overrides resolved through `<SurfaceMaterial>`,
 *   - lighting — a real `LightingPreset` drives the three-point rig,
 *   - IBL — `presetHdriEnabled` mounts `<Environment>` behind the new
 *         `<EnvironmentErrorBoundary>`,
 *   - post-FX — `<PostProcessing>` runs the N8AO + Bloom + SMAA chain.
 *
 * A small dev panel toggles the wall material and the lighting preset live so
 * a reviewer can eyeball the material + lighting pipelines without a rebuild.
 */

import { useMemo, useState, type ReactElement } from 'react'

import { CanonicalSceneRoot } from '../../components/spatial/three/canonical/CanonicalSceneRoot'
import { PostProcessing } from '../../components/spatial/three/canonical/postfx/PostProcessing'
import type { Wall, Floor, Ceiling, WallOpening } from '../../lib/spatial/canonical/types/geometry'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { SpatialObject, ObjectCategory, ObjectHost } from '../../lib/spatial/canonical/types/objects'
import type { Pin } from '../../lib/spatial/canonical/types/annotations'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../lib/spatial/canonical/types/primitives'
import {
  LIGHTING_PRESETS,
  type LightingPreset,
} from '../../lib/spatial/canonical/lighting/presets'

// ── Dev-panel option sets ─────────────────────────────────────────────────

/** Wall material override choices (catalog `spatial_materials` slugs). */
const WALL_MATERIAL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'wall-tile-white', label: 'Fliese Weiß' },
  { id: 'wall-plaster-creme', label: 'Putz Creme' },
  { id: 'wall-marble', label: 'Marmor' },
  { id: 'wall-concrete', label: 'Sichtbeton' },
  { id: 'wall-oak', label: 'Eiche' },
]

/** Floor material override (fixed — the dev panel only toggles walls + light). */
const FLOOR_MATERIAL_ID = 'floor-marble'
/** Ceiling material override (fixed). */
const CEILING_MATERIAL_ID = 'wall-paint-white'

const DEFAULT_WALL_MATERIAL_ID = WALL_MATERIAL_OPTIONS[0]!.id
const DEFAULT_PRESET_ID = 'modern-bath'

export default function SpatialCanonicalPocScreen(): ReactElement {
  const [wallMaterialId, setWallMaterialId] = useState<string>(DEFAULT_WALL_MATERIAL_ID)
  const [presetId, setPresetId] = useState<string>(DEFAULT_PRESET_ID)

  // The scene is rebuilt whenever the wall material changes so the override
  // re-resolves through <SurfaceMaterial>. Object/floor/ceiling materials are
  // stable across re-renders.
  const scene = useMemo(() => buildPocVerificationScene(wallMaterialId), [wallMaterialId])

  const objectCount = countObjects(scene)

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#1a1a1d',
        color: '#fafafa',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
      }}
    >
      <header
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #2a2a2e',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
        }}
      >
        <strong>Spatial Canonical · POC verification scene (R6)</strong>
        <span style={{ opacity: 0.6 }}>
          walls={scene.walls.length} · objects={objectCount} · pins={scene.pins.length} ·
          area_m²={scene.computed_area_m2.toFixed(2)}
        </span>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ opacity: 0.7 }}>Wand-Material</span>
          <select
            value={wallMaterialId}
            onChange={(e) => setWallMaterialId(e.target.value)}
            style={selectStyle}
          >
            {WALL_MATERIAL_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ opacity: 0.7 }}>Lichtquelle</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} style={selectStyle}>
            {LIGHTING_PRESETS.map((p: LightingPreset) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
      </header>

      <CanonicalSceneRoot
        scene={scene}
        variants={[{ id: 'base_roomplan', display_name: 'Scan', is_default: true }]}
        activeVariantId={'base_roomplan'}
        lightingPresetId={presetId}
        presetHdriEnabled
        debug
        className="spatial-canonical-poc-root"
      >
        {/*
          Post-FX runs inside the <Canvas> so the N8AO + Bloom + SMAA chain
          is exercised on the verification scene. Children of
          <CanonicalSceneRoot> mount inside the canonical lighting/post-fx
          stack — see the `children` prop contract.
        */}
        <PostProcessing />
      </CanonicalSceneRoot>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  background: '#27272b',
  color: '#fafafa',
  border: '1px solid #3a3a3e',
  borderRadius: 6,
  padding: '3px 6px',
  fontSize: 12,
}

function countObjects(scene: RoomScene): number {
  let n = scene.free_objects.length + scene.floor.floor_mounted.length + scene.ceiling.ceiling_mounted.length
  for (const w of scene.walls) n += w.wall_mounted.length
  return n
}

// ── Synthetic POC fixture (4 × 5 m bathroom · door + window + objects) ─────

const NOW = '2026-05-20T00:00:00.000Z'
const ROOM_ID = 'poc-room'
const WALL_HEIGHT = 2.5
const WALL_THICKNESS = 0.15

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkWall(
  id: string,
  start: { x: number; z: number },
  end: { x: number; z: number },
  opts: { materialId?: string; openings?: WallOpening[] } = {},
): Wall {
  return {
    ...baseNode(id, 'wall', ROOM_ID),
    start_point: { x: start.x, y: 0, z: start.z },
    end_point: { x: end.x, y: 0, z: end.z },
    height_m: WALL_HEIGHT,
    thickness_m: WALL_THICKNESS,
    base_height_m: 0,
    openings: opts.openings ?? [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    material_id: opts.materialId,
    length_m: Math.hypot(end.x - start.x, end.z - start.z),
    normal: { x: 0, y: 0, z: 0 },
  }
}

function mkOpening(
  id: string,
  hostWallId: string,
  type: WallOpening['type'],
  offsetAlong: number,
  width: number,
  height: number,
  offsetFromFloor: number,
): WallOpening {
  return {
    ...baseNode(id, type, hostWallId),
    host_wall_id: hostWallId,
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: offsetFromFloor,
    width_m: width,
    height_m: height,
    is_walkable_portal: type === 'door',
  }
}

function mkObject(args: {
  id: string
  category: ObjectCategory
  host: ObjectHost
  position: { x: number; y: number; z: number }
  dimensions: { width_m: number; depth_m: number; height_m: number }
  assetId?: string
  materialId?: string
}): SpatialObject {
  return {
    ...baseNode(args.id, 'object', ROOM_ID),
    category: args.category,
    asset_id: args.assetId,
    material_id: args.materialId,
    dimensions: args.dimensions,
    host: args.host,
    host_id: args.host === 'floor' ? 'poc-floor' : ROOM_ID,
  }
}

function mkPin(id: string, surfaceId: string, u: number, v: number, pinType: Pin['pin_type']): Pin {
  return {
    ...baseNode(id, 'pin', ROOM_ID),
    pin_type: pinType,
    anchor_surface_id: surfaceId,
    anchor_surface_type: 'wall',
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
}

/**
 * Build the R6 verification scene — a 4 × 5 m bathroom that exercises every
 * Phase-1.5 renderer path. The `wallMaterialId` is the live dev-panel choice.
 */
function buildPocVerificationScene(wallMaterialId: string): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 5 },
    { x: 0, y: 0, z: 5 },
  ]

  // Door on the south wall, window on the east wall.
  const door = mkOpening('opening-door', 'w_s', 'door', 1.2, 0.9, 2.05, 0)
  const window = mkOpening('opening-window', 'w_e', 'window', 1.8, 1.2, 1.1, 0.95)

  const walls: Wall[] = [
    mkWall('w_s', { x: 0, z: 0 }, { x: 4, z: 0 }, {
      materialId: wallMaterialId,
      openings: [door],
    }),
    mkWall('w_e', { x: 4, z: 0 }, { x: 4, z: 5 }, {
      materialId: wallMaterialId,
      openings: [window],
    }),
    mkWall('w_n', { x: 4, z: 5 }, { x: 0, z: 5 }, { materialId: wallMaterialId }),
    mkWall('w_w', { x: 0, z: 5 }, { x: 0, z: 0 }, { materialId: wallMaterialId }),
  ]

  const floor: Floor = {
    ...baseNode('poc-floor', 'floor', ROOM_ID),
    polygon: ring,
    material_id: FLOOR_MATERIAL_ID,
    walkable_surface: true as const,
    floor_mounted: [],
  }

  const ceiling: Ceiling = {
    ...baseNode('poc-ceiling', 'ceiling', ROOM_ID),
    polygon: ring,
    height_m: WALL_HEIGHT,
    material_id: CEILING_MATERIAL_ID,
    ceiling_mounted: [],
  }

  // free_objects: procedural sanitary/kitchen (R2) + GLB furniture (R4).
  // GLB furniture carries no material_id — embedded Polyhaven materials win
  // (ObjectAdapter ignores material_id on GLB assets by design).
  const free_objects: SpatialObject[] = [
    // ── Procedural assets (R2) — box-placeholder geometry + PBR override ──
    mkObject({
      id: 'obj-toilet',
      category: 'toilet',
      host: 'floor',
      position: { x: 0.6, y: 0, z: 0.6 },
      dimensions: { width_m: 0.4, depth_m: 0.7, height_m: 0.8 },
      assetId: 'sanitary-toilet-standard-floor',
      materialId: 'decor-ceramic-white',
    }),
    mkObject({
      id: 'obj-bathtub',
      category: 'bathtub',
      host: 'floor',
      position: { x: 2.0, y: 0, z: 4.0 },
      dimensions: { width_m: 1.7, depth_m: 0.8, height_m: 0.6 },
      assetId: 'sanitary-bathtub-freestanding-oval',
      materialId: 'decor-ceramic-white',
    }),
    mkObject({
      id: 'obj-sink',
      category: 'sink',
      host: 'floor',
      position: { x: 3.4, y: 0, z: 0.7 },
      dimensions: { width_m: 0.6, depth_m: 0.5, height_m: 0.9 },
      assetId: 'sanitary-sink-vanity-rectangle',
      materialId: 'counter-marble-beige',
    }),
    // ── GLB furniture (R4) — real Polyhaven CC0 models ───────────────────
    mkObject({
      id: 'obj-sofa',
      category: 'sofa',
      host: 'floor',
      position: { x: 1.4, y: 0, z: 2.4 },
      dimensions: { width_m: 2.1, depth_m: 0.92, height_m: 0.85 },
      assetId: 'furn-sofa-3seater-fabric-grey',
    }),
    mkObject({
      id: 'obj-armchair',
      category: 'armchair',
      host: 'floor',
      position: { x: 3.2, y: 0, z: 2.6 },
      dimensions: { width_m: 0.85, depth_m: 0.85, height_m: 0.95 },
      assetId: 'furn-armchair-fabric-rounded',
    }),
    mkObject({
      id: 'obj-coffee-table',
      category: 'table',
      host: 'floor',
      position: { x: 1.7, y: 0, z: 1.6 },
      dimensions: { width_m: 0.9, depth_m: 0.9, height_m: 0.42 },
      assetId: 'furn-coffee-table-round-wood',
    }),
  ]

  const pins: Pin[] = [
    mkPin('pin-1', 'w_s', 0.3, 0.6, 'damage'),
    mkPin('pin-2', 'w_n', 0.7, 0.4, 'note'),
    mkPin('pin-3', 'w_e', 0.5, 0.5, 'task'),
  ]

  return {
    ...baseNode(ROOM_ID, 'room', 'poc-building'),
    category: 'bathroom',
    walls,
    floor,
    ceiling,
    free_objects,
    pins,
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: WALL_HEIGHT, z: 5 },
    computed_area_m2: 20,
    computed_volume_m3: 50,
  }
}
