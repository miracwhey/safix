/**
 * Spatial V1.6 · Phase 2 · createCustomerLidarScene workflow tests
 *
 * Exercises the result-typed pipeline on the InMemory adapter — the storage
 * mock keeps the suite offline. The InMemory repo's mesh-snapshot map +
 * quality map double as assertion surfaces; helper accessors
 * `repo.getMeshSnapshotBytes(path)` and `repo.getScanQuality(scanId)` let
 * us assert side-effects without touching real storage.
 *
 * Coverage:
 *   1. happy path (jobless customer scan, perfect roomScan → label='high')
 *   2. happy path with jobId
 *   3. RBAC: missing userId → rbac_user_required (NO DB calls)
 *   4. captureScan throws → scan_creation_failed
 *   5. updateScanQuality throws → quality_persist_failed (scan still persists)
 *   6. uploadMeshSnapshot throws → mesh_upload_failed (scan + quality persist)
 *   7. quality: minimal roomScan (1 wall, missing area) → label='low'
 *   8. quality: meshClassification wallCoverageRatio low → label drops
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { RoomScanResult, MeshClassification } from '@fixup/capacitor-roomplan'

import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from '../../../../src/lib/spatial'
import { createCustomerLidarScene } from '../../../../src/lib/spatial/workflow/createCustomerLidarScene'

// Mock supabase.storage so captureScan's uploadScanAsset() PUT against
// `project-scans` succeeds without a real network call. Mirror the
// captureScan.test.ts mock shape.
const uploadSpy = vi.fn(async () => ({ data: { path: 'mock' }, error: null }))
vi.mock('../../../../src/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: uploadSpy,
      }),
    },
  },
}))

const USER = 'cccccccc-0000-0000-0000-000000000001'
const JOB = 'jjjjjjjj-0000-0000-0000-000000000001'

function perfectRoomScan(): RoomScanResult {
  // 4 walls (engine R1 floor=4), plausible area + ceiling, no out-of-range
  // door/window dims, no mesh degradation → engine score should land ≥80.
  return {
    usdzPath: 'mock/scan.usdz',
    capturedAt: new Date().toISOString(),
    floorAreaM2: 22,
    ceilingHeightM: 2.6,
    walls: [
      { widthM: 5, heightM: 2.6 },
      { widthM: 5, heightM: 2.6 },
      { widthM: 4.4, heightM: 2.6 },
      { widthM: 4.4, heightM: 2.6 },
    ],
    doors: [{ widthM: 0.9, heightM: 2.05 }],
    windows: [{ widthM: 1.2, heightM: 1.4 }],
    furnitureCount: 2,
    furnitureCategories: ['chair', 'table'],
    deviceMeta: {
      deviceModel: 'iPhone15,3',
      osVersion: '17.5',
      appVersion: '1.6.0',
      hasLidar: true,
      thermalState: 'nominal',
      durationSec: 92,
    },
  }
}

function minimalRoomScan(): RoomScanResult {
  // 1 wall (engine R1 fails: too_few_walls weight=25)
  // implausible area (engine R2 fails: area_implausible weight=18)
  // missing ceilingHeight effectively falls back to estimate 0 (ceiling_implausible weight=15)
  return {
    usdzPath: 'mock/scan.usdz',
    capturedAt: new Date().toISOString(),
    floorAreaM2: 1.5,
    ceilingHeightM: 1.2,
    walls: [{ widthM: 2, heightM: 1.2 }],
    doors: [],
    windows: [],
    furnitureCount: 0,
    furnitureCategories: [],
  }
}

function meshWithRatio(ratio: number): MeshClassification {
  return {
    anchorCount: 6,
    totalFaces: 4000,
    classFaces: {
      none: 100,
      wall: Math.round(4000 * ratio),
      floor: 400,
      ceiling: 200,
      table: 40,
      seat: 30,
      window: 20,
      door: 10,
    },
    wallCoverageRatio: ratio,
    degraded: false,
    thermalStateAtSnapshot: 'nominal',
    samplesCollected: 200,
    anchorsWithoutClassification: 0,
    durationSec: 100,
    avgPollHz: 2,
  }
}

function usdzBlob(): Blob {
  return new Blob([new Uint8Array([0x55, 0x53, 0x44, 0x5a])], {
    type: 'model/vnd.usdz+zip',
  })
}

describe('createCustomerLidarScene · happy path', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    uploadSpy.mockClear()
  })

  it('jobless customer scan persists scan + quality + mesh snapshot', async () => {
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return // narrow

    // Scan row exists with owner_type='customer', jobless allowed
    const scan = await repo.getScan(result.scanId)
    expect(scan).not.toBeNull()
    expect(scan!.ownerType).toBe('customer')
    expect(scan!.jobId).toBeNull()
    expect(scan!.projectId).toBeNull()

    // F1 columns persisted via updateScanQuality
    const persistedQuality = repo.getScanQuality(result.scanId)
    expect(persistedQuality).toBeDefined()
    expect(persistedQuality!.score).toBe(result.quality.score)
    expect(persistedQuality!.label).toBe(result.quality.label)
    expect(result.quality.label).toBe('high')

    // F2 mesh-snapshot uploaded at {userId}/{scanId}.usdz
    expect(result.meshSnapshotPath).toBe(`${USER}/${result.scanId}.usdz`)
    expect(repo.getMeshSnapshotBytes(result.meshSnapshotPath)).toBeGreaterThan(0)
  })

  it('customer scan with jobId attaches to the job and still uses owner_type=customer', async () => {
    const result = await createCustomerLidarScene({
      userId: USER,
      jobId: JOB,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const scan = await repo.getScan(result.scanId)
    expect(scan!.ownerType).toBe('customer')
    expect(scan!.jobId).toBe(JOB)
  })
})

describe('createCustomerLidarScene · failure paths', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    uploadSpy.mockClear()
  })

  it('missing userId → rbac_user_required, no DB call', async () => {
    const beforeScans = await listAllScans(repo)
    const result = await createCustomerLidarScene({
      userId: '',
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('rbac_user_required')
    // No row created
    const afterScans = await listAllScans(repo)
    expect(afterScans.length).toBe(beforeScans.length)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('captureScan throws → scan_creation_failed (cause forwarded)', async () => {
    const boom = new Error('storage 5xx')
    uploadSpy.mockRejectedValueOnce(boom)
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('scan_creation_failed')
    expect(result.cause).toBeDefined()
  })

  it('updateScanQuality throws → quality_persist_failed (scan stays persisted)', async () => {
    // Force updateScanQuality to throw by spying on the bound method.
    const original = repo.updateScanQuality.bind(repo)
    const spy = vi
      .spyOn(repo, 'updateScanQuality')
      .mockRejectedValueOnce(new Error('rls 42501'))
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('quality_persist_failed')
    expect(result.scanId).toBeDefined()
    // Scan row was created before the throw — recovery path is "retry quality"
    // not "re-scan".
    const scan = await repo.getScan(result.scanId!)
    expect(scan).not.toBeNull()
    // Quality NOT persisted
    expect(repo.getScanQuality(result.scanId!)).toBeUndefined()
    // Mesh snapshot not yet uploaded (step 5 never reached)
    expect(repo.getMeshSnapshotBytes(`${USER}/${result.scanId}.usdz`)).toBeUndefined()
    spy.mockRestore()
    void original
  })

  it('uploadMeshSnapshot throws → mesh_upload_failed (scan + quality persisted)', async () => {
    const original = repo.uploadMeshSnapshot.bind(repo)
    const spy = vi
      .spyOn(repo, 'uploadMeshSnapshot')
      .mockRejectedValueOnce(new Error('bucket 403'))
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('mesh_upload_failed')
    expect(result.scanId).toBeDefined()
    // Scan + quality persisted; only the mesh snapshot is missing.
    const scan = await repo.getScan(result.scanId!)
    expect(scan).not.toBeNull()
    expect(repo.getScanQuality(result.scanId!)).toBeDefined()
    expect(repo.getMeshSnapshotBytes(`${USER}/${result.scanId}.usdz`)).toBeUndefined()
    spy.mockRestore()
    void original
  })
})

describe('createCustomerLidarScene · quality computation', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    uploadSpy.mockClear()
  })

  it('perfect roomScan → label="high"', async () => {
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quality.label).toBe('high')
    expect(result.quality.score).toBeGreaterThanOrEqual(80)
  })

  it('minimal roomScan (1 wall, missing area + ceiling) → label="low"', async () => {
    const result = await createCustomerLidarScene({
      userId: USER,
      roomScan: minimalRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.quality.label).toBe('low')
    expect(result.quality.score).toBeLessThan(50)
  })

  it('mesh-classification with low wallCoverageRatio drops the score', async () => {
    // perfect roomScan with low wall coverage → R6 fires (weight 14)
    // Score for perfect = 100; with R6 fired score ≤ 86; still 'high' but
    // the test asserts the rule was consumed.
    const perfectWithBadMesh: RoomScanResult = {
      ...perfectRoomScan(),
      meshClassification: meshWithRatio(0.4),
    }
    const lowResult = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectWithBadMesh,
      usdzBlob: usdzBlob(),
    })
    expect(lowResult.ok).toBe(true)
    if (!lowResult.ok) return
    // Compare against the baseline perfect score (no mesh).
    resetSpatialRepository()
    const repo2 = new InMemorySpatialRepository()
    initializeSpatialRepository(repo2)
    uploadSpy.mockClear()
    const baseline = await createCustomerLidarScene({
      userId: USER,
      roomScan: perfectRoomScan(),
      usdzBlob: usdzBlob(),
    })
    expect(baseline.ok).toBe(true)
    if (!baseline.ok) return
    expect(lowResult.quality.score).toBeLessThan(baseline.quality.score)
  })
})

async function listAllScans(repo: InMemorySpatialRepository) {
  // Exploit the public listScansForJob with a sentinel — the repo has no
  // listAll API. The InMemorySpatialRepository's underlying Map size would be
  // ideal but is private; the test workaround is to read the internal map
  // via the test-only reset/seed surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.from((repo as any).scans.values()) as unknown[]
}
