import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MeshClassification } from '@fixup/capacitor-roomplan'
import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
} from '../../../src/lib/spatial'
import {
  uploadMeshSummaryAsset,
  uploadScanAsset,
  scanAssetStoragePath,
} from '../../../src/lib/spatial/storage'

// Mock supabase storage so tests stay offline. The mock counts PUT calls so
// we can assert the dedup short-circuit prevents redundant uploads.
const uploadSpy = vi.fn(async () => ({ data: { path: 'mock' }, error: null }))
vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: uploadSpy,
      }),
    },
  },
}))

const USER = 'cccccccc-0000-0000-0000-000000000001'
const PROJECT = 'pppppppp-0000-0000-0000-000000000001'

describe('uploadScanAsset', () => {
  let repo: InMemorySpatialRepository
  let scanId: string

  beforeEach(async () => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    scanId = scan.id
    uploadSpy.mockClear()
  })

  it('uploads bytes and creates a scan_assets row on first call', async () => {
    const blob = new Blob([new Uint8Array([0xaa, 0xbb, 0xcc])])
    const result = await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'usdz',
      blob,
    })
    expect(result.reused).toBe(false)
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    expect(result.asset.kind).toBe('usdz')
    expect(result.asset.sha256).toBe(result.sha256)
    expect(result.asset.bytes).toBe(blob.size)
    expect(result.asset.storagePath).toBe(
      scanAssetStoragePath({ userId: USER, scanId, kind: 'usdz', sha256: result.sha256 }),
    )
    const assets = await repo.listScanAssets(scanId)
    expect(assets).toHaveLength(1)
  })

  it('dedups identical bytes for the same kind — 0 additional uploads', async () => {
    const blob1 = new Blob([new Uint8Array([1, 2, 3, 4])])
    const first = await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'scan_json',
      blob: blob1,
    })
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const blob2 = new Blob([new Uint8Array([1, 2, 3, 4])])
    const second = await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'scan_json',
      blob: blob2,
    })
    expect(second.reused).toBe(true)
    expect(second.asset.id).toBe(first.asset.id)
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const assets = await repo.listScanAssets(scanId)
    expect(assets).toHaveLength(1)
  })

  it('different bytes for the same kind throws — silent dedup would orphan the new bytes', async () => {
    await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'mesh_summary',
      blob: new Blob([new Uint8Array([0])]),
    })
    // Same `kind`, different bytes → upload runs (PUT goes to a new sha
    // path), then createScanAsset hits the UNIQUE(scan_id, kind) guard.
    // The recovery path requires a sha match to return the existing row;
    // sha differs here so we rethrow instead of silently returning the
    // stale row. Without this guard the storage PUT becomes an orphan
    // and the asset row still points at the old sha-path.
    await expect(
      uploadScanAsset({
        scanId,
        userId: USER,
        kind: 'mesh_summary',
        blob: new Blob([new Uint8Array([0, 1])]),
      }),
    ).rejects.toThrow()
    const assets = await repo.listScanAssets(scanId)
    expect(assets).toHaveLength(1)
    expect(assets[0]!.kind).toBe('mesh_summary')
    // PUT was attempted twice (the second one orphans bytes — operator
    // cleanup territory, but at least the caller sees the error).
    expect(uploadSpy).toHaveBeenCalledTimes(2)
  })

  it('different kinds with same bytes are independent assets', async () => {
    const bytes = new Uint8Array([7, 7, 7])
    await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'thumbnail',
      blob: new Blob([bytes]),
    })
    await uploadScanAsset({
      scanId,
      userId: USER,
      kind: 'floorplan_svg',
      blob: new Blob([bytes]),
    })
    const assets = await repo.listScanAssets(scanId)
    expect(assets.map(a => a.kind).sort()).toEqual(['floorplan_svg', 'thumbnail'])
    expect(uploadSpy).toHaveBeenCalledTimes(2)
  })

  it('builds the storage path under {user}/{scan}/{kind}/<sha>.<ext>', () => {
    expect(scanAssetStoragePath({ userId: 'u', scanId: 's', kind: 'usdz', sha256: 'abc' })).toBe(
      'u/s/usdz/abc.usdz',
    )
    expect(scanAssetStoragePath({ userId: 'u', scanId: 's', kind: 'gltf', sha256: 'abc' })).toBe(
      'u/s/gltf/abc.glb',
    )
    expect(scanAssetStoragePath({ userId: 'u', scanId: 's', kind: 'worldmap', sha256: 'abc' })).toBe(
      'u/s/worldmap/abc.bin',
    )
    expect(scanAssetStoragePath({ userId: 'u', scanId: 's', kind: 'scan_json', sha256: 'abc' })).toBe(
      'u/s/scan_json/abc.json',
    )
  })
})

// ── Phase 2 · uploadMeshSummaryAsset ────────────────────────────────────────

function makeMesh(overrides: Partial<MeshClassification> = {}): MeshClassification {
  const base: MeshClassification = {
    anchorCount: 5,
    totalFaces: 3000,
    classFaces: {
      none: 100,
      wall: 2500,
      floor: 200,
      ceiling: 100,
      table: 30,
      seat: 30,
      window: 20,
      door: 20,
    },
    wallCoverageRatio: 0.83,
    degraded: false,
    thermalStateAtSnapshot: 'nominal',
    samplesCollected: 180,
    anchorsWithoutClassification: 0,
    durationSec: 90,
    avgPollHz: 2,
  }
  return {
    ...base,
    ...overrides,
    classFaces: { ...base.classFaces, ...(overrides.classFaces ?? {}) },
  }
}

describe('uploadMeshSummaryAsset', () => {
  let repo: InMemorySpatialRepository
  let scanId: string

  beforeEach(async () => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    const scan = await repo.createScan({
      projectId: PROJECT,
      source: 'roomplan',
      capturedBy: USER,
    })
    scanId = scan.id
    uploadSpy.mockClear()
  })

  it('returns null and performs 0 PUTs when meshClassification is null', async () => {
    const result = await uploadMeshSummaryAsset({
      scanId,
      userId: USER,
      meshClassification: null,
    })
    expect(result).toBeNull()
    expect(uploadSpy).not.toHaveBeenCalled()
    expect(await repo.listScanAssets(scanId)).toHaveLength(0)
  })

  it('returns null and performs 0 PUTs when meshClassification is undefined', async () => {
    const result = await uploadMeshSummaryAsset({
      scanId,
      userId: USER,
      meshClassification: undefined,
    })
    expect(result).toBeNull()
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('skips upload when degraded=true (mirrors meshSummaryFromClassification filter)', async () => {
    const result = await uploadMeshSummaryAsset({
      scanId,
      userId: USER,
      meshClassification: makeMesh({ degraded: true }),
    })
    expect(result).toBeNull()
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it('uploads mesh_summary asset with application/json content-type when input is valid', async () => {
    const result = await uploadMeshSummaryAsset({
      scanId,
      userId: USER,
      meshClassification: makeMesh(),
    })
    expect(result).not.toBeNull()
    expect(result!.asset.kind).toBe('mesh_summary')
    expect(result!.reused).toBe(false)
    expect(uploadSpy).toHaveBeenCalledTimes(1)
    const assets = await repo.listScanAssets(scanId)
    expect(assets).toHaveLength(1)
    expect(assets[0]!.storagePath).toMatch(/^[^/]+\/[^/]+\/mesh_summary\/[a-f0-9]+\.json$/)
  })

  it('produces an identical sha for two semantically-equal inputs in different key order', async () => {
    // Build the same mesh content but in different JS object-key order.
    // sortJsonKeysDeep should normalise both into the same canonical
    // stringification, so the SHA-256 dedup hash collides.
    const a = makeMesh({ wallCoverageRatio: 0.5 })
    const b: MeshClassification = {
      totalFaces: a.totalFaces,
      anchorCount: a.anchorCount,
      avgPollHz: a.avgPollHz,
      classFaces: a.classFaces,
      wallCoverageRatio: a.wallCoverageRatio,
      durationSec: a.durationSec,
      samplesCollected: a.samplesCollected,
      anchorsWithoutClassification: a.anchorsWithoutClassification,
      thermalStateAtSnapshot: a.thermalStateAtSnapshot,
      degraded: a.degraded,
    }
    const first = await uploadMeshSummaryAsset({ scanId, userId: USER, meshClassification: a })
    const second = await uploadMeshSummaryAsset({ scanId, userId: USER, meshClassification: b })
    expect(first!.sha256).toBe(second!.sha256)
    expect(second!.reused).toBe(true)
    expect(uploadSpy).toHaveBeenCalledTimes(1)
  })
})
