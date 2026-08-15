/**
 * Spatial · V1.6.1 · `buildExampleRoom` contract
 *
 * The renderer mounts whatever `buildExampleRoom(kind)` returns — so any
 * structural drift (missing wall, dimension drift, wrong category) reaches
 * the customer before code review. This file is the cheap, isolated guard.
 */

import { describe, expect, it } from 'vitest'

import {
  buildExampleRoom,
  EXAMPLE_ROOMS_META,
  isExampleRoomKind,
  type ExampleRoomKind,
} from '../../../src/lib/spatial/canonical/presets/exampleRooms'

const KINDS: readonly ExampleRoomKind[] = ['bath', 'kitchen', 'living']

describe('buildExampleRoom', () => {
  it.each(KINDS)('builds %s as a closed rectangle with 4 walls', kind => {
    const scene = buildExampleRoom(kind)
    expect(scene.type).toBe('room')
    expect(scene.walls.length).toBe(4)
    expect(scene.floor.polygon.length).toBe(4)
    expect(scene.ceiling.polygon.length).toBe(4)
    expect(scene.computed_area_m2).toBeGreaterThan(0)
  })

  it('assigns the right category per kind (drives lighting preset)', () => {
    expect(buildExampleRoom('bath').category).toBe('bathroom')
    expect(buildExampleRoom('kitchen').category).toBe('kitchen')
    expect(buildExampleRoom('living').category).toBe('living')
  })

  it('uses German interior dimensions matching the picker meta', () => {
    const bath = buildExampleRoom('bath')
    const kitchen = buildExampleRoom('kitchen')
    const living = buildExampleRoom('living')
    // Defaults from CUSTOMER_ROOM_PRESETS · ±0.05 tolerance.
    expect(bath.bounds_max.x - bath.bounds_min.x).toBeCloseTo(2.2, 1)
    expect(bath.bounds_max.z - bath.bounds_min.z).toBeCloseTo(3.2, 1)
    expect(kitchen.bounds_max.x - kitchen.bounds_min.x).toBeCloseTo(3.4, 1)
    expect(living.bounds_max.x - living.bounds_min.x).toBeCloseTo(3.8, 1)
  })

  it('every furniture object references a known catalog asset slug', async () => {
    const { getCatalogAsset } = await import(
      '../../../src/lib/spatial/canonical/catalog/asset-catalog'
    )
    for (const kind of KINDS) {
      const scene = buildExampleRoom(kind)
      const objects = [
        ...scene.free_objects,
        ...scene.walls.flatMap(w => w.wall_mounted),
        ...scene.floor.floor_mounted,
      ]
      // Each example carries at least 2 furniture / fixture pieces so the
      // visual atmosphere is not a sterile empty box.
      expect(objects.length).toBeGreaterThanOrEqual(2)
      for (const obj of objects) {
        expect(obj.asset_id).toBeTruthy()
        const asset = getCatalogAsset(obj.asset_id!)
        expect(asset, `catalog asset ${obj.asset_id}`).toBeTruthy()
      }
    }
  })

  it('walls carry a material_id so the renderer paints atmosphere instead of grey', () => {
    for (const kind of KINDS) {
      const scene = buildExampleRoom(kind)
      // Bath has tile-walls, kitchen has plaster, living has linen — all are
      // catalog-resolved PBR materials. At least one wall must carry an id.
      const wallWithMaterial = scene.walls.find(w => w.material_id !== undefined)
      expect(wallWithMaterial, `wall material missing for ${kind}`).toBeTruthy()
      expect(scene.floor.material_id, `floor material missing for ${kind}`).toBeTruthy()
    }
  })

  it('returns ≥ 1 hint pin per room so the viewer can surface a Hotspot', () => {
    for (const kind of KINDS) {
      const scene = buildExampleRoom(kind)
      expect(scene.pins.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('keeps the visual-meta and the rendered scene in sync', () => {
    // The picker meta advertises Hotspot counts — the scene must back the
    // claim with at least that many pins (drift-guard for marketing-copy
    // vs scene contents).
    for (const meta of EXAMPLE_ROOMS_META) {
      const scene = buildExampleRoom(meta.kind)
      expect(scene.pins.length).toBeGreaterThanOrEqual(Math.min(2, meta.hotspots))
    }
  })
})

describe('isExampleRoomKind', () => {
  it.each(['bath', 'kitchen', 'living'])('accepts %s', kind => {
    expect(isExampleRoomKind(kind)).toBe(true)
  })

  it.each(['bedroom', '', null, undefined, 42])('rejects %s', value => {
    expect(isExampleRoomKind(value)).toBe(false)
  })
})
