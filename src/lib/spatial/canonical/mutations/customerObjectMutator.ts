/**
 * Spatial · Canonical · Mutations · Customer-Object-Mutator (V1.6.1 R13)
 *
 * Pure helper functions die einen `RoomScene` als Input nehmen und einen
 * NEUEN RoomScene mit der gewünschten Mutation zurückgeben (immutable,
 * shallow-copy). Für Customer-Tür/Fenster/Heizung/Steckdose-Edits, die
 * direkt am base-scene-Layer landen (Override-Engine kann keine neuen Nodes
 * adden — siehe AddDoorCommand-Header).
 *
 * Caller (Hub-Screen) ruft den Mutator → setScene → persistCustomerSceneMutation
 * für Blob-Re-Upload.
 *
 * Keine editHistoryStore-Integration in V1.6.1 weil die Variant-RBAC
 * (`assertCanWriteVariant`) für Customer + Add-Door noch nicht wired ist.
 * Phase 2 ersetzt das durch AddDoorCommand + Variant-Override-Resolver.
 */

import type { RoomScene } from '../types/scene-graph'
import type { Wall, WallOpening, Ceiling } from '../types/geometry'
import type { SpatialObject, ObjectCategory } from '../types/objects'

/** Slot eines Surface-mounted-Objects gemäß DIN-Standards (V1.6.1 Phase 1). */
export interface CustomerObjectAddInput {
  wallId: string
  /** Pre-built WallOpening (für Türen/Fenster). Optional. */
  opening?: WallOpening
}

export interface CustomerObjectUpdateInput {
  wallId: string
  openingId: string
  patch: Partial<Pick<WallOpening, 'offset_along_wall_m' | 'offset_from_floor_m' | 'width_m' | 'height_m'>>
}

export interface CustomerObjectDeleteInput {
  wallId: string
  openingId: string
}

function mapWalls(scene: RoomScene, wallId: string, fn: (wall: Wall) => Wall): RoomScene {
  let touched = false
  const walls = scene.walls.map((w): Wall => {
    if (w.id !== wallId) return w
    touched = true
    return fn(w)
  })
  if (!touched) return scene
  return { ...scene, walls }
}

/**
 * Set (or clear) a wall's surface material/finish slug (`Wall.material_id`).
 * `materialId: null` resets the wall to the room default. Idempotent on the
 * current value; preserves every other wall field. The slug rides the
 * persistence blob generically (no encoder change) and `WallAdapter` already
 * reads `material_id` to paint the wall, so the change previews live.
 */
export function setWallMaterial(
  scene: RoomScene,
  input: { wallId: string; materialId: string | null },
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    if ((wall.material_id ?? null) === input.materialId) return wall
    return { ...wall, material_id: input.materialId ?? undefined }
  })
}

/**
 * Add a new WallOpening to a wall's `openings` array. Idempotent on id —
 * re-adding the same id is a no-op (the caller can re-run an add safely
 * after a UI race).
 */
export function addOpeningToWall(
  scene: RoomScene,
  input: CustomerObjectAddInput,
): RoomScene {
  if (!input.opening) return scene
  const opening = input.opening
  return mapWalls(scene, input.wallId, (wall) => {
    if (wall.openings.some((o) => o.id === opening.id)) return wall
    return { ...wall, openings: [...wall.openings, opening] }
  })
}

/**
 * Patch a WallOpening's parametric fields. Idempotent — wenn die Opening
 * nicht gefunden wird, wird die Scene unverändert zurückgegeben.
 *
 * Bounds-Validation: clamping passiert bei dem UI-Caller (CustomerObjectEditSheet)
 * — dieser Mutator ist eine reine Setter-Helper.
 */
export function updateOpeningInWall(
  scene: RoomScene,
  input: CustomerObjectUpdateInput,
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    let touched = false
    const openings = wall.openings.map((o): WallOpening => {
      if (o.id !== input.openingId) return o
      touched = true
      return { ...o, ...input.patch }
    })
    if (!touched) return wall
    return { ...wall, openings }
  })
}

/** Remove a WallOpening from a wall's `openings` array. */
export function removeOpeningFromWall(
  scene: RoomScene,
  input: CustomerObjectDeleteInput,
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    const openings = wall.openings.filter((o) => o.id !== input.openingId)
    if (openings.length === wall.openings.length) return wall
    return { ...wall, openings }
  })
}

/**
 * Build a default WallOpening for a given tool-type at the wall's mid-point
 * (or at `tapOffsetAlongWallM` if the caller supplies the tap-X from a
 * world-space raycast hit, V1.6.1 L0.1). Defaults gemäß DIN-Standards
 * (siehe CustomerObjectEditSheet).
 */
export function buildDefaultOpening(input: {
  id: string
  wallId: string
  wallLengthM: number
  wallHeightM: number
  type: 'door' | 'window'
  variantId: string
  generatedAt: string
  /**
   * Optional tap-X projected onto the wall axis (from `worldPointToWallLocalOffset`).
   * When omitted, the opening is centered on the wall. The clamp keeps the
   * object's left+right edges inside the wall bounds.
   */
  tapOffsetAlongWallM?: number
}): WallOpening {
  const defaults: Record<typeof input.type, {
    widthM: number
    heightM: number
    offsetFromFloorM: number
  }> = {
    door: { widthM: 0.86, heightM: 1.985, offsetFromFloorM: 0 },
    window: { widthM: 1.0, heightM: 1.25, offsetFromFloorM: 0.9 },
  }
  const d = defaults[input.type]
  // Clamp width to wall length (kleine Wände bekommen verkleinerte Default-Tür).
  const widthM = Math.min(d.widthM, Math.max(0.5, input.wallLengthM - 0.1))
  const heightM = Math.min(d.heightM, Math.max(1.5, input.wallHeightM - d.offsetFromFloorM))
  const offsetFromFloorM = Math.min(d.offsetFromFloorM, Math.max(0, input.wallHeightM - heightM))
  const offsetAlongWallM =
    input.tapOffsetAlongWallM != null
      ? // tap point is the desired CENTER → convert to left-edge offset, clamp
        clampLeftEdge(input.tapOffsetAlongWallM - widthM / 2, widthM, input.wallLengthM)
      : Math.max(0, input.wallLengthM / 2 - widthM / 2)
  return {
    id: input.id,
    type: input.type,
    parent_id: input.wallId,
    children_ids: [],
    host_wall_id: input.wallId,
    offset_along_wall_m: offsetAlongWallM,
    offset_from_floor_m: offsetFromFloorM,
    width_m: widthM,
    height_m: heightM,
    is_walkable_portal: input.type === 'door',
    swing_direction: input.type === 'door' ? 'unknown' : undefined,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase L0.3 · Wall-Mounted SpatialObject Mutators + Default-Builder
// ─────────────────────────────────────────────────────────────────────────────

/** Wall-mounted tool kind from the customer / craftsman tool-bar (Phase L0). */
export type CustomerWallMountedKind =
  | 'heating'
  | 'electrical_outlet'
  | 'electrical_switch'
  | 'fuse_box'

export interface CustomerWallMountedAddInput {
  wallId: string
  object: SpatialObject
}

export interface CustomerWallMountedUpdateInput {
  wallId: string
  objectId: string
  patch: Partial<Pick<
    SpatialObject,
    'offset_along_wall_m' | 'height_from_floor_m' | 'depth_from_wall_m' | 'dimensions'
  >>
}

export interface CustomerWallMountedDeleteInput {
  wallId: string
  objectId: string
}

/**
 * Add a wall-mounted SpatialObject to a wall's `wall_mounted` array.
 * Idempotent on id — re-adding the same id is a no-op.
 */
export function addWallMountedObjectToWall(
  scene: RoomScene,
  input: CustomerWallMountedAddInput,
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    if (wall.wall_mounted.some((o) => o.id === input.object.id)) return wall
    return { ...wall, wall_mounted: [...wall.wall_mounted, input.object] }
  })
}

/** Patch a wall-mounted SpatialObject's parametric fields. */
export function updateWallMountedObjectInWall(
  scene: RoomScene,
  input: CustomerWallMountedUpdateInput,
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    let touched = false
    const wall_mounted = wall.wall_mounted.map((o): SpatialObject => {
      if (o.id !== input.objectId) return o
      touched = true
      return { ...o, ...input.patch }
    })
    if (!touched) return wall
    return { ...wall, wall_mounted }
  })
}

/** Remove a wall-mounted SpatialObject from a wall's `wall_mounted` array. */
export function removeWallMountedObjectFromWall(
  scene: RoomScene,
  input: CustomerWallMountedDeleteInput,
): RoomScene {
  return mapWalls(scene, input.wallId, (wall) => {
    const wall_mounted = wall.wall_mounted.filter((o) => o.id !== input.objectId)
    if (wall_mounted.length === wall.wall_mounted.length) return wall
    return { ...wall, wall_mounted }
  })
}

/**
 * Build a default wall-mounted SpatialObject for a given tool-kind at the
 * tap-X position (or centered if no tap-X). Defaults gemäß DIN-Standards
 * (Phase L0 spec, V1.6.1 positioning roadmap §L0.3-L0.5):
 *
 *   - heating          (radiator):           60×100×8cm, 15cm Boden — DIN EN 442 + VDI 6036
 *   - electrical_outlet (Schuko DIN 49441):   8×8×2.2cm, 30cm Boden — DIN 18015-2
 *   - electrical_switch (Wippschalter 55):    8×8×2.2cm, 105cm Boden — DIN 18015-2
 *   - fuse_box         (Verteiler/UV):        30×40×11cm, 140cm Boden (Unterkante) — DIN 18015-2
 */
export function buildDefaultWallMountedObject(input: {
  id: string
  wallId: string
  wallLengthM: number
  wallHeightM: number
  kind: CustomerWallMountedKind
  variantId: string
  generatedAt: string
  tapOffsetAlongWallM?: number
  /** Optional tap-Y projected onto the wall axis (Plan §L0.1). When omitted, the DIN-standard height is used. */
  tapOffsetFromFloorM?: number
}): SpatialObject {
  const defaults: Record<
    CustomerWallMountedKind,
    {
      widthM: number
      heightM: number
      depthM: number
      offsetFromFloorM: number
      category: ObjectCategory
      assetId: string
    }
  > = {
    heating: {
      widthM: 1.0,
      heightM: 0.6,
      depthM: 0.08,
      offsetFromFloorM: 0.15,
      category: 'radiator',
      assetId: 'arch-radiator-panel-typ22',
    },
    electrical_outlet: {
      widthM: 0.08,
      heightM: 0.08,
      depthM: 0.022,
      offsetFromFloorM: 0.30,
      category: 'electrical_outlet',
      assetId: 'arch-outlet-schuko-de',
    },
    electrical_switch: {
      widthM: 0.08,
      heightM: 0.08,
      depthM: 0.022,
      offsetFromFloorM: 1.05,
      category: 'light_switch',
      assetId: 'arch-switch-rocker-55',
    },
    fuse_box: {
      widthM: 0.3,
      heightM: 0.4,
      depthM: 0.11,
      offsetFromFloorM: 1.4,
      category: 'fuse_box',
      assetId: 'arch-fusebox-de',
    },
  }
  const d = defaults[input.kind]
  // Clamp width to wall length (degenerate-wall guard).
  const widthM = Math.min(d.widthM, Math.max(0.05, input.wallLengthM - 0.05))
  const heightM = Math.min(d.heightM, Math.max(0.05, input.wallHeightM - d.offsetFromFloorM))
  const offsetFromFloorM =
    input.tapOffsetFromFloorM != null
      ? // tap-Y is the desired CENTER-Y → convert to bottom edge, clamp
        Math.max(
          0,
          Math.min(
            input.wallHeightM - heightM,
            input.tapOffsetFromFloorM - heightM / 2,
          ),
        )
      : Math.min(d.offsetFromFloorM, Math.max(0, input.wallHeightM - heightM))
  const offsetAlongWallM =
    input.tapOffsetAlongWallM != null
      ? clampLeftEdge(input.tapOffsetAlongWallM - widthM / 2, widthM, input.wallLengthM)
      : Math.max(0, input.wallLengthM / 2 - widthM / 2)
  return {
    id: input.id,
    type: 'object',
    parent_id: input.wallId,
    children_ids: [],
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    category: d.category,
    asset_id: d.assetId,
    dimensions: {
      width_m: widthM,
      depth_m: d.depthM,
      height_m: heightM,
    },
    host: 'wall',
    host_id: input.wallId,
    offset_along_wall_m: offsetAlongWallM,
    height_from_floor_m: offsetFromFloorM,
    depth_from_wall_m: d.depthM,
  }
}

function clampLeftEdge(desiredLeftEdge: number, objectWidthM: number, wallLengthM: number): number {
  const min = 0
  const max = Math.max(0, wallLengthM - objectWidthM)
  return Math.max(min, Math.min(max, desiredLeftEdge))
}

/**
 * Sinnvolle Default-CENTER-Höhe (m über Boden) je wand-gehostete Kategorie, für
 * den asset-getriebenen Wand-Build (`buildWallMountedObjectFromAsset`). Ein
 * Tap-Y überschreibt das; ohne Tap-Y landet das Objekt auf dieser Norm-/Ergonomie-
 * Höhe statt willkürlich auf halber Wand. Elektro/Heizung spiegeln die DIN-Werte
 * aus `buildDefaultWallMountedObject` (Bottom→Center umgerechnet).
 */
const WALL_MOUNT_DEFAULT_CENTER_HEIGHT_M: Partial<Record<ObjectCategory, number>> = {
  mirror: 1.55,
  lamp: 1.7,
  bookshelf: 1.3,
  cabinet: 1.4,
  towel_rail: 1.2,
  toilet_paper_holder: 0.7,
  sink: 0.9,
  kitchen_sink: 0.9,
  kitchen_faucet: 1.1,
  range_hood: 1.55,
  oven: 0.9,
  radiator: 0.45,
  electrical_outlet: 0.3,
  light_switch: 1.05,
}
const WALL_MOUNT_FALLBACK_CENTER_HEIGHT_M = 1.3
/** Kategorien, die von der Wand-Oberkante (Decke) herabhängen statt zentriert. */
const WALL_MOUNT_TOP_ALIGNED: ReadonlySet<ObjectCategory> = new Set(['curtains'])

/**
 * Build a wall-mounted SpatialObject from an arbitrary catalog asset (Spiegel,
 * Wandleuchte, Regal, Vorhang, …) — die host-aware Verallgemeinerung von
 * `buildDefaultWallMountedObject` (das auf die 3 Tool-Kinds heating/electrical
 * hartcodiert ist). dims/category/assetId kommen aus dem CatalogAsset; die
 * Vertikal-Höhe aus dem Tap-Y (CENTER) oder der Kategorie-Default-Höhe.
 */
export function buildWallMountedObjectFromAsset(input: {
  id: string
  wallId: string
  wallLengthM: number
  wallHeightM: number
  category: ObjectCategory
  assetId: string
  dimensions: { width_m: number; depth_m: number; height_m: number }
  variantId: string
  generatedAt: string
  tapOffsetAlongWallM?: number
  /** Tap-Y projiziert auf die Wand-Achse (CENTER-Y). Ohne → Kategorie-Default. */
  tapOffsetFromFloorM?: number
}): SpatialObject {
  const widthM = Math.min(input.dimensions.width_m, Math.max(0.05, input.wallLengthM - 0.05))
  const depthM = Math.max(0.02, input.dimensions.depth_m)
  const heightM = Math.min(input.dimensions.height_m, Math.max(0.05, input.wallHeightM))
  const defaultCenterM =
    WALL_MOUNT_DEFAULT_CENTER_HEIGHT_M[input.category] ?? WALL_MOUNT_FALLBACK_CENTER_HEIGHT_M
  // Bottom-Edge bestimmen: top-aligned (Vorhang) hängt von der Decke; sonst aus
  // Tap-Center-Y bzw. Default-Center-Y, geclampt in [0, wallHeight − height].
  const maxBottom = Math.max(0, input.wallHeightM - heightM)
  const rawBottom = WALL_MOUNT_TOP_ALIGNED.has(input.category)
    ? maxBottom
    : (input.tapOffsetFromFloorM ?? defaultCenterM) - heightM / 2
  const offsetFromFloorM = Math.max(0, Math.min(maxBottom, rawBottom))
  const offsetAlongWallM =
    input.tapOffsetAlongWallM != null
      ? clampLeftEdge(input.tapOffsetAlongWallM - widthM / 2, widthM, input.wallLengthM)
      : Math.max(0, input.wallLengthM / 2 - widthM / 2)
  return {
    id: input.id,
    type: 'object',
    parent_id: input.wallId,
    children_ids: [],
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    category: input.category,
    asset_id: input.assetId,
    dimensions: { width_m: widthM, depth_m: depthM, height_m: heightM },
    host: 'wall',
    host_id: input.wallId,
    offset_along_wall_m: offsetAlongWallM,
    height_from_floor_m: offsetFromFloorM,
    depth_from_wall_m: depthM,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 · Floor-mounted (free-standing furniture) Mutators + Default-Builder
//
// Möbel aus dem Asset-Katalog landen in `scene.floor.floor_mounted` mit
// `host='floor'` — gerendert von FloorAdapter via ObjectAdapter, kollektiert von
// object-rules/validate-component-move/walkable. X/Z stehen in
// `transform.position` (Floor-Adapter-Gruppe sitzt im Ursprung), Y leitet der
// Renderer aus `height_m/2` ab. Drehung über `rotation_around_y_deg`.
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomerFloorObjectAddInput {
  floorId: string
  object: SpatialObject
}

export interface CustomerFloorObjectUpdateInput {
  floorId: string
  objectId: string
  patch: Partial<Pick<SpatialObject, 'transform' | 'dimensions' | 'rotation_around_y_deg'>>
}

export interface CustomerFloorObjectDeleteInput {
  floorId: string
  objectId: string
}

/**
 * Add a floor-mounted SpatialObject to `scene.floor.floor_mounted`. Idempotent
 * on id — re-adding the same id is a no-op (safe after a UI race / double-tap).
 */
export function addFloorObjectToFloor(
  scene: RoomScene,
  input: CustomerFloorObjectAddInput,
): RoomScene {
  if (scene.floor.id !== input.floorId) return scene
  if (scene.floor.floor_mounted.some((o) => o.id === input.object.id)) return scene
  return {
    ...scene,
    floor: { ...scene.floor, floor_mounted: [...scene.floor.floor_mounted, input.object] },
  }
}

/**
 * Patch a floor-mounted SpatialObject's transform / dimensions / rotation.
 * Idempotent — wenn das Objekt nicht gefunden wird, bleibt die Scene unverändert.
 * Bounds-Clamping macht der UI-Caller (Drag-Layer / Edit-Aktionen).
 */
export function updateFloorObjectInFloor(
  scene: RoomScene,
  input: CustomerFloorObjectUpdateInput,
): RoomScene {
  if (scene.floor.id !== input.floorId) return scene
  let touched = false
  const floor_mounted = scene.floor.floor_mounted.map((o): SpatialObject => {
    if (o.id !== input.objectId) return o
    touched = true
    return { ...o, ...input.patch }
  })
  if (!touched) return scene
  return { ...scene, floor: { ...scene.floor, floor_mounted } }
}

/** Remove a floor-mounted SpatialObject from `scene.floor.floor_mounted`. */
export function removeFloorObjectFromFloor(
  scene: RoomScene,
  input: CustomerFloorObjectDeleteInput,
): RoomScene {
  if (scene.floor.id !== input.floorId) return scene
  const floor_mounted = scene.floor.floor_mounted.filter((o) => o.id !== input.objectId)
  if (floor_mounted.length === scene.floor.floor_mounted.length) return scene
  return { ...scene, floor: { ...scene.floor, floor_mounted } }
}

/**
 * Build a default floor-mounted SpatialObject for a catalog furniture asset at
 * the tap-XZ position (or at the floor origin when no tap point is supplied).
 *
 * Category / assetId / dimensions are passed in by the caller (Hub-Screen
 * resolves the CatalogAsset) so this domain helper stays decoupled from the
 * catalog layer — same split as `buildDefaultWallMountedObject`.
 */
export function buildDefaultFloorObject(input: {
  id: string
  floorId: string
  category: ObjectCategory
  assetId: string
  dimensions: { width_m: number; depth_m: number; height_m: number }
  variantId: string
  generatedAt: string
  /** Tap-X projected onto the floor plane (world-space). Floor origin when omitted. */
  tapX?: number
  /** Tap-Z projected onto the floor plane (world-space). Floor origin when omitted. */
  tapZ?: number
}): SpatialObject {
  return {
    id: input.id,
    type: 'object',
    parent_id: input.floorId,
    children_ids: [],
    transform: {
      position: { x: input.tapX ?? 0, y: 0, z: input.tapZ ?? 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    category: input.category,
    asset_id: input.assetId,
    dimensions: { ...input.dimensions },
    host: 'floor',
    host_id: input.floorId,
    rotation_around_y_deg: 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ceiling-mounted (Deckenleuchte / Kronleuchter / Pendel) Mutators + Builder
//
// Decken-Objekte liegen in `scene.ceiling.ceiling_mounted` mit `host='ceiling'`.
// X/Z stehen in `transform.position` (CeilingAdapter-Gruppe sitzt im Ursprung),
// die Y-Höhe leitet der Renderer aus `ceilingY − h/2` ab (Objekt hängt an der
// Decke). Platziert wird über einen Boden-Tap: der Tap-Punkt darunter gibt X/Z,
// die Lampe mountet an der Decke direkt darüber (robust ggü. Decken-Pickbarkeit
// im Dollhouse-Cutaway).
// ─────────────────────────────────────────────────────────────────────────────

/** Add a ceiling-mounted SpatialObject to `scene.ceiling.ceiling_mounted`. Idempotent. */
export function addCeilingMountedObject(
  scene: RoomScene,
  input: { object: SpatialObject },
): RoomScene {
  if (scene.ceiling.ceiling_mounted.some((o) => o.id === input.object.id)) return scene
  return {
    ...scene,
    ceiling: {
      ...scene.ceiling,
      ceiling_mounted: [...scene.ceiling.ceiling_mounted, input.object],
    },
  }
}

/** Patch a ceiling-mounted SpatialObject in place. */
export function updateCeilingMountedObject(
  scene: RoomScene,
  input: { objectId: string; patch: Partial<SpatialObject> },
): RoomScene {
  const ceiling_mounted = scene.ceiling.ceiling_mounted.map((o): SpatialObject => {
    if (o.id !== input.objectId) return o
    return { ...o, ...input.patch }
  })
  return { ...scene, ceiling: { ...scene.ceiling, ceiling_mounted } }
}

/** Remove a ceiling-mounted SpatialObject from `scene.ceiling.ceiling_mounted`. */
export function removeCeilingMountedObject(
  scene: RoomScene,
  input: { objectId: string },
): RoomScene {
  const ceiling_mounted = scene.ceiling.ceiling_mounted.filter((o) => o.id !== input.objectId)
  if (ceiling_mounted.length === scene.ceiling.ceiling_mounted.length) return scene
  return { ...scene, ceiling: { ...scene.ceiling, ceiling_mounted } }
}

/**
 * Build a ceiling-mounted SpatialObject from a catalog asset at the tap-XZ point
 * (Boden-Tap darunter). Y leitet der Renderer aus der Decken-Höhe ab.
 */
export function buildCeilingMountedObjectFromAsset(input: {
  id: string
  ceiling: Ceiling
  category: ObjectCategory
  assetId: string
  dimensions: { width_m: number; depth_m: number; height_m: number }
  variantId: string
  generatedAt: string
  tapX?: number
  tapZ?: number
}): SpatialObject {
  return {
    id: input.id,
    type: 'object',
    parent_id: input.ceiling.id,
    children_ids: [],
    transform: {
      position: { x: input.tapX ?? 0, y: 0, z: input.tapZ ?? 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    source: 'manual',
    confidence: 1,
    variant_id: input.variantId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    category: input.category,
    asset_id: input.assetId,
    dimensions: { ...input.dimensions },
    host: 'ceiling',
    host_id: input.ceiling.id,
  }
}
