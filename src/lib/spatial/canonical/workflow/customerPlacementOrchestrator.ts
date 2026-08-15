/**
 * Customer host-aware Katalog-Platzierung — PURE domain/workflow layer.
 *
 * Single entry point: ein gewähltes Katalog-Asset + die getappte Fläche →
 * korrekter Host (Boden/Wand/Decke). Löst die alte Fragmentierung ab, bei der
 * `placeFurniture` JEDEN Host ≠ floor mit einem Sackgassen-Toast abwies und nur
 * die Wand-Tools (Tür/Fenster/Heizung/Elektro) Wand-Objekte setzen konnten.
 *
 * Der Host kommt AUTORITATIV aus `asset.host` (= CatalogAsset.snapRule.target_host,
 * inkl. Overrides wie Stehlampe→floor, Wandleuchte→wall, Tischlampe→counter) —
 * deshalb routet diese Schicht selbst und ruft NICHT `placeFurniture` (das den
 * Host nochmal aus CATEGORY_DEFAULT_HOST ableiten und z.B. die Stehlampe
 * fälschlich als 'ceiling' ablehnen würde).
 *
 * ZERO React / zustand / three.js / supabase — nur Mutatoren + Validatoren +
 * Wall-Coords. Die UI wendet store-write / toast / Selektion auf das Ergebnis an.
 */
import {
  addFloorObjectToFloor,
  buildDefaultFloorObject,
  addWallMountedObjectToWall,
  buildWallMountedObjectFromAsset,
  addCeilingMountedObject,
  buildCeilingMountedObjectFromAsset,
} from '../mutations/customerObjectMutator'
import {
  aabbForWallMounted,
  clampFloorObjectIntoRoom,
  findSubstantialFloorOverlap,
  scaledHeightM,
  validateObjectPosition,
} from '../validator/objectPositionValidator'
import { snapWallObjectVerticalToDin } from '../validator/wallObjectDinValidator'
import { wallLengthMeters, worldPointToWallLocalOffset } from '../geometry/wallCoords'
import type { ObjectCategory, ObjectHost } from '../types/objects'
import type { RoomScene } from '../types/scene-graph'

const VARIANT_ID = 'customer_corrections'

/** Minimal-Asset-Shape, die die Platzierung braucht (Hub-Screen löst den vollen
 *  CatalogAsset auf und gibt den autoritativen Host mit). */
export interface PlacementAssetInput {
  slug: string
  objectCategory: ObjectCategory | null
  dimensions: { width_m: number; depth_m: number; height_m: number }
  /** Autoritativer Host aus `CatalogAsset.snapRule.target_host`. */
  host: ObjectHost
  /** Für die geführten Toasts. */
  displayName: string
}

export type PlaceAssetResult =
  /** Platziert — UI: setScene + persist + selektieren. `overlapNotice` ist ein
   *  optionaler Soft-Hinweis (kein Fehler) bei substanzieller Möbel-Überlappung. */
  | { kind: 'placed'; scene: RoomScene; objectId: string; host: ObjectHost; wallId?: string; overlapNotice?: string }
  /** Falsche Fläche getappt — UI: Hinweis-Toast, Tool BLEIBT scharf (keine Sackgasse). */
  | { kind: 'wrong-surface'; message: string }
  /** Validierung schlug fehl (overlap / out-of-bounds) — UI: Toast, Tool bleibt scharf. */
  | { kind: 'rejected'; message: string }
  /** Host noch nicht unterstützt (counter/corner) — UI: Toast, Tool entschärfen. */
  | { kind: 'unsupported'; message: string }

export function placeCatalogAsset(input: {
  scene: RoomScene
  asset: PlacementAssetInput
  newId: string
  generatedAt: string
  tappedKind?: string
  surfaceId: string
  worldXyz?: { x: number; y: number; z: number }
}): PlaceAssetResult {
  const { scene, asset, newId, generatedAt, tappedKind, surfaceId, worldXyz } = input
  const category: ObjectCategory = asset.objectCategory ?? 'generic_cuboid'

  // ── FLOOR / FREE ────────────────────────────────────────────────────────────
  if (asset.host === 'floor' || asset.host === 'free') {
    if (tappedKind !== 'floor') {
      return { kind: 'wrong-surface', message: `Tippe auf den Boden, um ${asset.displayName} zu platzieren` }
    }
    const object = buildDefaultFloorObject({
      id: newId,
      floorId: scene.floor.id,
      category,
      assetId: asset.slug,
      dimensions: asset.dimensions,
      variantId: VARIANT_ID,
      generatedAt,
      tapX: worldXyz?.x,
      tapZ: worldXyz?.z,
    })
    // A2: Möbel höher als der Raum → durch die Decke → hart ablehnen.
    const ceilingHeightM = scene.ceiling?.height_m
    if (ceilingHeightM && scaledHeightM(object) > ceilingHeightM + 1e-6) {
      return { kind: 'rejected', message: 'Möbel ist höher als der Raum' }
    }
    // Clamp-to-fit: ein Tap im Raum platziert immer — die Stellfläche rutscht von
    // den Wänden weg statt abzulehnen. Nur ein Objekt größer als der Raum wird
    // abgewiesen.
    const fit = clampFloorObjectIntoRoom(scene.floor, object)
    if (!fit) return { kind: 'rejected', message: 'Möbel ist größer als dieser Raum' }
    const placed = {
      ...object,
      transform: { ...object.transform, position: { ...object.transform.position, x: fit.x, z: fit.z } },
    }
    // A1: Soft-Notice bei substanzieller Überlappung mit bestehendem Möbel (kein
    // Block — „Stuhl unter Tisch" ist legitim).
    const overlap = findSubstantialFloorOverlap({ floor: scene.floor, candidate: placed })
    return {
      kind: 'placed',
      scene: addFloorObjectToFloor(scene, { floorId: scene.floor.id, object: placed }),
      objectId: newId,
      host: 'floor',
      overlapNotice: overlap ? `Überschneidet sich mit ${overlap.name ?? 'einem anderen Möbel'}` : undefined,
    }
  }

  // ── WALL (Spiegel / Wandleuchte / Regal / Vorhang + Elektro/Heizung) ─────────
  if (asset.host === 'wall') {
    if (tappedKind !== 'wall') {
      return { kind: 'wrong-surface', message: `Tippe auf eine Wand, um ${asset.displayName} zu platzieren` }
    }
    const wall = scene.walls.find((w) => w.id === surfaceId)
    if (!wall) return { kind: 'rejected', message: 'Wand nicht erkannt — bitte erneut tippen' }
    const wallLengthM = wallLengthMeters(wall)
    const tapLocal = worldXyz
      ? worldPointToWallLocalOffset(wall, worldXyz, wallLengthM, wall.height_m)
      : undefined
    // DIN-Vertikal-Snap nur für Elektro (Schalter→1,05 / Steckdose→0,30|1,10 m).
    // Möbel rasten auf ihre Kategorie-Default-Höhe bzw. den Tap-Y (CENTER) ein.
    const tapFromFloor = tapLocal?.offset_from_floor_m
    const tapOffsetFromFloorM =
      tapFromFloor != null && (category === 'light_switch' || category === 'electrical_outlet')
        ? snapWallObjectVerticalToDin(category, tapFromFloor)
        : tapFromFloor
    const object = buildWallMountedObjectFromAsset({
      id: newId,
      wallId: wall.id,
      wallLengthM,
      wallHeightM: wall.height_m,
      category,
      assetId: asset.slug,
      dimensions: asset.dimensions,
      variantId: VARIANT_ID,
      generatedAt,
      tapOffsetAlongWallM: tapLocal?.offset_along_wall_m,
      tapOffsetFromFloorM,
    })
    const aabb = aabbForWallMounted(object)
    if (aabb) {
      const validation = validateObjectPosition({ wall, wallLengthM, candidate: aabb })
      if (!validation.ok) return { kind: 'rejected', message: validation.message }
    }
    return {
      kind: 'placed',
      scene: addWallMountedObjectToWall(scene, { wallId: wall.id, object }),
      objectId: newId,
      host: 'wall',
      wallId: wall.id,
    }
  }

  // ── CEILING (Deckenleuchte / Kronleuchter / Pendel) ──────────────────────────
  // Boden-Tap darunter ODER Decken-Tap: X/Z aus dem Tap, Lampe mountet an der
  // Decke direkt darüber (robust ggü. Decken-Pickbarkeit im Dollhouse-Cutaway).
  if (asset.host === 'ceiling') {
    if (tappedKind !== 'floor' && tappedKind !== 'ceiling') {
      return {
        kind: 'wrong-surface',
        message: `Tippe auf den Boden unter die gewünschte Deckenposition für ${asset.displayName}`,
      }
    }
    const object = buildCeilingMountedObjectFromAsset({
      id: newId,
      ceiling: scene.ceiling,
      category,
      assetId: asset.slug,
      dimensions: asset.dimensions,
      variantId: VARIANT_ID,
      generatedAt,
      tapX: worldXyz?.x,
      tapZ: worldXyz?.z,
    })
    return {
      kind: 'placed',
      scene: addCeilingMountedObject(scene, { object }),
      objectId: newId,
      host: 'ceiling',
    }
  }

  // ── COUNTER / CORNER — noch nicht unterstützt (Ablage-Detection / Eck-Snap) ──
  return {
    kind: 'unsupported',
    message: `${asset.displayName} braucht eine Ablage/Ecke — kommt mit dem nächsten Update.`,
  }
}
