/**
 * Tests for canonical/validator/validate-component-move.ts — the Phase-2
 * pre-apply constraint validator (Block 2.5-2.8).
 *
 * Covers every Master-Spec §8 case:
 *   §8.1 Hard-Reject — wall immovable, node-not-found, door/window fit,
 *        floor/wall plane lock, room bounds, pin anchor + UV, invalid dimension.
 *   §8.2 Soft-Warn  — object clearance, wall-object near corner, door blocked,
 *        door near corner, window sill too low.
 *   §8.3 Auto-Snap  — object→wall, object→floor, 15° rotation snap.
 */
import { describe, it, expect } from 'vitest'

import {
  validateComponentMove,
  autoSnapObjectTransform,
  snapRotationTo15Deg,
} from '../../../../../src/lib/spatial/canonical/validator/validate-component-move.ts'
import { needsConfirm } from '../../../../../src/lib/spatial/canonical/validator/move-validation.ts'
import {
  IDENTITY_QUATERNION,
  ONE_VECTOR3,
} from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import type { Transform } from '../../../../../src/lib/spatial/canonical/types/primitives.ts'
import { fromEuler } from '../../../../../src/lib/spatial/canonical/algebra/quaternion.ts'
import type { EditOperation } from '../../../../../src/lib/spatial/canonical/types/commands.ts'
import type { WallOpening } from '../../../../../src/lib/spatial/canonical/types/geometry.ts'
import {
  makeRoom,
  makeObject,
  makeOpening,
  makePin,
  makeWall,
} from '../__helpers__/sceneFactory.ts'

function tf(x: number, y: number, z: number, rotation = IDENTITY_QUATERNION): Transform {
  return { position: { x, y, z }, rotation: { ...rotation }, scale: { ...ONE_VECTOR3 } }
}

// A 4×3 m bathroom with a wall-sink, a floor-WC, and a free object.
function room() {
  const sink = makeObject({
    id: 'sink', category: 'sink', host: 'wall', host_id: 'w_s',
    transform: tf(1, 0.85, 0.1),
    dimensions: { width_m: 0.5, depth_m: 0.4, height_m: 0.3 },
  })
  const wc = makeObject({
    id: 'wc', category: 'toilet', host: 'floor', host_id: 'floor',
    transform: tf(3, 0, 1.5),
    dimensions: { width_m: 0.4, depth_m: 0.6, height_m: 0.4 },
  })
  const walls = [
    makeWall({ id: 'w_s', start_point: { x: 0, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 0 }, wall_mounted: [sink] }),
    makeWall({ id: 'w_e', start_point: { x: 4, y: 0, z: 0 }, end_point: { x: 4, y: 0, z: 3 } }),
    makeWall({ id: 'w_n', start_point: { x: 4, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 3 } }),
    makeWall({ id: 'w_w', start_point: { x: 0, y: 0, z: 3 }, end_point: { x: 0, y: 0, z: 0 } }),
  ]
  return makeRoom({ walls, floor: { ...makeRoom().floor, floor_mounted: [wc] } })
}

// ── §8.1 Hard-Reject ─────────────────────────────────────────────────────────

describe('validateComponentMove · §8.1 Hard-Reject', () => {
  it('rejects moving a wall — walls are immovable', () => {
    const op: EditOperation = { kind: 'move_node', node_id: 'w_s', new_transform: tf(1, 0, 1) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('WALL_IMMOVABLE')
  })

  it('rejects moving the floor or ceiling', () => {
    expect(
      validateComponentMove({ kind: 'move_node', node_id: 'floor', new_transform: tf(0, 0, 0) }, room()).error?.code,
    ).toBe('WALL_IMMOVABLE')
    expect(
      validateComponentMove({ kind: 'move_node', node_id: 'ceiling', new_transform: tf(0, 0, 0) }, room()).error?.code,
    ).toBe('WALL_IMMOVABLE')
  })

  it('rejects a move_node onto a non-existent node', () => {
    const r = validateComponentMove({ kind: 'move_node', node_id: 'ghost', new_transform: tf(1, 0, 1) }, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('NODE_NOT_FOUND')
  })

  it('rejects a floor object lifted off the floor plane', () => {
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(3, 0.4, 1.5) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FLOOR_OBJECT_OFF_PLANE')
  })

  it('rejects a wall object sunk past the wall plane', () => {
    // Sink hosted on w_s (centerline at z=0, thickness 0.2 → face at z=±0.1).
    // Moving the sink centre onto the centerline sinks it into the wall mass.
    const op: EditOperation = { kind: 'move_node', node_id: 'sink', new_transform: tf(1, 0.85, 0) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('WALL_OBJECT_OFF_PLANE')
  })

  it('rejects an object moved outside the room bounds', () => {
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(99, 0, 99) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('OUTSIDE_ROOM_BOUNDS')
  })

  it('F7 — rejects a large object whose CENTRE is inside but FOOTPRINT pokes out', () => {
    // 2 m × 2 m free object; room is (0..4, 0..3). Centre at x=0.1 → footprint
    // half-extent 1 m reaches x=−0.9, well outside bounds_min.x=0. The legacy
    // centre-only check would PASS this; the footprint check rejects it.
    const big = makeObject({
      id: 'big', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(0.1, 0, 1.5), dimensions: { width_m: 2, depth_m: 2, height_m: 0.5 },
    })
    const base = room()
    const scene = makeRoom({ walls: base.walls, free_objects: [big] })
    const r = validateComponentMove(
      { kind: 'move_node', node_id: 'big', new_transform: tf(0.1, 0, 1.5) },
      scene,
    )
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('OUTSIDE_ROOM_BOUNDS')
  })

  it('F7 — rejects a rotated object whose rotated footprint corner leaves the room', () => {
    // 1.6 m × 0.4 m object centred near the +X wall, rotated 45°: the rotated
    // footprint diagonal reaches ~ ±0.83 m on X, so a centre at x=3.5 puts a
    // corner past bounds_max.x=4. Axis-aligned the same object would fit.
    const rot45 = fromEuler(0, Math.PI / 4, 0)
    const slab = makeObject({
      id: 'slab', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(3.5, 0, 1.5, rot45),
      dimensions: { width_m: 1.6, depth_m: 0.4, height_m: 0.5 },
    })
    const base = room()
    const scene = makeRoom({ walls: base.walls, free_objects: [slab] })
    const r = validateComponentMove(
      { kind: 'move_node', node_id: 'slab', new_transform: tf(3.5, 0, 1.5, rot45) },
      scene,
    )
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('OUTSIDE_ROOM_BOUNDS')
  })

  it('F7 — accepts an object whose whole footprint sits inside the room', () => {
    const ok = makeObject({
      id: 'okobj', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(2, 0, 1.5), dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.5 },
    })
    const base = room()
    const scene = makeRoom({ walls: base.walls, free_objects: [ok] })
    const r = validateComponentMove(
      { kind: 'move_node', node_id: 'okobj', new_transform: tf(2, 0, 1.5) },
      scene,
    )
    expect(r.ok).toBe(true)
  })

  it('rejects add_door referencing a missing host wall', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_x', type: 'door' })
    const r = validateComponentMove({ kind: 'add_door', wall_id: 'w_x', door }, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DOOR_HOST_WALL_MISSING')
  })

  it('rejects add_door that does not fit the wall length', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 3.8, width_m: 0.9 })
    const r = validateComponentMove({ kind: 'add_door', wall_id: 'w_s', door }, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DOOR_OUTSIDE_WALL')
  })

  it('rejects add_door taller than the wall', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', height_m: 9, offset_from_floor_m: 0 })
    const r = validateComponentMove({ kind: 'add_door', wall_id: 'w_s', door }, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('WINDOW_ABOVE_WALL')
  })

  it('rejects a window opening dragged below the floor', () => {
    // w_e spans (4,0,0)→(4,0,3); window centre dragged to y=0.2 with height 1
    // → derived sill = 0.2 - 0.5 = -0.3 m, below the floor (F9: transform-driven).
    const win = makeOpening({ id: 'win1', host_wall_id: 'w_e', type: 'window', offset_along_wall_m: 1, offset_from_floor_m: 0.9, width_m: 1, height_m: 1 })
    const walls = room().walls.map((w) => (w.id === 'w_e' ? { ...w, openings: [win] } : w))
    const scene = makeRoom({ walls })
    const r = validateComponentMove({ kind: 'move_node', node_id: 'win1', new_transform: tf(4, 0.2, 1.5) }, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('WINDOW_BELOW_FLOOR')
  })

  it('F9 — rejects a door dragged past the wall end via move_node', () => {
    // w_s spans (0,0,0)→(4,0,0), length 4. The door sits legally at offset 1.
    // A move_node carrying a transform near the +X end (centre x=3.9) derives
    // offset = 3.9 − 0.45 = 3.45 → left edge + 0.9 width = 4.35 > 4 → reject.
    // The stale stored offset_along_wall_m=1 would WRONGLY pass under the bug.
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 1, width_m: 0.9, offset_from_floor_m: 0, height_m: 2 })
    const walls = room().walls.map((w) => (w.id === 'w_s' ? { ...w, openings: [door] } : w))
    const scene = makeRoom({ walls })
    const r = validateComponentMove({ kind: 'move_node', node_id: 'd1', new_transform: tf(3.9, 1, 0) }, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DOOR_OUTSIDE_WALL')
  })

  it('F9 — rejects a door dragged before the wall start via move_node', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 1, width_m: 0.9, offset_from_floor_m: 0, height_m: 2 })
    const walls = room().walls.map((w) => (w.id === 'w_s' ? { ...w, openings: [door] } : w))
    const scene = makeRoom({ walls })
    // Centre at x=−0.2 → offset = −0.2 − 0.45 = −0.65 < 0 → reject.
    const r = validateComponentMove({ kind: 'move_node', node_id: 'd1', new_transform: tf(-0.2, 1, 0) }, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DOOR_OUTSIDE_WALL')
  })

  it('F9 — accepts a door move_node that keeps the door within the wall', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 1, width_m: 0.9, offset_from_floor_m: 0, height_m: 2 })
    const walls = room().walls.map((w) => (w.id === 'w_s' ? { ...w, openings: [door] } : w))
    const scene = makeRoom({ walls })
    // Centre at x=2 → offset = 2 − 0.45 = 1.55, left+width = 2.45 ≤ 4 → ok.
    const r = validateComponentMove({ kind: 'move_node', node_id: 'd1', new_transform: tf(2, 1, 0) }, scene)
    expect(r.ok).toBe(true)
  })

  it('rejects move_pin to a missing anchor surface', () => {
    const pin = makePin({ id: 'p1', anchor_surface_id: 'w_s', anchor_surface_type: 'wall', pin_type: 'damage' })
    const scene = makeRoom({ pins: [pin] })
    const op: EditOperation = {
      kind: 'move_pin',
      pin_id: 'p1',
      new_anchor: {
        anchor_surface_id: 'ghost', anchor_surface_type: 'wall',
        anchor_uv: { u: 0.5, v: 0.5 }, anchor_offset_normal_m: 0.01,
      },
    }
    const r = validateComponentMove(op, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('PIN_ANCHOR_MISSING')
  })

  it('rejects move_pin with a UV outside [0,1]²', () => {
    const pin = makePin({ id: 'p1', anchor_surface_id: 'w_s', anchor_surface_type: 'wall', pin_type: 'damage' })
    const scene = makeRoom({ pins: [pin] })
    const op: EditOperation = {
      kind: 'move_pin',
      pin_id: 'p1',
      new_anchor: {
        anchor_surface_id: 'w_s', anchor_surface_type: 'wall',
        anchor_uv: { u: 1.5, v: 0.5 }, anchor_offset_normal_m: 0.01,
      },
    }
    const r = validateComponentMove(op, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('PIN_UV_OUT_OF_RANGE')
  })

  it('rejects resize_wall with a non-positive height', () => {
    const r = validateComponentMove(
      { kind: 'resize_wall', wall_id: 'w_s', new_height_m: 0, new_thickness_m: 0.2 },
      room(),
    )
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_DIMENSION')
  })

  it('rejects set_room_height with a non-finite height', () => {
    const r = validateComponentMove(
      { kind: 'set_room_height', room_id: 'room', new_height_m: Number.NaN },
      room(),
    )
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_DIMENSION')
  })

  it('rejects snap_object onto a missing wall host', () => {
    const op: EditOperation = {
      kind: 'snap_object',
      object_id: 'wc', new_host: 'wall', new_host_id: 'w_x',
      new_transform: tf(1, 0.5, 0.1),
    }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('DOOR_HOST_WALL_MISSING')
  })
})

// ── §8.2 Soft-Warn ───────────────────────────────────────────────────────────

describe('validateComponentMove · §8.2 Soft-Warn (warn but allow)', () => {
  it('warns — but allows — when two objects encroach on clearance buffers', () => {
    // F8: footprints do NOT overlap (gap on X) but sit inside each other's
    // 0.2 m clearance buffer → soft-warn, edit still allowed.
    // wc footprint 0.4×0.6 centred at x=2; box footprint 0.5×0.5 centred at
    // x=2.55 → 0.55 m centre-gap, half-extents 0.2+0.25 = 0.45 m → 0.1 m
    // actual gap (no overlap) but well inside the buffered 0.85 m.
    const free = makeObject({
      id: 'box', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(2.55, 0, 1.5), dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.5 },
    })
    const base = room()
    const scene = makeRoom({ walls: base.walls, floor: { ...base.floor, floor_mounted: base.floor.floor_mounted }, free_objects: [free] })
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(2, 0, 1.5) }
    const r = validateComponentMove(op, scene)
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === 'OBJECT_CLEARANCE_VIOLATED')).toBe(true)
    expect(needsConfirm(r.warnings)).toBe(true)
  })

  it('hard-rejects — F8 — when two object footprints geometrically interpenetrate', () => {
    // Move wc directly onto the free box's position: footprints overlap.
    const free = makeObject({
      id: 'box', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(2, 0, 1.5), dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.5 },
    })
    const base = room()
    const scene = makeRoom({ walls: base.walls, floor: { ...base.floor, floor_mounted: base.floor.floor_mounted }, free_objects: [free] })
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(2, 0, 1.5) }
    const r = validateComponentMove(op, scene)
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('OBJECT_OVERLAP')
  })

  it('warns when a wall-mounted object sits near a corner', () => {
    // Move the sink to offset 0.1 m along w_s (corner is at offset 0).
    const op: EditOperation = { kind: 'move_node', node_id: 'sink', new_transform: tf(0.1, 0.85, 0.1) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === 'WALL_OBJECT_NEAR_CORNER')).toBe(true)
  })

  it('warns when add_door sits within 0.2 m of a wall corner', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 0.05, width_m: 0.9 })
    const r = validateComponentMove({ kind: 'add_door', wall_id: 'w_s', door }, room())
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === 'DOOR_NEAR_CORNER')).toBe(true)
  })

  it('warns when a window sill is below 0.3 m', () => {
    // w_e spans (4,0,0)→(4,0,3); window centre at y=0.65 with height 1
    // → derived sill = 0.65 - 0.5 = 0.15 m, above the floor but below 0.3 m.
    const win = makeOpening({ id: 'win1', host_wall_id: 'w_e', type: 'window', offset_along_wall_m: 1, offset_from_floor_m: 0.9, width_m: 1, height_m: 1 })
    const walls = room().walls.map((w) => (w.id === 'w_e' ? { ...w, openings: [win] } : w))
    const scene = makeRoom({ walls })
    const r = validateComponentMove({ kind: 'move_node', node_id: 'win1', new_transform: tf(4, 0.65, 1.5) }, scene)
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === 'WINDOW_SILL_TOO_LOW')).toBe(true)
  })

  it('warns when furniture blocks a door pass-through', () => {
    const door = makeOpening({ id: 'd1', host_wall_id: 'w_s', type: 'door', offset_along_wall_m: 1.5, width_m: 0.9 })
    const walls = room().walls.map((w) => (w.id === 'w_s' ? { ...w, openings: [door] } : w))
    const blocker = makeObject({
      id: 'box', category: 'generic_cuboid', host: 'free', host_id: 'floor',
      transform: tf(1.95, 0, 0.4), dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.5 },
    })
    const scene = makeRoom({ walls, free_objects: [blocker] })
    const op: EditOperation = { kind: 'move_node', node_id: 'box', new_transform: tf(1.95, 0, 0.4) }
    const r = validateComponentMove(op, scene)
    expect(r.ok).toBe(true)
    expect(r.warnings.some((w) => w.code === 'DOOR_BLOCKED_BY_OBJECT')).toBe(true)
  })

  it('a clean move produces zero warnings and needsConfirm is false', () => {
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(3.2, 0, 2.2) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([])
    expect(needsConfirm(r.warnings)).toBe(false)
  })
})

// ── §8.3 Auto-Snap ───────────────────────────────────────────────────────────

describe('validateComponentMove · §8.3 Auto-Snap', () => {
  it('snaps a floor object dropped just above the plane down to y=0', () => {
    const op: EditOperation = { kind: 'move_node', node_id: 'wc', new_transform: tf(3, 0.03, 1.5) }
    const r = validateComponentMove(op, room())
    expect(r.ok).toBe(true)
    expect(r.correctedTransform).toBeDefined()
    expect(r.correctedTransform!.position.y).toBeCloseTo(0, 6)
  })

  it('snaps a wall object within 0.15 m of the wall flush onto the surface', () => {
    // Sink on w_s; place it 0.1 m off the face (z = thickness/2 + 0.1).
    const scene = room()
    const obj = scene.walls[0].wall_mounted[0]
    const snapped = autoSnapObjectTransform(obj, tf(1, 0.85, scene.walls[0].thickness_m / 2 + 0.1), scene)
    expect(snapped).not.toBeNull()
    // After snap the object sits flush — distance to the wall face ≈ 0.
    expect(Math.abs(snapped!.position.z - scene.walls[0].thickness_m / 2)).toBeLessThan(1e-6)
  })

  it('does not snap a floor object that is already on the plane', () => {
    const wc = room().floor.floor_mounted[0]
    expect(autoSnapObjectTransform(wc, tf(3, 0, 1.5), room())).toBeNull()
  })

  it('snaps a near-15°-step rotation onto the step', () => {
    const off = fromEuler(0, (14.3 * Math.PI) / 180, 0)
    const snapped = snapRotationTo15Deg(off)
    expect(snapped).not.toBeNull()
  })

  it('leaves an exact 15° rotation untouched', () => {
    const exact = fromEuler(0, (30 * Math.PI) / 180, 0)
    expect(snapRotationTo15Deg(exact)).toBeNull()
  })
})

// ── operation generalisation ─────────────────────────────────────────────────

describe('validateComponentMove · operation generalisation', () => {
  it('accepts set_material unconditionally (no geometric constraint)', () => {
    const r = validateComponentMove(
      { kind: 'set_material', node_id: 'w_s', surface: 'wall', material_id: 'm_x' },
      room(),
    )
    expect(r.ok).toBe(true)
  })

  it('accepts delete_node unconditionally', () => {
    const r = validateComponentMove({ kind: 'delete_node', node_id: 'sink' }, room())
    expect(r.ok).toBe(true)
  })

  it('accepts a legal resize_wall', () => {
    const r = validateComponentMove(
      { kind: 'resize_wall', wall_id: 'w_s', new_height_m: 2.8, new_thickness_m: 0.2 },
      room(),
    )
    expect(r.ok).toBe(true)
  })

  it('warns on resize_wall that would orphan a window above the new height', () => {
    const win: WallOpening = makeOpening({
      id: 'win1', host_wall_id: 'w_s', type: 'window', offset_from_floor_m: 2.0, height_m: 1.0,
    })
    const walls = room().walls.map((w) => (w.id === 'w_s' ? { ...w, openings: [win] } : w))
    const scene = makeRoom({ walls })
    const r = validateComponentMove(
      { kind: 'resize_wall', wall_id: 'w_s', new_height_m: 2.4, new_thickness_m: 0.2 },
      scene,
    )
    expect(r.ok).toBe(true)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})
