/**
 * wallPointOrchestrator — footprint-first wall-geometry edits (manual rooms).
 * Pure-function coverage: corner drag, exact length, height, min-edge reject.
 */
import { describe, it, expect } from 'vitest'

import { buildEmptyRoom2x2Preset } from '../../../../../src/lib/spatial/canonical/presets/presetEmptyRoom.ts'
import {
  moveWallCorner,
  moveWallEdge,
  setEdgeLength,
  setWallHeight,
  setAllWallsHeight,
  setWallDims,
  insertWallCorner,
  previewWallCorner,
  previewWallEdge,
  wallOutwardNormalXZ,
} from '../../../../../src/lib/spatial/canonical/workflow/wallPointOrchestrator.ts'
import { buildDefaultOpening } from '../../../../../src/lib/spatial/canonical/mutations/customerObjectMutator.ts'

const ROOM = 'room_1'
const T = '2026-06-04T00:00:00.000Z'

/** A known 4×3 m rectangle: w_s (0,0)→(4,0), w_e (4,0)→(4,3), w_n, w_w. */
function rect4x3() {
  return buildEmptyRoom2x2Preset({
    roomNodeId: ROOM,
    footprintMeters: { widthM: 4, depthM: 3 },
    createdAt: T,
  })
}
const wall = (scene: { walls: { id: string }[] }, suffix: string) =>
  scene.walls.find((w) => w.id === `${ROOM}__${suffix}`)!

describe('wallPointOrchestrator', () => {
  it('moveWallCorner drags both walls sharing the corner', () => {
    const res = moveWallCorner({ scene: rect4x3(), from: { x: 4, z: 0 }, to: { x: 5, z: 0 } })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    // w_s end + w_e start both moved to (5,0)
    expect(wall(res.scene, 'w_s').length_m).toBeCloseTo(5, 6)
    expect(wall(res.scene, 'w_s').end_point).toMatchObject({ x: 5, z: 0 })
    expect(wall(res.scene, 'w_e').start_point).toMatchObject({ x: 5, z: 0 })
    expect(res.scene.floor.polygon).toHaveLength(4)
  })

  it('setEdgeLength sets an exact wall length (start fixed)', () => {
    const res = setEdgeLength({ scene: rect4x3(), wallId: `${ROOM}__w_s`, lengthM: 6 })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    expect(wall(res.scene, 'w_s').length_m).toBeCloseTo(6, 6)
    expect(wall(res.scene, 'w_s').start_point).toMatchObject({ x: 0, z: 0 })
    expect(wall(res.scene, 'w_s').end_point).toMatchObject({ x: 6, z: 0 })
  })

  it('rejects a sub-minimum wall length', () => {
    const res = setEdgeLength({ scene: rect4x3(), wallId: `${ROOM}__w_s`, lengthM: 0.3 })
    expect(res.kind).toBe('rejected')
    if (res.kind !== 'rejected') return
    expect(res.message).toMatch(/zu kurz/i)
  })

  it('setWallHeight changes one wall, footprint unchanged', () => {
    const res = setWallHeight({ scene: rect4x3(), wallId: `${ROOM}__w_s`, heightM: 3.0 })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    expect(wall(res.scene, 'w_s').height_m).toBe(3.0)
    expect(wall(res.scene, 'w_e').height_m).toBe(2.5)
    expect(res.scene.computed_area_m2).toBeCloseTo(12, 6)
  })

  it('setAllWallsHeight sets every wall + the ceiling height', () => {
    const res = setAllWallsHeight({ scene: rect4x3(), heightM: 2.8 })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    expect(res.scene.walls.every((w) => w.height_m === 2.8)).toBe(true)
    expect(res.scene.ceiling.height_m).toBe(2.8)
    expect(res.scene.computed_volume_m3).toBeCloseTo(12 * 2.8, 6)
  })

  it('setWallDims sets height + thickness; footprint unchanged', () => {
    const res = setWallDims({ scene: rect4x3(), wallId: `${ROOM}__w_s`, heightM: 2.7, thicknessM: 0.2 })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    expect(wall(res.scene, 'w_s').height_m).toBe(2.7)
    expect(wall(res.scene, 'w_s').thickness_m).toBe(0.2)
    expect(res.scene.computed_area_m2).toBeCloseTo(12, 6)
  })

  it('setWallDims preserves a non-stitching floor polygon (scan-room safety)', () => {
    const base = rect4x3()
    // Break the ring (walls no longer stitch) but keep the original floor polygon,
    // simulating a scanned room whose RoomPlan walls miss the stitch epsilon.
    const broken = {
      ...base,
      walls: base.walls.map((w) =>
        w.id === `${ROOM}__w_e` ? { ...w, start_point: { x: 99, y: 0, z: 99 } } : w,
      ),
    }
    const res = setWallDims({ scene: broken, wallId: `${ROOM}__w_s`, heightM: 2.7, thicknessM: 0.2 })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    // A dims-only edit must NOT wipe the floor polygon / area.
    expect(res.scene.floor.polygon).toHaveLength(4)
    expect(res.scene.computed_area_m2).toBeCloseTo(12, 6)
  })

  it('rejects a corner-merge that collapses a wall to ~zero length', () => {
    // Drag corner (4,0) onto (0,0) → the south wall collapses to length 0.
    const res = moveWallCorner({ scene: rect4x3(), from: { x: 4, z: 0 }, to: { x: 0, z: 0 } })
    expect(res.kind).toBe('rejected')
  })

  it('wallOutwardNormalXZ points away from the room interior', () => {
    const n = wallOutwardNormalXZ(rect4x3(), `${ROOM}__w_s`)
    expect(n).not.toBeNull()
    if (!n) return
    // South wall at z=0 with the room at z>0 → outward points to z<0.
    expect(n.z).toBeLessThan(0)
    expect(Math.abs(n.x)).toBeLessThan(1e-6)
    expect(Math.hypot(n.x, n.z)).toBeCloseTo(1, 6)
  })

  it('moveWallEdge slides a whole wall outward, grows the room, stays rectilinear', () => {
    const scene = rect4x3()
    const n = wallOutwardNormalXZ(scene, `${ROOM}__w_s`)!
    const res = moveWallEdge({ scene, wallId: `${ROOM}__w_s`, delta: { x: n.x, z: n.z } })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    // South wall translated RIGIDLY (length unchanged); depth 3→4 → area 16.
    expect(wall(res.scene, 'w_s').length_m).toBeCloseTo(4, 6)
    expect(res.scene.computed_area_m2).toBeCloseTo(16, 6)
    // Right angles preserved: both side walls stay axis-aligned (one coord equal).
    const e = wall(res.scene, 'w_e')
    expect(e.start_point.x).toBeCloseTo(e.end_point.x, 6)
    const w = wall(res.scene, 'w_w')
    expect(w.start_point.x).toBeCloseTo(w.end_point.x, 6)
    expect(res.scene.floor.polygon).toHaveLength(4)
  })

  it('moveWallEdge round-trips (slide out then back) to the original area', () => {
    const scene = rect4x3()
    const n = wallOutwardNormalXZ(scene, `${ROOM}__w_s`)!
    const out = moveWallEdge({ scene, wallId: `${ROOM}__w_s`, delta: { x: n.x * 1.5, z: n.z * 1.5 } })
    expect(out.kind).toBe('updated')
    if (out.kind !== 'updated') return
    const back = moveWallEdge({
      scene: out.scene,
      wallId: `${ROOM}__w_s`,
      delta: { x: -n.x * 1.5, z: -n.z * 1.5 },
    })
    expect(back.kind).toBe('updated')
    if (back.kind !== 'updated') return
    expect(back.scene.computed_area_m2).toBeCloseTo(12, 6)
  })

  it('moveWallEdge rejects an inward slide that drives a side wall below the minimum', () => {
    const scene = rect4x3()
    const n = wallOutwardNormalXZ(scene, `${ROOM}__w_s`)!
    // Inward 2.7 m → room depth 0.3 m → the side walls fall below MIN_WALL_LENGTH_M.
    const res = moveWallEdge({
      scene,
      wallId: `${ROOM}__w_s`,
      delta: { x: -n.x * 2.7, z: -n.z * 2.7 },
    })
    expect(res.kind).toBe('rejected')
    if (res.kind !== 'rejected') return
    expect(res.message).toMatch(/zu kurz/i)
  })

  it('previewWallEdge: valid pose → no rejection + rebuilt floor', () => {
    const scene = rect4x3()
    const n = wallOutwardNormalXZ(scene, `${ROOM}__w_s`)!
    const live = previewWallEdge({ scene, wallId: `${ROOM}__w_s`, delta: { x: n.x, z: n.z } })
    expect(live.rejection).toBeNull()
    expect(live.scene.floor.polygon).toHaveLength(4)
    expect(live.scene.computed_area_m2).toBeCloseTo(16, 6)
  })

  it('previewWallEdge: invalid pose still follows the finger but holds the last valid floor', () => {
    const scene = rect4x3()
    const n = wallOutwardNormalXZ(scene, `${ROOM}__w_s`)!
    const live = previewWallEdge({
      scene,
      wallId: `${ROOM}__w_s`,
      delta: { x: -n.x * 2.7, z: -n.z * 2.7 },
    })
    expect(live.rejection).toMatch(/zu kurz/i)
    // The south wall STILL moved to the (invalid) pose so the drag never freezes…
    const s = live.scene.walls.find((w) => w.id === `${ROOM}__w_s`)!
    expect(Math.abs(s.start_point.z - 2.7)).toBeLessThan(1e-6)
    // …but the floor is HELD at the last valid shape (not wiped/rebuilt).
    expect(live.scene.floor.polygon).toHaveLength(4)
    expect(live.scene.computed_area_m2).toBeCloseTo(12, 6)
  })

  it('previewWallCorner: valid pose rebuilds, invalid pose follows + reports', () => {
    const scene = rect4x3()
    const ok = previewWallCorner({ scene, from: { x: 4, z: 0 }, to: { x: 5, z: 0 } })
    expect(ok.rejection).toBeNull()
    expect(wall(ok.scene, 'w_s').end_point).toMatchObject({ x: 5, z: 0 })
    const bad = previewWallCorner({ scene, from: { x: 4, z: 0 }, to: { x: 0, z: 0 } })
    expect(bad.rejection).not.toBeNull()
    // Corner still dragged onto (0,0) in the preview (renderable, not frozen).
    expect(wall(bad.scene, 'w_s').end_point).toMatchObject({ x: 0, z: 0 })
  })

  it('insertWallCorner forms a clean rectilinear L (6 walls, area grows by the step)', () => {
    const res = insertWallCorner({
      scene: rect4x3(),
      wallId: `${ROOM}__w_s`,
      newWallIdLeft: 'wL',
      newWallIdRiser: 'wRi',
      newWallIdRight: 'wR',
      generatedAt: T,
    })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    const left = res.scene.walls.find((w) => w.id === 'wL')!
    const riser = res.scene.walls.find((w) => w.id === 'wRi')!
    const right = res.scene.walls.find((w) => w.id === 'wR')!
    expect(left.length_m).toBeCloseTo(2, 6)
    expect(right.length_m).toBeCloseTo(2, 6)
    expect(riser.length_m).toBeCloseTo(0.6, 6)
    // L geometry: south wall split at x=2, the right half pushed out to z=-0.6.
    expect(left.end_point).toMatchObject({ x: 2, z: 0 })
    expect(riser.start_point).toMatchObject({ x: 2, z: 0 })
    expect(riser.end_point).toMatchObject({ x: 2, z: -0.6 })
    expect(right.start_point).toMatchObject({ x: 2, z: -0.6 })
    expect(right.end_point).toMatchObject({ x: 4, z: -0.6 })
    expect(res.scene.walls).toHaveLength(6)
    expect(res.scene.floor.polygon).toHaveLength(6)
    // 12 m² + the 2×0.6 m step = 13.2 m².
    expect(res.scene.computed_area_m2).toBeCloseTo(13.2, 6)
  })

  it('insertWallCorner keeps the L rectilinear when the pushed-out segment is slid deeper', () => {
    const ins = insertWallCorner({
      scene: rect4x3(),
      wallId: `${ROOM}__w_s`,
      newWallIdLeft: 'wL',
      newWallIdRiser: 'wRi',
      newWallIdRight: 'wR',
      generatedAt: T,
    })
    expect(ins.kind).toBe('updated')
    if (ins.kind !== 'updated') return
    const n = wallOutwardNormalXZ(ins.scene, 'wR')!
    const slid = moveWallEdge({ scene: ins.scene, wallId: 'wR', delta: { x: n.x * 0.6, z: n.z * 0.6 } })
    expect(slid.kind).toBe('updated')
    if (slid.kind !== 'updated') return
    const right = slid.scene.walls.find((w) => w.id === 'wR')!
    // Right segment stayed axis-aligned (constant z) — no slant.
    expect(right.start_point.z).toBeCloseTo(right.end_point.z, 6)
    // Step deepened to 1.2 m → extension 2×1.2 = 2.4 m² → total 14.4 m².
    expect(slid.scene.computed_area_m2).toBeCloseTo(14.4, 6)
  })

  it('insertWallCorner rejects when the halves would be sub-minimum', () => {
    const short = setEdgeLength({ scene: rect4x3(), wallId: `${ROOM}__w_s`, lengthM: 0.9 })
    expect(short.kind).toBe('updated')
    if (short.kind !== 'updated') return
    const res = insertWallCorner({
      scene: short.scene,
      wallId: `${ROOM}__w_s`,
      newWallIdLeft: 'wL',
      newWallIdRiser: 'wRi',
      newWallIdRight: 'wR',
      generatedAt: T,
    })
    expect(res.kind).toBe('rejected')
    if (res.kind !== 'rejected') return
    expect(res.message).toMatch(/zu kurz/i)
  })

  it('insertWallCorner reassigns hosted openings to the correct half (offset rebased)', () => {
    const base = rect4x3()
    const ws = base.walls.find((w) => w.id === `${ROOM}__w_s`)!
    const opA = buildDefaultOpening({
      id: 'op_a',
      wallId: ws.id,
      wallLengthM: 4,
      wallHeightM: ws.height_m,
      type: 'window',
      variantId: 'base_roomplan',
      generatedAt: T,
      tapOffsetAlongWallM: 0.8, // centre near 0.8 → fully in first half [0,2]
    })
    const opB = buildDefaultOpening({
      id: 'op_b',
      wallId: ws.id,
      wallLengthM: 4,
      wallHeightM: ws.height_m,
      type: 'window',
      variantId: 'base_roomplan',
      generatedAt: T,
      tapOffsetAlongWallM: 3.2, // centre near 3.2 → fully in second half [2,4]
    })
    const withOpenings = {
      ...base,
      walls: base.walls.map((w) => (w.id === ws.id ? { ...w, openings: [opA, opB] } : w)),
    }
    const res = insertWallCorner({
      scene: withOpenings,
      wallId: ws.id,
      newWallIdLeft: 'wL',
      newWallIdRiser: 'wRi',
      newWallIdRight: 'wR',
      generatedAt: T,
    })
    expect(res.kind).toBe('updated')
    if (res.kind !== 'updated') return
    const left = res.scene.walls.find((w) => w.id === 'wL')!
    const right = res.scene.walls.find((w) => w.id === 'wR')!
    expect(left.openings.map((o) => o.id)).toEqual(['op_a'])
    expect(right.openings.map((o) => o.id)).toEqual(['op_b'])
    expect(left.openings[0].host_wall_id).toBe('wL')
    expect(right.openings[0].host_wall_id).toBe('wR')
    // Right-half opening offset is rebased by the half length (2 m).
    expect(right.openings[0].offset_along_wall_m).toBeCloseTo(opB.offset_along_wall_m - 2, 6)
  })

  it('finalize rejects a non-closing wall ring instead of committing a blank floor', () => {
    // Walls that no longer stitch into a single closed loop (the same broken-ring
    // setup the scan-safety test uses). A footprint op routed through finalize
    // (here setWallHeight) must REJECT — committing it would persist an EMPTY
    // floor polygon (area 0) while the walls sit elsewhere, the root cause of
    // "the floor is outside / collapsed in 3D after editing dimensions".
    const base = rect4x3()
    const broken = {
      ...base,
      walls: base.walls.map((w) =>
        w.id === `${ROOM}__w_e` ? { ...w, start_point: { x: 99, y: 0, z: 99 } } : w,
      ),
    }
    const res = setWallHeight({ scene: broken, wallId: `${ROOM}__w_s`, heightM: 3 })
    expect(res.kind).toBe('rejected')
    if (res.kind !== 'rejected') return
    expect(res.message).toMatch(/nicht geschlossen/i)
  })
})
