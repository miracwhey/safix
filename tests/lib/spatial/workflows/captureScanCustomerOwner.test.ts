/**
 * Spatial V1.6 · Phase 2 · captureScan ownerType branch tests
 *
 * Pins the EDIT applied to `captureScan.ts`:
 *   1. ownerType='craftsman' (default) + missing all anchors → throws.
 *      Preserves the legacy HW guard.
 *   2. ownerType='customer' + missing all anchors → succeeds. The DB CHECK
 *      `scans_owner_anchor_chk` was relaxed in F1 to accept jobless customer
 *      scans; the workflow guard mirrors that.
 *   3. ownerType='customer' + jobId → succeeds, scan.ownerType='customer'.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
  captureScan,
} from '../../../../src/lib/spatial'

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

function usdzBlob(): Blob {
  return new Blob([new Uint8Array([0x55, 0x53, 0x44, 0x5a])], {
    type: 'model/vnd.usdz+zip',
  })
}

describe('captureScan · Phase 2 ownerType branch', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
    uploadSpy.mockClear()
  })

  it('default ownerType=craftsman + no anchor → throws (legacy guard preserved)', async () => {
    await expect(
      captureScan({
        userId: USER,
        usdzBlob: usdzBlob(),
      }),
    ).rejects.toThrow(/projectId OR jobId OR presalesProjectId required/)
  })

  it('ownerType=customer + no anchor → succeeds (relaxed CHECK mirror)', async () => {
    const result = await captureScan({
      userId: USER,
      usdzBlob: usdzBlob(),
      ownerType: 'customer',
    })
    expect(result.scan.id).toBeDefined()
    expect(result.scan.ownerType).toBe('customer')
    expect(result.scan.jobId).toBeNull()
    expect(result.scan.projectId).toBeNull()
    expect(result.scan.presalesProjectId).toBeNull()
    // Verify persistence
    const persisted = await repo.getScan(result.scan.id)
    expect(persisted!.ownerType).toBe('customer')
  })

  it('ownerType=customer + jobId → succeeds and attaches job', async () => {
    const result = await captureScan({
      userId: USER,
      usdzBlob: usdzBlob(),
      jobId: JOB,
      ownerType: 'customer',
    })
    expect(result.scan.ownerType).toBe('customer')
    expect(result.scan.jobId).toBe(JOB)
  })
})
