/**
 * End-to-end test for the Block-A → Canonical → parametric.json → bytes →
 * canonical round-trip.
 *
 * Pipeline:
 *   1. Build a synthetic Block-A scan dump (a 4-wall rectangular bathroom
 *      with one door and one damage pin).
 *   2. Run `scanToParametric()` → canonical {@link RoomScene}.
 *   3. Wrap into a {@link ParametricJson} via `serialize()`.
 *   4. `encodeParametricBlob()` → gzipped bytes + SHA-256.
 *   5. `decodeParametricBlob()` → migrated document.
 *   6. Assert wall + pin counts survive the round trip.
 */
import { describe, expect, it } from 'vitest'

import { scanToParametric } from '../../../../src/lib/spatial/canonical/bridge/scanToParametric.ts'
import { serialize } from '../../../../src/lib/spatial/canonical/converters/canonical-roundtrip.ts'
import {
  decodeParametricBlob,
  encodeParametricBlob,
} from '../../../../src/lib/spatial/canonical/storage/parametric-storage.ts'
import { runValidator } from '../../../../src/lib/spatial/canonical/validator/run-validator.ts'
import type {
  Scan,
  ScanAnnotation,
  ScanRoom,
  ScanSurface,
} from '../../../../src/lib/spatial/types.ts'

const NOW = 1716163200000

function buildSyntheticBathroomDump(): {
  scan: Scan
  rooms: ScanRoom[]
  surfaces: ScanSurface[]
  annotations: ScanAnnotation[]
} {
  const scan: Scan = {
    id: 'scan_e2e',
    jobId: null,
    projectId: 'project_e2e',
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'roomplan',
    capturedBy: 'user_1',
    deviceMeta: {},
    scanStartedAt: NOW,
    scanEndedAt: NOW + 30_000,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 30_000,
  }

  const room: ScanRoom = {
    id: 'room_e2e',
    scanId: 'scan_e2e',
    name: 'Bathroom',
    areaM2Estimated: 12,
    areaM2Verified: null,
    ceilingHEstimated: 2.5,
    ceilingHVerified: null,
    floorAnchor: null,
    createdAt: NOW,
    updatedAt: NOW,
  }

  // 4 walls (4 × 3 m bathroom).
  const wallSpecs: Array<{
    id: string
    ext: string
    cx: number
    cz: number
    w: number
    rot: number
  }> = [
    { id: 'w_s', ext: 'ext_w_s', cx: 2, cz: 0, w: 4, rot: 0 },
    { id: 'w_e', ext: 'ext_w_e', cx: 4, cz: 1.5, w: 3, rot: -Math.PI / 2 },
    { id: 'w_n', ext: 'ext_w_n', cx: 2, cz: 3, w: 4, rot: Math.PI },
    { id: 'w_w', ext: 'ext_w_w', cx: 0, cz: 1.5, w: 3, rot: Math.PI / 2 },
  ]
  const surfaces: ScanSurface[] = wallSpecs.map(s => ({
    id: s.id,
    roomId: 'room_e2e',
    surfaceExternalId: s.ext,
    kind: 'wall',
    dimWEstimated: s.w,
    dimHEstimated: 2.5,
    dimWVerified: s.w,
    dimHVerified: 2.5,
    transform: { position: { x: s.cx, y: 0, z: s.cz }, rotationYRad: s.rot },
    status: 'estimated_roomplan',
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
  }))

  // One door on the south wall.
  surfaces.push({
    id: 'door_e2e',
    roomId: 'room_e2e',
    surfaceExternalId: 'ext_door_e2e',
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
  })

  // One damage pin on the south wall.
  const annotations: ScanAnnotation[] = [
    {
      id: 'pin_e2e',
      scanId: 'scan_e2e',
      kind: 'damage',
      anchorUv: { surfaceExternalId: 'ext_w_s', uv: [0.5, 0.5] },
      anchorWorldCache: null,
      anchorArHint: null,
      anchor2d: null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'high',
      photoAssetId: null,
      note: 'Tile crack',
      status: 'open',
      gewerk: 'sanitär',
      offerRelevant: true,
      offerLineItemId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]

  return { scan, rooms: [room], surfaces, annotations }
}

describe('Block-A → canonical → parametric.json end-to-end round-trip', () => {
  it('preserves wall + pin counts across encode + decode', async () => {
    const dump = buildSyntheticBathroomDump()
    // 1 + 2. Bridge.
    const bridge = scanToParametric({
      scan: dump.scan,
      rooms: dump.rooms,
      surfaces: dump.surfaces,
      measurements: [],
      annotations: dump.annotations,
    })
    expect(bridge.scene.walls).toHaveLength(4)
    expect(bridge.scene.pins).toHaveLength(1)

    // 3. Validator + serialize into a parametric.json document.
    const report = runValidator(bridge.scene)
    const document = serialize({
      scene: bridge.scene,
      validation_report: report,
      source: 'roomplan_ios18',
      fixup_project_id: dump.scan.projectId,
      fixup_job_id: dump.scan.jobId,
    })

    // 4. Encode.
    const encoded = await encodeParametricBlob(document)
    expect(encoded.bytes.byteLength).toBeGreaterThan(0)
    expect(encoded.sha256).toMatch(/^[0-9a-f]{64}$/)

    // 5. Decode.
    const decoded = await decodeParametricBlob(encoded.bytes, {
      expectedSha256: encoded.sha256,
    })

    // 6. Assert counts.
    const doc = decoded.document as unknown as {
      scene_graph: {
        walls: unknown[]
        pins: unknown[]
      }
    }
    expect(doc.scene_graph.walls).toHaveLength(4)
    expect(doc.scene_graph.pins).toHaveLength(1)
    expect(decoded.migrated).toBe(false)
  })
})
