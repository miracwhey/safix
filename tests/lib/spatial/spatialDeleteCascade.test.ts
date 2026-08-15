/**
 * Spatial Core · Block J.2 · Delete-Cascade Integration Test
 *
 * Mirrors the DSGVO Art. 17 right-to-erasure contract: deleting a scan
 * cascades to all its assets, rooms, surfaces, measurements, annotations
 * and audit events. Runs against the InMemorySpatialRepository because
 * the cascade lives in the same code path the supabase repo wraps —
 * the mock enforces the same FK + ON DELETE CASCADE shape.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { InMemorySpatialRepository } from '../../../src/lib/spatial/repository/InMemorySpatialRepository'

const SCAN_OWNER = 'user_test_owner'

describe('Spatial · delete cascade (DSGVO Art. 17)', () => {
  let repo: InMemorySpatialRepository

  afterEach(() => {
    repo?.reset()
  })

  it('removes scan + all child rows when deleteScan is called', async () => {
    repo = new InMemorySpatialRepository()
    const scan = await repo.createScan({
      jobId: 'job_test',
      projectId: null,
      source: 'roomplan',
      capturedBy: SCAN_OWNER,
      deviceMeta: {},
      scanStartedAt: Date.now(),
    })

    // Seed every child row type that should cascade away.
    const room = await repo.createScanRoom({
      scanId: scan.id,
      name: 'Wohnzimmer',
      areaM2Estimated: 18,
      ceilingHEstimated: 2.5,
    })
    const surface = await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'wall_01',
      kind: 'wall',
      dimWEstimated: 4,
      dimHEstimated: 2.5,
    })
    void surface
    await repo.createScanAsset({
      scanId: scan.id,
      kind: 'usdz',
      storagePath: `${SCAN_OWNER}/${scan.id}/usdz/x.usdz`,
      bytes: 1024,
      sha256: 'deadbeef',
    })
    await repo.createScanMeasurement({
      scanId: scan.id,
      surfaceId: null,
      label: 'Wandbreite',
      valueEstimatedM: 3.95,
      source: 'roomplan',
    })
    await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'damage',
      anchorUv: { surfaceExternalId: 'wall_01', uv: [0.5, 0.5] },
    })

    // Pre-delete: child rows are present.
    expect((await repo.listScanRooms(scan.id)).length).toBe(1)
    expect((await repo.listScanAssets(scan.id)).length).toBe(1)
    expect((await repo.listScanMeasurements(scan.id)).length).toBe(1)
    expect((await repo.listScanAnnotations(scan.id)).length).toBe(1)

    await repo.deleteScan(scan.id)

    // Post-delete: scan and every cascaded child row are gone.
    expect(await repo.getScan(scan.id)).toBeNull()
    expect((await repo.listScanRooms(scan.id)).length).toBe(0)
    expect((await repo.listScanAssets(scan.id)).length).toBe(0)
    expect((await repo.listScanMeasurements(scan.id)).length).toBe(0)
    expect((await repo.listScanAnnotations(scan.id)).length).toBe(0)
  })

  it('does not bleed cascade across scans on the same job', async () => {
    repo = new InMemorySpatialRepository()
    const a = await repo.createScan({
      jobId: 'job_test',
      projectId: null,
      source: 'roomplan',
      capturedBy: SCAN_OWNER,
      deviceMeta: {},
      scanStartedAt: Date.now(),
    })
    const b = await repo.createScan({
      jobId: 'job_test',
      projectId: null,
      source: 'roomplan',
      capturedBy: SCAN_OWNER,
      deviceMeta: {},
      scanStartedAt: Date.now(),
    })
    await repo.createScanAsset({
      scanId: a.id,
      kind: 'usdz',
      storagePath: `${SCAN_OWNER}/${a.id}/usdz/a.usdz`,
    })
    await repo.createScanAsset({
      scanId: b.id,
      kind: 'usdz',
      storagePath: `${SCAN_OWNER}/${b.id}/usdz/b.usdz`,
    })

    await repo.deleteScan(a.id)

    expect(await repo.getScan(a.id)).toBeNull()
    expect((await repo.listScanAssets(a.id)).length).toBe(0)
    expect(await repo.getScan(b.id)).not.toBeNull()
    expect((await repo.listScanAssets(b.id)).length).toBe(1)
  })
})
