/**
 * Customer furniture place/edit orchestration — PURE domain layer.
 *
 * Cluster A root-fix: the place/move/edit decision logic used to live inline in
 * `CustomerSpatialHubScreen` (a 2k-line UI component), where it read the frozen
 * `roomScene` hook value as its mutation base → stale-base bugs (2nd placement
 * wipes the 1st, just-placed object unselectable, rapid edits lose state,
 * cross-feature clobber). Moving the logic here:
 *   1. removes business logic from the UI (CLAUDE.md architecture rule),
 *   2. makes the single scene-read site explicit — the screen passes the LIVE
 *      store scene (`useCanonicalSceneStore.getState().scene`) into every call,
 *      so there is no longer a place to accidentally read a frozen snapshot,
 *   3. makes the whole flow unit-testable (which is why the bug was never caught
 *      by the green in-memory suite — there was no seam to test).
 *
 * ZERO React / zustand / three.js / supabase imports — only canonical mutators
 * + the position validator. Every function takes the current scene and returns a
 * discriminated result; the UI applies store-writes / toasts / selection state.
 */
import {
  addFloorObjectToFloor,
  buildDefaultFloorObject,
  removeFloorObjectFromFloor,
  updateFloorObjectInFloor,
  type CustomerFloorObjectUpdateInput,
} from '../mutations/customerObjectMutator'
import type { RoomScene } from '../types/scene-graph'
import {
  CATEGORY_DEFAULT_HOST,
  scaleLimitsForCategory,
  type ObjectCategory,
} from '../types/objects'
import {
  clampFloorObjectIntoRoom,
  findSubstantialFloorOverlap,
  scaledHeightM,
  validateFloorObjectPosition,
} from '../validator/objectPositionValidator'

export const FURNITURE_SCALE_MIN = 0.5
export const FURNITURE_SCALE_MAX = 2.0
/** Soft cap on floor objects per scene — each placed object holds a full
 *  `loaded.scene.clone(true)` + Box3, so an unbounded "place a row of chairs"
 *  is a GPU-memory risk. Beyond this the duplicate/place is refused with a toast. */
export const FURNITURE_MAX_OBJECTS = 60

/** Minimal catalog-asset shape the placement needs — keeps this layer decoupled
 *  from the catalog module (the screen resolves the full CatalogAsset). */
export interface FurnitureAssetInput {
  slug: string
  objectCategory: ObjectCategory | null
  dimensions: { width_m: number; depth_m: number; height_m: number }
}

/** A floor-plane tap with optional world-space hit point. */
export interface FurnitureTapInput {
  kind?: string
  surfaceExternalId: string
  worldXyz?: { x: number; y: number; z: number }
}

/**
 * Max uniform scale before the object's (uniform-scaled) height reaches the
 * ceiling (Block A · A2). Falls back to `Infinity` when the room has no usable
 * ceiling height — the per-category limit then governs alone.
 */
function ceilingScaleCap(scene: RoomScene, baseHeightM: number): number {
  const ceilingHeightM = scene.ceiling?.height_m
  if (!ceilingHeightM || ceilingHeightM <= 0 || baseHeightM <= 0) return Infinity
  return ceilingHeightM / baseHeightM
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tap dispatch while a furniture object is selected (edit-mode).
//    - tap on a DIFFERENT floor object → switch selection
//    - floor tap → DESELECT (#5b: repositioning is drag-only now)
//    - anything else (same object / wall) → no-op
// ─────────────────────────────────────────────────────────────────────────────
export type SelectedFurnitureTapResult =
  | { kind: 'select-object'; objectId: string }
  | { kind: 'deselect' }
  | { kind: 'ignore' }

export function resolveSelectedFurnitureTap(input: {
  scene: RoomScene
  selectedObjectId: string
  tap: FurnitureTapInput
}): SelectedFurnitureTapResult {
  const { scene, selectedObjectId, tap } = input

  // Tap on a DIFFERENT existing floor object → switch selection.
  if (tap.kind === 'object' && tap.surfaceExternalId !== selectedObjectId) {
    if (scene.floor.floor_mounted.some((o) => o.id === tap.surfaceExternalId)) {
      return { kind: 'select-object', objectId: tap.surfaceExternalId }
    }
    return { kind: 'ignore' }
  }

  // #5b: a floor tap DESELECTS instead of moving. The old tap-to-move teleported
  // the selected object whenever the user missed a neighbour's footprint while
  // trying to pick it ("ich hab nur getippt und alles ist verrutscht").
  // Repositioning is now drag-only (FurnitureGestureLayer → moveFurniture); a
  // floor tap is the reliable "I'm done with this object" gesture — which the
  // background-tap deselect couldn't offer in a crowded room (little empty void).
  if (tap.kind === 'floor') {
    return { kind: 'deselect' }
  }

  return { kind: 'ignore' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Place a furniture object at the tapped floor point.
// ─────────────────────────────────────────────────────────────────────────────
export type FurniturePlaceResult =
  | { kind: 'placed'; scene: RoomScene; objectId: string; overlapNotice?: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'wrong-host'; message: string }

export function placeFurniture(input: {
  scene: RoomScene
  asset: FurnitureAssetInput
  newId: string
  generatedAt: string
  tapX?: number
  tapZ?: number
}): FurniturePlaceResult {
  // #4: the floor-tap place flow only supports floor-hosted assets. A wall/
  // ceiling/counter/corner asset (chandelier, wall mirror, sconce, …) dropped
  // onto the floor would lie flat + validate/persist against the wrong host →
  // refuse until a wall/ceiling place flow exists. A null category falls back to
  // 'generic_cuboid' which is floor-hosted, so it is allowed.
  const host = input.asset.objectCategory
    ? CATEGORY_DEFAULT_HOST[input.asset.objectCategory]
    : 'floor'
  if (host !== 'floor') {
    return {
      kind: 'wrong-host',
      message: 'Dieses Objekt gehört an eine Wand oder Decke — kommt mit dem nächsten Update.',
    }
  }
  const floorId = input.scene.floor.id
  const object = buildDefaultFloorObject({
    id: input.newId,
    floorId,
    category: input.asset.objectCategory ?? 'generic_cuboid',
    assetId: input.asset.slug,
    dimensions: input.asset.dimensions,
    variantId: 'customer_corrections',
    generatedAt: input.generatedAt,
    tapX: input.tapX,
    tapZ: input.tapZ,
  })
  // A2: ein Möbel höher als der Raum würde durch die Decke stechen → hart ablehnen
  // (ein roh zu hohes Katalog-Objekt hat keinen legitimen Platz im Raum).
  const ceilingHeightM = input.scene.ceiling?.height_m
  if (ceilingHeightM && scaledHeightM(object) > ceilingHeightM + 1e-6) {
    return { kind: 'rejected', message: 'Möbel ist höher als der Raum' }
  }
  // Clamp-to-fit: a tap inside the room always places — slide the footprint away
  // from the walls if it would breach them, rather than refusing (the old
  // all-4-corners hard-reject made the whole perimeter unplaceable). Only an
  // object genuinely larger than the room is refused, with a clear message.
  const fit = clampFloorObjectIntoRoom(input.scene.floor, object)
  if (!fit) return { kind: 'rejected', message: 'Möbel ist größer als dieser Raum' }
  const placed: typeof object = {
    ...object,
    transform: {
      ...object.transform,
      position: { ...object.transform.position, x: fit.x, z: fit.z },
    },
  }
  // A1: substanzielle Überlappung mit einem bestehenden Möbel → Soft-Notice
  // (kein Block — „Stuhl unter Tisch" ist legitim). Auf der finalen (geclampten)
  // Position prüfen.
  const overlap = findSubstantialFloorOverlap({ floor: input.scene.floor, candidate: placed })
  return {
    kind: 'placed',
    scene: addFloorObjectToFloor(input.scene, { floorId, object: placed }),
    objectId: input.newId,
    overlapNotice: overlap ? `Überschneidet sich mit ${overlap.name ?? 'einem anderen Möbel'}` : undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Rotate the selected object by +45° (wraps at 360). Returns null when the
//    object is gone (idempotent no-op for the caller).
// ─────────────────────────────────────────────────────────────────────────────
export function rotateFurniture(input: { scene: RoomScene; objectId: string }): RoomScene | null {
  const obj = input.scene.floor.floor_mounted.find((o) => o.id === input.objectId)
  if (!obj) return null
  const nextDeg = ((obj.rotation_around_y_deg ?? 0) + 45) % 360
  return updateFloorObjectInFloor(input.scene, {
    floorId: input.scene.floor.id,
    objectId: obj.id,
    patch: { rotation_around_y_deg: nextDeg },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Scale the selected object by `delta`, clamped + rounded to 2 decimals.
//    Returns null when the object is gone OR the clamp produced no change.
// ─────────────────────────────────────────────────────────────────────────────
export function scaleFurniture(input: {
  scene: RoomScene
  objectId: string
  delta: number
}): RoomScene | null {
  const obj = input.scene.floor.floor_mounted.find((o) => o.id === input.objectId)
  if (!obj) return null
  const cur = obj.transform?.scale?.x ?? 1
  const { min, max } = scaleLimitsForCategory(obj.category)
  // A2: zusätzlich an die Deckenhöhe deckeln, damit Hochskalieren das Möbel nicht
  // durch die Decke wachsen lässt. Uniformer Scale → die Höhen-Obergrenze gilt 1:1.
  const ceilCap = ceilingScaleCap(input.scene, obj.dimensions.height_m)
  const upper = Math.min(max, ceilCap)
  const nextScale = Math.round(Math.min(upper, Math.max(min, cur + input.delta)) * 100) / 100
  if (nextScale === cur) return null
  return updateFloorObjectInFloor(input.scene, {
    floorId: input.scene.floor.id,
    objectId: obj.id,
    patch: {
      transform: {
        ...obj.transform,
        scale: { x: nextScale, y: nextScale, z: nextScale },
      },
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Duplicate the selected object at a +0.3/+0.3m offset. Returns null when the
//    source object is gone.
// ─────────────────────────────────────────────────────────────────────────────
export type FurnitureDuplicateResult =
  | { kind: 'duplicated'; scene: RoomScene; objectId: string; overlapNotice?: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'missing' }

export function duplicateFurniture(input: {
  scene: RoomScene
  objectId: string
  newId: string
  generatedAt: string
}): FurnitureDuplicateResult {
  const obj = input.scene.floor.floor_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  // #5 cap: bound the GPU cost of repeated 1-tap duplication.
  if (input.scene.floor.floor_mounted.length >= FURNITURE_MAX_OBJECTS) {
    return { kind: 'rejected', message: 'Maximale Anzahl Möbel im Raum erreicht.' }
  }
  const pos = obj.transform.position
  const clone = {
    ...obj,
    id: input.newId,
    created_at: input.generatedAt,
    updated_at: input.generatedAt,
    transform: {
      ...obj.transform,
      position: { x: pos.x + 0.3, y: pos.y, z: pos.z + 0.3 },
    },
  }
  // #5 bounds: place + move both validate — the clone must too, else a +0.3/+0.3
  // offset can shove it out of the room and silently persist out-of-bounds.
  // A2: the height cap rides along via `ceilingHeightM` (the clone keeps the
  // source's scale, so a too-tall source can't have existed — but kept for symmetry).
  const validation = validateFloorObjectPosition({
    floor: input.scene.floor,
    object: clone,
    ceilingHeightM: input.scene.ceiling?.height_m,
  })
  if (!validation.ok) return { kind: 'rejected', message: validation.message }
  // A1: Soft-Notice bei substanzieller Überlappung (kein Block).
  const overlap = findSubstantialFloorOverlap({ floor: input.scene.floor, candidate: clone })
  return {
    kind: 'duplicated',
    scene: addFloorObjectToFloor(input.scene, { floorId: input.scene.floor.id, object: clone }),
    objectId: input.newId,
    overlapNotice: overlap ? `Überschneidet sich mit ${overlap.name ?? 'einem anderen Möbel'}` : undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Delete the selected object.
// ─────────────────────────────────────────────────────────────────────────────
export function deleteFurniture(input: { scene: RoomScene; objectId: string }): RoomScene {
  return removeFloorObjectFromFloor(input.scene, {
    floorId: input.scene.floor.id,
    objectId: input.objectId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Direct-manipulation transforms (Phase 5 · FurnitureGestureLayer).
//    Continuous move / absolute rotate / absolute scale produced by finger
//    gestures. Unlike `resolveSelectedFurnitureTap` (discrete tap, forces y:0)
//    and `rotateFurniture` / `scaleFurniture` (fixed +45° / additive delta, and
//    crucially NO bounds re-validation), these take an ABSOLUTE target and
//    ALWAYS re-validate the footprint — a free drag/rotate/scale can shove a
//    corner out of the room, so the caller must hold the last valid pose on
//    `rejected`.
// ─────────────────────────────────────────────────────────────────────────────
export type FurnitureTransformResult =
  | { kind: 'updated'; scene: RoomScene }
  | { kind: 'rejected'; message: string }
  | { kind: 'missing' }

/** Snap a raw angle to the nearest `step`° and normalise to [0, 360). */
export function snapDegrees(deg: number, step = 15): number {
  const snapped = Math.round(deg / step) * step
  return ((snapped % 360) + 360) % 360
}

/**
 * Apply a floor-object patch then re-validate its footprint against the room.
 * `updated` carries the new scene; `rejected` means the caller keeps the last
 * valid pose; `missing` means the object is gone (idempotent no-op).
 */
function commitFloorTransform(
  scene: RoomScene,
  objectId: string,
  patch: CustomerFloorObjectUpdateInput['patch'],
): FurnitureTransformResult {
  const obj = scene.floor.floor_mounted.find((o) => o.id === objectId)
  if (!obj) return { kind: 'missing' }
  const next = updateFloorObjectInFloor(scene, { floorId: scene.floor.id, objectId, patch })
  const movedObj = next.floor.floor_mounted.find((o) => o.id === objectId)
  if (movedObj) {
    const validation = validateFloorObjectPosition({ floor: next.floor, object: movedObj })
    if (!validation.ok) return { kind: 'rejected', message: validation.message }
  }
  return { kind: 'updated', scene: next }
}

/** Continuous reposition to an absolute floor point. `y` is left untouched
 *  (derived from `height_m/2` by the renderer for floor objects). */
export function moveFurniture(input: {
  scene: RoomScene
  objectId: string
  x: number
  z: number
}): FurnitureTransformResult {
  const obj = input.scene.floor.floor_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  // Clamp-to-fit: dragging toward a wall slides the object flush against it
  // instead of freezing at the last valid pose. Only an over-sized object (bigger
  // than the room) is rejected so the caller can flash the out-of-bounds hint.
  const candidate: typeof obj = {
    ...obj,
    transform: {
      ...obj.transform,
      position: { x: input.x, y: obj.transform.position.y, z: input.z },
    },
  }
  const fit = clampFloorObjectIntoRoom(input.scene.floor, candidate)
  if (!fit) return { kind: 'rejected', message: 'Möbel ist größer als dieser Raum' }
  return commitFloorTransform(input.scene, input.objectId, {
    transform: {
      ...obj.transform,
      position: { x: fit.x, y: obj.transform.position.y, z: fit.z },
    },
  })
}

/** Absolute rotation (degrees), snapped to the 15° dial raster + normalised. */
export function setFurnitureRotationDeg(input: {
  scene: RoomScene
  objectId: string
  deg: number
}): FurnitureTransformResult {
  return commitFloorTransform(input.scene, input.objectId, {
    rotation_around_y_deg: snapDegrees(input.deg),
  })
}

/** Absolute uniform scale, clamped to the object's per-category limits +
 *  rounded to 2 decimals. Locked categories ({min:1,max:1}) collapse to 1. */
export function setFurnitureScale(input: {
  scene: RoomScene
  objectId: string
  scale: number
}): FurnitureTransformResult {
  const obj = input.scene.floor.floor_mounted.find((o) => o.id === input.objectId)
  if (!obj) return { kind: 'missing' }
  const { min, max } = scaleLimitsForCategory(obj.category)
  // A2: an die Deckenhöhe deckeln (siehe scaleFurniture).
  const ceilCap = ceilingScaleCap(input.scene, obj.dimensions.height_m)
  const upper = Math.min(max, ceilCap)
  const clamped = Math.round(Math.min(upper, Math.max(min, input.scale)) * 100) / 100
  return commitFloorTransform(input.scene, input.objectId, {
    transform: { ...obj.transform, scale: { x: clamped, y: clamped, z: clamped } },
  })
}
