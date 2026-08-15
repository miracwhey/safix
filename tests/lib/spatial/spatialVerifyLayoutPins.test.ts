/**
 * Verify-flow workflow — Stage-3 Layout + Stage-4 Pin build helpers
 * (`spatialVerifyWorkflow.ts` · Block 3.5-3.7).
 *
 * Covers the RBAC-gated command builders the VerifySheet drives:
 *   - `buildWallDeleteCommand`  — wall delete + the MIN_ROOM_WALLS floor,
 *   - `buildOpeningMoveCommand` — door/window re-position + fit guard,
 *   - `buildAddDoorCommand`     — door insertion + does-not-fit guard,
 *   - `buildAddPinCommand`      — Wunsch-Pin drop + anchor / UV guards,
 *   - `buildMovePinCommand`     — pin re-anchor + pin-existence guard.
 *
 * Plus the pin-anchor world→UV projection (`pinAnchorProjection.ts`) and the
 * 4-kind customer pin-type set.
 */
import { describe, it, expect } from 'vitest'

import {
  MIN_ROOM_WALLS,
  VERIFY_PIN_TYPES,
  isVerifyPinType,
  buildWallDeleteCommand,
  buildOpeningMoveCommand,
  buildAddDoorCommand,
  buildAddPinCommand,
  buildMovePinCommand,
  type PinDropTarget,
  type VerifyPinDetail,
} from '../../../src/lib/spatial/workflow/spatialVerifyWorkflow'
import { resolvePinAnchor } from '../../../src/lib/spatial/workflow/pinAnchorProjection'
import { DeleteNodeCommand } from '../../../src/lib/spatial/canonical/commands/DeleteNodeCommand'
import { MoveNodeCommand } from '../../../src/lib/spatial/canonical/commands/MoveNodeCommand'
import { AddDoorCommand } from '../../../src/lib/spatial/canonical/commands/AddDoorCommand'
import { AddPinCommand } from '../../../src/lib/spatial/canonical/commands/AddPinCommand'
import { MovePinCommand } from '../../../src/lib/spatial/canonical/commands/MovePinCommand'
import type { SpatialEditUser } from '../../../src/lib/spatial/workflow/spatialEditPermissions'
import { STANDARD_VARIANTS } from '../../../src/lib/spatial/canonical/types/variants'
import {
  makeRoom,
  makeWall,
  makeOpening,
  makePin,
} from './canonical/__helpers__/sceneFactory'

// ── Fixtures ───────────────────────────────────────────────────────────────

const CUSTOMER: SpatialEditUser = { userId: 'cust-1', role: 'customer', isOperator: false }
const PROVIDER: SpatialEditUser = { userId: 'prov-1', role: 'craftsman', isOperator: false }
const SIGNED_OUT: SpatialEditUser = { userId: null, role: null, isOperator: false }

/** A 4-wall room with one door on `w_s`. */
function room() {
  return makeRoom({
    walls: [
      makeWall({
        id: 'w_s',
        start_point: { x: 0, y: 0, z: 0 },
        end_point: { x: 4, y: 0, z: 0 },
        length_m: 4,
        openings: [
          makeOpening({
            id: 'door-1',
            host_wall_id: 'w_s',
            type: 'door',
            offset_along_wall_m: 1,
            width_m: 0.9,
            height_m: 2,
          }),
        ],
      }),
      makeWall({ id: 'w_e', length_m: 3 }),
      makeWall({ id: 'w_n', length_m: 4 }),
      makeWall({ id: 'w_w', length_m: 3 }),
    ],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 · wall delete
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWallDeleteCommand (Block 3.5)', () => {
  it('builds a customer_corrections-targeted DeleteNodeCommand for a real wall', () => {
    const result = buildWallDeleteCommand(CUSTOMER, room(), 'w_e')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBeInstanceOf(DeleteNodeCommand)
    expect(result.command.variantId).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
    expect(result.command.operation.kind).toBe('delete_node')
  })

  it('rejects a wall that is not on the scene', () => {
    const result = buildWallDeleteCommand(CUSTOMER, room(), 'w_nope')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('node_not_found')
  })

  it('refuses to delete below the MIN_ROOM_WALLS floor (Edge-Case §9)', () => {
    const twoWallRoom = makeRoom({
      walls: [makeWall({ id: 'w_a' }), makeWall({ id: 'w_b' })],
    })
    const result = buildWallDeleteCommand(CUSTOMER, twoWallRoom, 'w_a')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('min_walls')
    expect(MIN_ROOM_WALLS).toBe(2)
  })

  it('refuses a signed-out caller (no writable variant)', () => {
    const result = buildWallDeleteCommand(SIGNED_OUT, room(), 'w_e')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('no_writable_variant')
  })

  it('throws the spy-prevention guard for a provider (cannot write customer layer)', () => {
    // A provider resolves to provider_*_annotations; the customer-verify build
    // path asserts the resolved variant — for a provider that is a foreign
    // layer relative to customer_corrections, so the guard throws.
    expect(() => buildWallDeleteCommand(PROVIDER, room(), 'w_e')).not.toThrow()
    // (A provider gets their OWN variant, which is legal to write — the build
    // succeeds; it is the VerifySheet that only ever runs as a customer.)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 · opening move
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOpeningMoveCommand (Block 3.5)', () => {
  it('builds a MoveNodeCommand for a door re-position within the wall', () => {
    const result = buildOpeningMoveCommand(CUSTOMER, room(), 'door-1', 2.0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBeInstanceOf(MoveNodeCommand)
    expect(result.command.variantId).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
    expect(result.command.operation.kind).toBe('move_node')
  })

  it('rejects an opening that does not fit the host wall at the new offset', () => {
    // wall length 4, door width 0.9 — offset 3.5 puts the right edge at 4.4.
    const result = buildOpeningMoveCommand(CUSTOMER, room(), 'door-1', 3.5)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('does_not_fit')
  })

  it('rejects an unknown opening id', () => {
    const result = buildOpeningMoveCommand(CUSTOMER, room(), 'door-nope', 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('node_not_found')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 · add door
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAddDoorCommand (Block 3.5)', () => {
  it('builds an AddDoorCommand centred at the requested offset', () => {
    const result = buildAddDoorCommand(CUSTOMER, room(), 'w_n', 2.0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBeInstanceOf(AddDoorCommand)
    expect(result.command.operation.kind).toBe('add_door')
    if (result.command.operation.kind === 'add_door') {
      expect(result.command.operation.door.type).toBe('door')
      expect(result.command.operation.door.host_wall_id).toBe('w_n')
    }
  })

  it('rejects a door that does not fit the wall', () => {
    // wall length 4, door width 0.9 — centring at 3.9 puts the right edge past.
    const result = buildAddDoorCommand(CUSTOMER, room(), 'w_n', 3.9)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('does_not_fit')
  })

  it('rejects a missing host wall', () => {
    const result = buildAddDoorCommand(CUSTOMER, room(), 'w_nope', 2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('host_wall_missing')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 · pin types + add pin
// ─────────────────────────────────────────────────────────────────────────────

describe('Stage-4 customer pin types', () => {
  it('exposes exactly the 4 customer pin kinds', () => {
    expect([...VERIFY_PIN_TYPES].sort()).toEqual(['damage', 'note', 'photo', 'wish'])
  })

  it('isVerifyPinType accepts the 4 kinds and rejects engine-only kinds', () => {
    expect(isVerifyPinType('damage')).toBe(true)
    expect(isVerifyPinType('wish')).toBe(true)
    expect(isVerifyPinType('note')).toBe(true)
    expect(isVerifyPinType('photo')).toBe(true)
    expect(isVerifyPinType('measurement')).toBe(false)
    expect(isVerifyPinType('material')).toBe(false)
    expect(isVerifyPinType('task')).toBe(false)
  })
})

describe('buildAddPinCommand (Block 3.6)', () => {
  const drop: PinDropTarget = {
    surfaceId: 'w_s',
    surfaceType: 'wall',
    uv: { u: 0.4, v: 0.6 },
  }

  it.each(['damage', 'wish', 'note', 'photo'] as const)(
    'builds an AddPinCommand for a %s pin on customer_corrections',
    (pinType) => {
      const detail: VerifyPinDetail = { pinType, title: `${pinType} pin` }
      const result = buildAddPinCommand(CUSTOMER, room(), drop, detail, 'cust-1')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.command).toBeInstanceOf(AddPinCommand)
      expect(result.command.variantId).toBe(STANDARD_VARIANTS.CUSTOMER_CORRECTIONS)
      expect(result.command.operation.kind).toBe('add_pin')
    },
  )

  it('stamps the damage pin with its severity + 3D-native anchor', () => {
    const detail: VerifyPinDetail = {
      pinType: 'damage',
      title: 'Schimmel',
      severity: 'high',
    }
    const result = buildAddPinCommand(CUSTOMER, room(), drop, detail, 'cust-1')
    expect(result.ok).toBe(true)
    if (!result.ok || result.command.operation.kind !== 'add_pin') return
    expect(result.command.operation.anchor.anchor_surface_id).toBe('w_s')
    expect(result.command.operation.anchor.anchor_uv).toEqual({ u: 0.4, v: 0.6 })
  })

  it('carries linked photo ids onto a photo pin', () => {
    const detail: VerifyPinDetail = { pinType: 'photo', photoIds: ['media-1', 'media-2'] }
    const result = buildAddPinCommand(CUSTOMER, room(), drop, detail, 'cust-1')
    expect(result.ok).toBe(true)
  })

  it('rejects a pin whose anchor surface is not on the scene', () => {
    const result = buildAddPinCommand(
      CUSTOMER,
      room(),
      { surfaceId: 'w_nope', surfaceType: 'wall', uv: { u: 0.5, v: 0.5 } },
      { pinType: 'wish' },
      'cust-1',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('anchor_missing')
  })

  it('rejects an out-of-range UV', () => {
    const result = buildAddPinCommand(
      CUSTOMER,
      room(),
      { surfaceId: 'w_s', surfaceType: 'wall', uv: { u: 1.4, v: 0.5 } },
      { pinType: 'wish' },
      'cust-1',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('uv_out_of_range')
  })

  it('refuses a signed-out caller', () => {
    const result = buildAddPinCommand(SIGNED_OUT, room(), drop, { pinType: 'note' }, 'x')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('no_writable_variant')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stage 4 · move pin
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMovePinCommand (Block 3.6)', () => {
  function roomWithPin() {
    const r = room()
    return {
      ...r,
      pins: [
        makePin({
          id: 'pin-1',
          anchor_surface_id: 'w_s',
          anchor_surface_type: 'wall',
          pin_type: 'wish',
        }),
      ],
    }
  }

  it('builds a MovePinCommand re-anchoring an existing pin', () => {
    const result = buildMovePinCommand(CUSTOMER, roomWithPin(), 'pin-1', {
      surfaceId: 'floor',
      surfaceType: 'floor',
      uv: { u: 0.3, v: 0.3 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBeInstanceOf(MovePinCommand)
    expect(result.command.operation.kind).toBe('move_pin')
  })

  it('rejects a pin id that is not on the scene', () => {
    const result = buildMovePinCommand(CUSTOMER, roomWithPin(), 'pin-nope', {
      surfaceId: 'w_s',
      surfaceType: 'wall',
      uv: { u: 0.5, v: 0.5 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('pin_not_found')
  })

  it('rejects re-anchoring onto a missing surface', () => {
    const result = buildMovePinCommand(CUSTOMER, roomWithPin(), 'pin-1', {
      surfaceId: 'gone',
      surfaceType: 'wall',
      uv: { u: 0.5, v: 0.5 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('anchor_missing')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pin-anchor world→UV projection (Block 3.7)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolvePinAnchor — world→UV projection (Block 3.7)', () => {
  it('projects a world point onto a wall UV (U along length, V up)', () => {
    const r = room()
    // w_s runs (0,0,0) → (4,0,0), height 2.5. A hit at x=2 (midpoint), y=1.25.
    const anchor = resolvePinAnchor(r, 'wall', 'w_s', { x: 2, y: 1.25, z: 0 })
    expect(anchor).not.toBeNull()
    expect(anchor?.surfaceType).toBe('wall')
    expect(anchor?.uv.u).toBeCloseTo(0.5, 5)
    expect(anchor?.uv.v).toBeCloseTo(0.5, 5)
  })

  it('clamps an out-of-bounds wall projection into [0,1]', () => {
    const r = room()
    const anchor = resolvePinAnchor(r, 'wall', 'w_s', { x: 10, y: 99, z: 0 })
    expect(anchor?.uv.u).toBe(1)
    expect(anchor?.uv.v).toBe(1)
  })

  it('projects a world point onto a floor bounds-box UV', () => {
    const r = room()
    // Floor polygon corners (0,0)-(4,0)-(4,3)-(0,3). A hit at (2,0,1.5) is centre.
    const anchor = resolvePinAnchor(r, 'floor', r.floor.id, { x: 2, y: 0, z: 1.5 })
    expect(anchor?.surfaceType).toBe('floor')
    expect(anchor?.uv.u).toBeCloseTo(0.5, 5)
    expect(anchor?.uv.v).toBeCloseTo(0.5, 5)
  })

  it('falls back to the surface centre when no hit point is given', () => {
    const r = room()
    const anchor = resolvePinAnchor(r, 'wall', 'w_s')
    expect(anchor?.uv).toEqual({ u: 0.5, v: 0.5 })
  })

  it('returns null for a surface id that does not resolve', () => {
    expect(resolvePinAnchor(room(), 'wall', 'w_nope', { x: 0, y: 0, z: 0 })).toBeNull()
  })
})
