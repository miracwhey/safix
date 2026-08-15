/**
 * Tests for src/lib/spatial/canonical/bridge/scanToParametric.ts (Day 8 B13).
 *
 * Synthetic factory-built fixtures only (no JSON files). Each test
 * round-trips a small Block-A scan through the bridge and asserts a single
 * canonical-side property:
 *
 *   1. Rectangular bathroom round-trips with no warnings.
 *   2. Door surface → WallOpening with correct host_wall_id + confidence 1.0.
 *   3. Wall-doubling detected → warning when `collapseWallDoublings: false`,
 *      and second-of-pair is dropped when true (H28 audit-fix).
 *   4. Pin annotation → canonical Pin with resolved anchor + ISO timestamp.
 *   5. Wall-mounted object (sink at floor-plane but flush with wall) →
 *      SpatialObject with `host: 'wall'` + correct `host_id` (H27 audit-fix).
 *   6. Ceiling-mounted object (light at y ≈ ceilingH) → host: 'ceiling'.
 */
import { describe, it, expect } from 'vitest'

import { scanToParametric } from '../../../../../src/lib/spatial/canonical/bridge/scanToParametric.ts'
import type {
  Scan,
  ScanAnnotation,
  ScanMeasurement,
  ScanRoom,
  ScanSurface,
} from '../../../../../src/lib/spatial/types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Factories — minimal Block-A objects with sensible defaults.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1716163200000 // 2024-05-20T00:00:00.000Z (any stable epoch)

function makeScan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: 'scan_1',
    jobId: null,
    projectId: 'project_1',
    parentScanId: null,
    status: 'captured',
    source: 'roomplan',
    capturedBy: 'user_1',
    deviceMeta: {},
    scanStartedAt: NOW,
    scanEndedAt: NOW + 60_000,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 60_000,
    ...overrides,
  }
}

function makeRoom(overrides: Partial<ScanRoom> = {}): ScanRoom {
  return {
    id: 'room_1',
    scanId: 'scan_1',
    name: 'Bathroom',
    areaM2Estimated: 12,
    areaM2Verified: null,
    ceilingHEstimated: 2.5,
    ceilingHVerified: null,
    floorAnchor: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

interface WallSpec {
  id: string
  externalId: string
  /** Centerpoint world-XYZ. */
  cx: number
  cz: number
  /** Width along the wall axis (m). */
  width: number
  /** Height (m). */
  height: number
  /** Rotation around world Y in radians (0 = wall axis along world +X). */
  rotYRad: number
}

function makeWallSurface(spec: WallSpec): ScanSurface {
  return {
    id: spec.id,
    roomId: 'room_1',
    surfaceExternalId: spec.externalId,
    kind: 'wall',
    dimWEstimated: spec.width,
    dimHEstimated: spec.height,
    dimWVerified: spec.width,
    dimHVerified: spec.height,
    transform: { position: { x: spec.cx, y: 0, z: spec.cz }, rotationYRad: spec.rotYRad },
    status: 'estimated_roomplan',
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/**
 * Rectangular 4-wall bathroom (4m × 3m).
 *
 * Wall layout (looking down at the room from +Y):
 *
 *   z=3 ┌─────────────┐
 *       │    w_n      │
 *  w_w  │             │  w_e
 *       │    w_s      │
 *   z=0 └─────────────┘
 *      x=0           x=4
 *
 * For wall direction conventions:
 *   - w_s: x=0 → x=4 at z=0 (rotYRad=0; centerpoint (2,0,0))
 *   - w_e: z=0 → z=3 at x=4 (rotYRad=-π/2; axis=(cos,0,-sin) = (0,0,1); centerpoint (4,0,1.5))
 *   - w_n: x=4 → x=0 at z=3 (rotYRad=π; axis=(-1,0,0); centerpoint (2,0,3))
 *   - w_w: z=3 → z=0 at x=0 (rotYRad=π/2; axis=(0,0,-1); centerpoint (0,0,1.5))
 */
function makeRectangularBathroomWalls(): WallSpec[] {
  return [
    { id: 'w_s', externalId: 'ext_w_s', cx: 2, cz: 0, width: 4, height: 2.5, rotYRad: 0 },
    { id: 'w_e', externalId: 'ext_w_e', cx: 4, cz: 1.5, width: 3, height: 2.5, rotYRad: -Math.PI / 2 },
    { id: 'w_n', externalId: 'ext_w_n', cx: 2, cz: 3, width: 4, height: 2.5, rotYRad: Math.PI },
    { id: 'w_w', externalId: 'ext_w_w', cx: 0, cz: 1.5, width: 3, height: 2.5, rotYRad: Math.PI / 2 },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('scanToParametric · single-room rectangular bathroom', () => {
  it('round-trips 4 walls + floor + ceiling with no warnings', () => {
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [],
    })
    expect(result.scene.walls).toHaveLength(4)
    expect(result.scene.floor.polygon).toHaveLength(4)
    expect(result.scene.ceiling.polygon).toHaveLength(4)
    expect(result.scene.ceiling.height_m).toBe(2.5)
    expect(result.scene.computed_area_m2).toBeGreaterThan(11.9)
    expect(result.scene.computed_area_m2).toBeLessThan(12.1)
    expect(result.warnings).toEqual([])
  })
})

describe('scanToParametric · doors', () => {
  it('maps a door surface to a WallOpening with host_wall_confidence = 1', () => {
    const scan = makeScan()
    const room = makeRoom()
    const wallSpecs = makeRectangularBathroomWalls()
    const walls = wallSpecs.map(makeWallSurface)
    // Door centroid lives ON the south wall (z = 0), near x = 1.5.
    // y = 1 (door bottom at floor, top at ~2 m, so centroid ≈ height_m/2).
    const door: ScanSurface = {
      id: 'door_1',
      roomId: 'room_1',
      surfaceExternalId: 'ext_door_1',
      kind: 'door',
      dimWEstimated: 0.9,
      dimHEstimated: 2,
      dimWVerified: null,
      dimHVerified: null,
      transform: { position: { x: 1.5, y: 1, z: 0 }, rotationYRad: 0 },
      status: 'estimated_roomplan',
      confidence: 0.9,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: [...walls, door],
      measurements: [],
      annotations: [],
    })
    expect(result.scene.walls).toHaveLength(4)
    const openings = result.scene.walls.flatMap(w => w.openings)
    expect(openings).toHaveLength(1)
    const opening = openings[0]
    expect(opening.type).toBe('door')
    expect(opening.host_wall_id).toBe('w_s')
    expect(opening.host_wall_confidence).toBe(1)
    expect(opening.width_m).toBeCloseTo(0.9)
    expect(opening.is_walkable_portal).toBe(true)
  })
})

describe('scanToParametric · wall-doubling (H28 audit-fix)', () => {
  it('emits a warning per detected pair when collapseWallDoublings is false', () => {
    const scan = makeScan()
    const room = makeRoom()
    // Build a "doubled" pair: two parallel walls 5 cm apart.
    const walls: ScanSurface[] = [
      makeWallSurface({ id: 'w_a', externalId: 'ext_w_a', cx: 2, cz: 0, width: 4, height: 2.5, rotYRad: 0 }),
      // Second wall: same direction (parallel normal), centerline 0.05 m further out.
      makeWallSurface({ id: 'w_b', externalId: 'ext_w_b', cx: 2, cz: -0.05, width: 4, height: 2.5, rotYRad: 0 }),
      // Other 3 walls to close the room.
      makeWallSurface({ id: 'w_e', externalId: 'ext_w_e', cx: 4, cz: 1.5, width: 3, height: 2.5, rotYRad: -Math.PI / 2 }),
      makeWallSurface({ id: 'w_n', externalId: 'ext_w_n', cx: 2, cz: 3, width: 4, height: 2.5, rotYRad: Math.PI }),
      makeWallSurface({ id: 'w_w', externalId: 'ext_w_w', cx: 0, cz: 1.5, width: 3, height: 2.5, rotYRad: Math.PI / 2 }),
    ]

    // First run: with collapseWallDoublings = false → 5 walls + WALL_DOUBLING_DETECTED warning.
    const detected = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [],
      options: { collapseWallDoublings: false },
    })
    expect(detected.scene.walls).toHaveLength(5)
    expect(detected.warnings.some(w => w.startsWith('WALL_DOUBLING_DETECTED'))).toBe(true)

    // Second run: with collapseWallDoublings = true (default) → 4 walls (second-of-pair dropped) + COLLAPSED warning.
    const collapsed = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [],
    })
    expect(collapsed.scene.walls).toHaveLength(4)
    expect(collapsed.warnings.some(w => w.startsWith('WALL_DOUBLING_COLLAPSED'))).toBe(true)
    // The first-of-pair (w_a) should survive; w_b should be gone.
    const survivingIds = collapsed.scene.walls.map(w => w.id).sort()
    expect(survivingIds).not.toContain('w_b')
    expect(survivingIds).toContain('w_a')
    // External-id for the dropped surface should map to the survivor.
    expect(collapsed.bridgeDefaults.surfaceExternalIdToNodeId['ext_w_b']).toBe('w_a')
  })
})

describe('scanToParametric · pin annotations', () => {
  it('maps a damage annotation to a canonical Pin with resolved anchor + ISO timestamps', () => {
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const annotation: ScanAnnotation = {
      id: 'pin_1',
      scanId: 'scan_1',
      kind: 'damage',
      anchorUv: { surfaceExternalId: 'ext_w_s', uv: [0.42, 0.71] },
      anchorWorldCache: null,
      anchorArHint: null,
      anchor2d: null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'high',
      photoAssetId: null,
      note: 'Cracked tile',
      status: 'open',
      gewerk: 'sanitär',
      offerRelevant: true,
      offerLineItemId: null,
      createdAt: NOW,
      updatedAt: NOW + 1000,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [annotation],
    })
    expect(result.scene.pins).toHaveLength(1)
    const pin = result.scene.pins[0]
    expect(pin.pin_type).toBe('damage')
    expect(pin.anchor_surface_id).toBe('w_s')
    expect(pin.anchor_surface_type).toBe('wall')
    expect(pin.anchor_uv.u).toBeCloseTo(0.42)
    expect(pin.anchor_uv.v).toBeCloseTo(0.71)
    expect(pin.title).toBe('Cracked tile')
    // Timestamp is ISO-8601.
    expect(pin.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(pin.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // BridgeDefaults exposes the resolution.
    expect(result.bridgeDefaults.surfaceExternalIdToNodeId['ext_w_s']).toBe('w_s')
  })
})

describe('scanToParametric · wall-mounted object (H27 audit-fix)', () => {
  it('detects host: wall for a sink flush with the south wall', () => {
    const scan = makeScan()
    const room = makeRoom()
    const wallSpecs = makeRectangularBathroomWalls()
    const walls = wallSpecs.map(makeWallSurface)
    // Sink: centroid at (1.5, 0.85, 0.05) — basically against the south wall
    // (z ≈ 0), elevated to 0.85 m off the floor.
    const sink: ScanSurface = {
      id: 'obj_sink',
      roomId: 'room_1',
      surfaceExternalId: 'ext_sink',
      kind: 'object',
      dimWEstimated: 0.6,
      dimHEstimated: 0.4,
      dimWVerified: null,
      dimHVerified: null,
      transform: { position: { x: 1.5, y: 0.85, z: 0.05 }, rotationYRad: 0 },
      status: 'estimated_roomplan',
      confidence: 0.8,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: [...walls, sink],
      measurements: [],
      annotations: [],
    })
    const wallSouth = result.scene.walls.find(w => w.id === 'w_s')
    expect(wallSouth).toBeDefined()
    const sinkObj =
      wallSouth?.wall_mounted.find(o => o.id === 'obj_sink')
    expect(sinkObj).toBeDefined()
    expect(sinkObj?.host).toBe('wall')
    expect(sinkObj?.host_id).toBe('w_s')
    expect(sinkObj?.height_from_floor_m).toBeGreaterThan(0)
    // Sanity: floor.floor_mounted should NOT contain it.
    expect(result.scene.floor.floor_mounted.find(o => o.id === 'obj_sink')).toBeUndefined()
    expect(result.scene.free_objects.find(o => o.id === 'obj_sink')).toBeUndefined()
  })
})

describe('scanToParametric · ceiling-mounted object', () => {
  it('detects host: ceiling for a lamp at y ≈ ceiling height', () => {
    const scan = makeScan()
    const room = makeRoom()
    const wallSpecs = makeRectangularBathroomWalls()
    const walls = wallSpecs.map(makeWallSurface)
    const lamp: ScanSurface = {
      id: 'obj_lamp',
      roomId: 'room_1',
      surfaceExternalId: 'ext_lamp',
      kind: 'object',
      dimWEstimated: 0.3,
      dimHEstimated: 0.2,
      dimWVerified: null,
      dimHVerified: null,
      // Lamp hangs from the ceiling: centroid at (2, 2.5, 1.5).
      transform: { position: { x: 2, y: 2.5, z: 1.5 }, rotationYRad: 0 },
      status: 'estimated_roomplan',
      confidence: 0.7,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: [...walls, lamp],
      measurements: [],
      annotations: [],
    })
    const lampObj = result.scene.ceiling.ceiling_mounted.find(o => o.id === 'obj_lamp')
    expect(lampObj).toBeDefined()
    expect(lampObj?.host).toBe('ceiling')
    expect(lampObj?.host_id).toBe(result.scene.ceiling.id)
    // Sanity: not in floor or wall lists.
    expect(result.scene.floor.floor_mounted.find(o => o.id === 'obj_lamp')).toBeUndefined()
    for (const w of result.scene.walls) {
      expect(w.wall_mounted.find(o => o.id === 'obj_lamp')).toBeUndefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// H-B3 audit-fix · bridge test-coverage gaps
// ─────────────────────────────────────────────────────────────────────────────

describe('scanToParametric · multi-room scan (H-B3)', () => {
  it('emits a SCAN_MULTI_ROOM_DROPPED warning when more than one room is passed', () => {
    const scan = makeScan()
    const primary = makeRoom({ id: 'room_primary' })
    const secondary = makeRoom({ id: 'room_secondary', name: 'Ante-room' })
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const result = scanToParametric({
      scan,
      rooms: [primary, secondary],
      surfaces: walls,
      measurements: [],
      annotations: [],
    })
    expect(result.scene.walls).toHaveLength(4)
    const dropWarning = result.warnings.find(w => w.startsWith('SCAN_MULTI_ROOM_DROPPED'))
    expect(dropWarning).toBeDefined()
    expect(dropWarning).toContain('room_secondary')
  })
})

describe('scanToParametric · free-floating annotation (H-B3)', () => {
  it('emits a photo without anchor fields when the annotation has no anchorUv', () => {
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const photoAnno: ScanAnnotation = {
      id: 'anno_floating_photo',
      scanId: 'scan_1',
      kind: 'photo',
      anchorUv: null,
      anchorWorldCache: null,
      anchorArHint: null,
      anchor2d: null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'high',
      photoAssetId: 'asset_floating',
      note: null,
      status: 'open',
      gewerk: null,
      offerRelevant: false,
      offerLineItemId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [photoAnno],
    })
    expect(result.scene.photos).toHaveLength(1)
    const photo = result.scene.photos[0]
    expect(photo.url).toBe('asset_floating')
    expect(photo.anchor_surface_id).toBeUndefined()
    expect(photo.anchor_surface_type).toBeUndefined()
    expect(photo.anchor_uv).toBeUndefined()
    // free-floating pins (damage etc.) without anchor are dropped with a warning
  })

  it('drops a damage annotation without anchor as a PIN_NO_ANCHOR warning', () => {
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const orphan: ScanAnnotation = {
      id: 'anno_orphan',
      scanId: 'scan_1',
      kind: 'damage',
      anchorUv: null,
      anchorWorldCache: null,
      anchorArHint: null,
      anchor2d: null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'low',
      photoAssetId: null,
      note: null,
      status: 'open',
      gewerk: null,
      offerRelevant: false,
      offerLineItemId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [orphan],
    })
    expect(result.scene.pins).toHaveLength(0)
    expect(result.warnings.some(w => w.startsWith('PIN_NO_ANCHOR'))).toBe(true)
  })
})

describe('scanToParametric · scanStartedAt null fallback (H-B3)', () => {
  it('falls back to scan.createdAt when scanStartedAt is null', () => {
    const scan = makeScan({ scanStartedAt: null })
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [],
    })
    // No throw + valid ISO timestamps on every wall.
    for (const w of result.scene.walls) {
      expect(w.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    }
    expect(result.scene.floor.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(result.scene.ceiling.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('scanToParametric · uv out-of-range clamping (H-B3)', () => {
  it('clamps anchorUv components to [0, 1] before emitting the pin', () => {
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const annoOver: ScanAnnotation = {
      id: 'anno_uv_overflow',
      scanId: 'scan_1',
      kind: 'damage',
      anchorUv: { surfaceExternalId: 'ext_w_s', uv: [1.42, -0.31] },
      anchorWorldCache: null,
      anchorArHint: null,
      anchor2d: null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'medium',
      photoAssetId: null,
      note: 'UV over',
      status: 'open',
      gewerk: null,
      offerRelevant: false,
      offerLineItemId: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [annoOver],
    })
    expect(result.scene.pins).toHaveLength(1)
    const pin = result.scene.pins[0]
    expect(pin.anchor_uv.u).toBeGreaterThanOrEqual(0)
    expect(pin.anchor_uv.u).toBeLessThanOrEqual(1)
    expect(pin.anchor_uv.v).toBeGreaterThanOrEqual(0)
    expect(pin.anchor_uv.v).toBeLessThanOrEqual(1)
  })
})

describe('scanToParametric · door on collapsed wall side (H-B3)', () => {
  it('attaches a door anchored to the dropped pair-member to the surviving wall', () => {
    const scan = makeScan()
    const room = makeRoom()
    // Pair of doubled walls on the south side; ext_w_b is the second-of-pair.
    const walls: ScanSurface[] = [
      makeWallSurface({ id: 'w_a', externalId: 'ext_w_a', cx: 2, cz: 0, width: 4, height: 2.5, rotYRad: 0 }),
      makeWallSurface({ id: 'w_b', externalId: 'ext_w_b', cx: 2, cz: -0.05, width: 4, height: 2.5, rotYRad: 0 }),
      makeWallSurface({ id: 'w_e', externalId: 'ext_w_e', cx: 4, cz: 1.5, width: 3, height: 2.5, rotYRad: -Math.PI / 2 }),
      makeWallSurface({ id: 'w_n', externalId: 'ext_w_n', cx: 2, cz: 3, width: 4, height: 2.5, rotYRad: Math.PI }),
      makeWallSurface({ id: 'w_w', externalId: 'ext_w_w', cx: 0, cz: 1.5, width: 3, height: 2.5, rotYRad: Math.PI / 2 }),
    ]
    // Door centroid is positioned near the dropped wall (z = -0.05).
    const door: ScanSurface = {
      id: 'door_on_dropped',
      roomId: 'room_1',
      surfaceExternalId: 'ext_door_dropped',
      kind: 'door',
      dimWEstimated: 0.9,
      dimHEstimated: 2,
      dimWVerified: null,
      dimHVerified: null,
      transform: { position: { x: 1.5, y: 1, z: -0.05 }, rotationYRad: 0 },
      status: 'estimated_roomplan',
      confidence: 0.9,
      createdAt: NOW,
      updatedAt: NOW,
    }
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: [...walls, door],
      measurements: [],
      annotations: [],
    })
    const openings = result.scene.walls.flatMap(w => w.openings)
    expect(openings).toHaveLength(1)
    // Either w_a (survivor) or w_b (dropped) — but the dropped wall is no
    // longer in scene.walls, so the host MUST be w_a.
    expect(openings[0].host_wall_id).toBe('w_a')
    // surfaceExternalIdToNodeId must redirect both ids to the survivor.
    expect(result.bridgeDefaults.surfaceExternalIdToNodeId['ext_w_b']).toBe('w_a')
  })
})

describe('scanToParametric · polygon_override absence (H-B3)', () => {
  it('does NOT populate polygon_override for surfaces without an explicit poly', () => {
    // V1 bridge does not derive polygon_override from RoomPlan output — only
    // iOS 17+ irregular walls would; until that path lands the field must be
    // absent so downstream code (renderer) falls back to the rectangular
    // start/end geometry. Regression-guard for OD-9 in the renderer audit.
    const scan = makeScan()
    const room = makeRoom()
    const walls = makeRectangularBathroomWalls().map(makeWallSurface)
    const result = scanToParametric({
      scan,
      rooms: [room],
      surfaces: walls,
      measurements: [],
      annotations: [],
    })
    for (const w of result.scene.walls) {
      expect(w.polygon_override).toBeUndefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F10 — floor-polygon topology stitch (non-perimeter-ordered wall lists)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L-shaped room (6 walls). Perimeter vertices, walked CCW:
 *
 *   (0,4) ─ E ─ (2,4)
 *     │           │
 *     F           D
 *     │           │
 *   (0,0)       (2,2) ─ C ─ (4,2)
 *     │                       │
 *     └────────── A ──────────┘ ... actually:
 *
 * Vertices: (0,0)→(4,0)→(4,2)→(2,2)→(2,4)→(0,4)→(0,0)
 *   A (0,0)-(4,0): cx=2  cz=0  w=4 rotY=0
 *   B (4,0)-(4,2): cx=4  cz=1  w=2 rotY=-π/2
 *   C (4,2)-(2,2): cx=3  cz=2  w=2 rotY=π
 *   D (2,2)-(2,4): cx=2  cz=3  w=2 rotY=-π/2
 *   E (2,4)-(0,4): cx=1  cz=4  w=2 rotY=π
 *   F (0,4)-(0,0): cx=0  cz=2  w=4 rotY=π/2
 * Area = 4·2 + 2·2 = 12 m².
 */
function makeLShapedWalls(): WallSpec[] {
  return [
    { id: 'w_A', externalId: 'ext_A', cx: 2, cz: 0, width: 4, height: 2.5, rotYRad: 0 },
    { id: 'w_B', externalId: 'ext_B', cx: 4, cz: 1, width: 2, height: 2.5, rotYRad: -Math.PI / 2 },
    { id: 'w_C', externalId: 'ext_C', cx: 3, cz: 2, width: 2, height: 2.5, rotYRad: Math.PI },
    { id: 'w_D', externalId: 'ext_D', cx: 2, cz: 3, width: 2, height: 2.5, rotYRad: -Math.PI / 2 },
    { id: 'w_E', externalId: 'ext_E', cx: 1, cz: 4, width: 2, height: 2.5, rotYRad: Math.PI },
    { id: 'w_F', externalId: 'ext_F', cx: 0, cz: 2, width: 4, height: 2.5, rotYRad: Math.PI / 2 },
  ]
}

describe('scanToParametric · floor-polygon topology stitch (F10)', () => {
  it('stitches an L-shaped room from a NON-perimeter-ordered wall list', () => {
    // Walls handed to the bridge in detection order, NOT perimeter order —
    // the common case for real RoomPlan captures. Declaration-order mapping
    // would produce a self-intersecting garbage polygon; the topology stitch
    // must recover the true closed ring regardless.
    const shuffled = [
      makeLShapedWalls()[2], // C
      makeLShapedWalls()[5], // F
      makeLShapedWalls()[0], // A
      makeLShapedWalls()[4], // E
      makeLShapedWalls()[1], // B
      makeLShapedWalls()[3], // D
    ]
    const result = scanToParametric({
      scan: makeScan(),
      rooms: [makeRoom()],
      surfaces: shuffled.map(makeWallSurface),
      measurements: [],
      annotations: [],
    })
    // The ring closes — 6 distinct vertices, correct L-shape area.
    expect(result.scene.floor.polygon).toHaveLength(6)
    expect(result.scene.computed_area_m2).toBeGreaterThan(11.9)
    expect(result.scene.computed_area_m2).toBeLessThan(12.1)
    expect(
      result.warnings.some(w => w.startsWith('FLOOR_POLYGON_NOT_CLOSED')),
    ).toBe(false)
  })

  it('flags a wall list that does not form a closed loop', () => {
    // Drop one wall of the L — the remaining 5 cannot chain into a ring.
    const open = makeLShapedWalls().slice(0, 5)
    const result = scanToParametric({
      scan: makeScan(),
      rooms: [makeRoom()],
      surfaces: open.map(makeWallSurface),
      measurements: [],
      annotations: [],
    })
    expect(result.scene.floor.polygon).toEqual([])
    expect(
      result.warnings.some(w => w.startsWith('FLOOR_POLYGON_NOT_CLOSED')),
    ).toBe(true)
    // Area falls back to the ScanRoom estimate rather than going to 0.
    expect(result.scene.computed_area_m2).toBe(12)
  })

  it('still stitches a perfectly-ordered rectangular wall list', () => {
    const result = scanToParametric({
      scan: makeScan(),
      rooms: [makeRoom()],
      surfaces: makeRectangularBathroomWalls().map(makeWallSurface),
      measurements: [],
      annotations: [],
    })
    expect(result.scene.floor.polygon).toHaveLength(4)
    expect(result.warnings).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Quiet the linter about un-used scaffolding when the test file is read by
// future contributors looking for fixture-builders.
// ─────────────────────────────────────────────────────────────────────────────
void ([] satisfies ScanMeasurement[])
