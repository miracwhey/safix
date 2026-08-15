import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemorySpatialRepository,
  type AnchorUv,
  type CreateScanInput,
  type Scan,
} from '../../../src/lib/spatial'

const PROJECT_A = 'proj_a_uuid'
const PROJECT_B = 'proj_b_uuid'
const JOB_A = 'job_a_uuid'
const USER_CAPTURER = 'user_capturer'
const USER_VERIFIER = 'user_verifier'

function seedScan(repo: InMemorySpatialRepository, overrides: Partial<CreateScanInput> = {}) {
  return repo.createScan({
    projectId: PROJECT_A,
    source: 'roomplan',
    capturedBy: USER_CAPTURER,
    ...overrides,
  })
}

/**
 * Walks a fresh `draft` scan through the legal FSM path to
 * `locked_for_dispute` so the dispute-lock tests can stage that state without
 * tripping the FSM trigger that ships in 20260518000005_scan_fsm_hardening.sql.
 * Mirrors the trigger's allowed-edges set.
 */
async function walkScanToLockedForDispute(
  repo: InMemorySpatialRepository,
  scanId: string,
): Promise<Scan> {
  await repo.updateScan(scanId, { status: 'capturing' })
  await repo.updateScan(scanId, { status: 'captured' })
  await repo.updateScan(scanId, { status: 'quality_checked' })
  await repo.updateScan(scanId, { status: 'provider_verified' })
  return repo.updateScan(scanId, { status: 'locked_for_dispute' })
}

describe('InMemorySpatialRepository — scans', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('createScan requires job_id OR project_id OR presales_project_id (CHECK)', async () => {
    // V1.5 B-P2 loosened the constraint to allow a presales-anchor; the
    // error message was extended accordingly. Any one of the three anchors is
    // sufficient — none of them present must still throw.
    await expect(
      repo.createScan({ source: 'roomplan', capturedBy: USER_CAPTURER }),
    ).rejects.toThrow(/jobId OR projectId OR presalesProjectId required/)
  })

  it('createScan with project_id only succeeds', async () => {
    const scan = await seedScan(repo)
    expect(scan.projectId).toBe(PROJECT_A)
    expect(scan.jobId).toBeNull()
    expect(scan.status).toBe('draft')
    expect(scan.source).toBe('roomplan')
    expect(scan.capturedBy).toBe(USER_CAPTURER)
    expect(scan.deviceMeta).toEqual({})
  })

  it('listScanVersions returns root + children sorted by createdAt', async () => {
    const root = await seedScan(repo)
    // Force slight time difference
    await new Promise(r => setTimeout(r, 2))
    const child = await seedScan(repo, { parentScanId: root.id })
    const versions = await repo.listScanVersions(root.id)
    expect(versions.map(s => s.id)).toEqual([root.id, child.id])
  })

  it('updateScan blocks re-lock + allows legal operator unlock', async () => {
    const scan = await seedScan(repo)
    const locked = await walkScanToLockedForDispute(repo, scan.id)
    expect(locked.status).toBe('locked_for_dispute')
    // Re-lock attempt is rejected by the dispute-lock guard (matches the DB
    // scans_dispute_lock_guard trigger; FSM trigger short-circuits same-state).
    await expect(
      repo.updateScan(scan.id, { status: 'locked_for_dispute' }),
    ).rejects.toThrow(/locked_for_dispute/)
    // Operator unlock to a seeded legal destination (locked_for_dispute -> archived).
    const unlocked = await repo.updateScan(scan.id, { status: 'archived' })
    expect(unlocked.status).toBe('archived')
  })

  it('updateScan rejects illegal FSM transitions with code 23514', async () => {
    const scan = await seedScan(repo)
    // draft -> archived is NOT a seeded edge.
    await expect(
      repo.updateScan(scan.id, { status: 'archived' }),
    ).rejects.toMatchObject({ code: '23514' })
    // draft -> locked_for_dispute is NOT a seeded edge (only provider_verified
    // and offer_ready can lock).
    await expect(
      repo.updateScan(scan.id, { status: 'locked_for_dispute' }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('deleteScan cascades to all child entities + events', async () => {
    const scan = await seedScan(repo)
    await repo.createScanAsset({ scanId: scan.id, kind: 'usdz', storagePath: 'foo' })
    const room = await repo.createScanRoom({ scanId: scan.id })
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'wall_1',
      kind: 'wall',
    })
    await repo.createScanMeasurement({ scanId: scan.id })
    await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'note',
      anchorUv: { surfaceExternalId: 'wall_1', uv: [0.5, 0.5] },
    })
    await repo.createScanQualityReport({
      scanId: scan.id,
      score: 80,
      bucket: 'good',
      warnings: [],
      engineVersion: 'v1',
    })
    repo.appendScanEvent({ scanId: scan.id, actorId: USER_CAPTURER, action: 'captured', payload: {} })

    await repo.deleteScan(scan.id)
    expect(await repo.listScanAssets(scan.id)).toHaveLength(0)
    expect(await repo.listScanRooms(scan.id)).toHaveLength(0)
    expect(await repo.listScanMeasurements(scan.id)).toHaveLength(0)
    expect(await repo.listScanAnnotations(scan.id)).toHaveLength(0)
    expect(await repo.listScanQualityReports(scan.id)).toHaveLength(0)
    expect(await repo.listScanEvents(scan.id)).toHaveLength(0)
  })
})

describe('InMemorySpatialRepository — scan_assets (D1 dual format)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('enforces UNIQUE (scan_id, kind)', async () => {
    const scan = await seedScan(repo)
    await repo.createScanAsset({ scanId: scan.id, kind: 'usdz', storagePath: 'a.usdz' })
    await expect(
      repo.createScanAsset({ scanId: scan.id, kind: 'usdz', storagePath: 'b.usdz' }),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('allows USDZ + glTF + others coexist for same scan (D1)', async () => {
    const scan = await seedScan(repo)
    const usdz = await repo.createScanAsset({
      scanId: scan.id,
      kind: 'usdz',
      storagePath: 'scan.usdz',
    })
    await repo.createScanAsset({
      scanId: scan.id,
      kind: 'gltf',
      storagePath: 'scan.gltf',
      convertedFrom: usdz.id,
    })
    await repo.createScanAsset({
      scanId: scan.id,
      kind: 'mesh_summary',
      storagePath: 'mesh.json',
    })
    const assets = await repo.listScanAssets(scan.id)
    expect(assets.map(a => a.kind).sort()).toEqual(['gltf', 'mesh_summary', 'usdz'])
    const gltf = assets.find(a => a.kind === 'gltf')!
    expect(gltf.convertedFrom).toBe(usdz.id)
  })
})

describe('InMemorySpatialRepository — scan_surfaces (D2 anchor + D5 dims)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('rejects confidence outside [0, 1]', async () => {
    const scan = await seedScan(repo)
    const room = await repo.createScanRoom({ scanId: scan.id })
    await expect(
      repo.createScanSurface({
        roomId: room.id,
        surfaceExternalId: 'w1',
        kind: 'wall',
        confidence: 1.5,
      }),
    ).rejects.toThrow(/confidence out of/)
  })

  it('enforces UNIQUE (room_id, surface_external_id)', async () => {
    const scan = await seedScan(repo)
    const room = await repo.createScanRoom({ scanId: scan.id })
    await repo.createScanSurface({ roomId: room.id, surfaceExternalId: 'w1', kind: 'wall' })
    await expect(
      repo.createScanSurface({ roomId: room.id, surfaceExternalId: 'w1', kind: 'wall' }),
    ).rejects.toThrow(/UNIQUE/)
  })
})

describe('InMemorySpatialRepository — scan_measurements (atomic verify)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('verifyScanMeasurement atomically sets value + verifier + timestamp + status', async () => {
    const scan = await seedScan(repo)
    const m = await repo.createScanMeasurement({ scanId: scan.id, valueEstimatedM: 4.72 })
    expect(m.status).toBe('estimated_roomplan')
    expect(m.valueVerifiedM).toBeNull()

    const verified = await repo.verifyScanMeasurement(m.id, {
      valueVerifiedM: 4.8,
      verifiedBy: USER_VERIFIER,
    })
    expect(verified.status).toBe('provider_verified')
    expect(verified.valueVerifiedM).toBe(4.8)
    expect(verified.verifiedBy).toBe(USER_VERIFIER)
    expect(verified.verifiedAt).toBeGreaterThan(0)
    // Estimated value preserved
    expect(verified.valueEstimatedM).toBe(4.72)
  })

  it('supersedeScanMeasurement preserves verified history (audit-trail)', async () => {
    const scan = await seedScan(repo)
    const m = await repo.createScanMeasurement({ scanId: scan.id, valueEstimatedM: 4.72 })
    const verified = await repo.verifyScanMeasurement(m.id, {
      valueVerifiedM: 4.8,
      verifiedBy: USER_VERIFIER,
    })
    const superseded = await repo.supersedeScanMeasurement(m.id)
    expect(superseded.status).toBe('superseded')
    // Audit-trail intact (matches DB CHECK fix from review):
    expect(superseded.valueVerifiedM).toBe(verified.valueVerifiedM)
    expect(superseded.verifiedBy).toBe(verified.verifiedBy)
    expect(superseded.verifiedAt).toBe(verified.verifiedAt)
  })
})

describe('InMemorySpatialRepository — scan_annotations (D2 anchor SoT)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  const uvAnchor: AnchorUv = { surfaceExternalId: 'wall_3', uv: [0.42, 0.78] }

  it('requires anchorUv OR anchor2d', async () => {
    const scan = await seedScan(repo)
    await expect(
      repo.createScanAnnotation({ scanId: scan.id, kind: 'note' }),
    ).rejects.toThrow(/anchorUv OR anchor2d required/)
  })

  it('accepts anchorUv-only and defaults confidence=high', async () => {
    const scan = await seedScan(repo)
    const a = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'damage',
      anchorUv: uvAnchor,
    })
    expect(a.anchorUv).toEqual(uvAnchor)
    expect(a.anchor2d).toBeNull()
    expect(a.confidence).toBe('high')
    expect(a.status).toBe('open')
  })

  it('accepts anchor2d-only fallback', async () => {
    const scan = await seedScan(repo)
    const a = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'note',
      anchor2d: { svgX: 100, svgY: 200 },
    })
    expect(a.anchor2d).toEqual({ svgX: 100, svgY: 200 })
    expect(a.anchorUv).toBeNull()
  })

  it('update never overwrites anchorUv (D2 SoT discipline)', async () => {
    const scan = await seedScan(repo)
    const a = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'damage',
      anchorUv: uvAnchor,
    })
    const updated = await repo.updateScanAnnotation(a.id, {
      status: 'resolved',
      confidence: 'low',
      lastDriftCheckAt: Date.now(),
      lastDriftDistanceM: 0.42,
      anchorWorldCache: {
        usdz: { x: 1, y: 2, z: 3 },
        computedAt: new Date().toISOString(),
      },
    })
    expect(updated.anchorUv).toEqual(uvAnchor)
    expect(updated.confidence).toBe('low')
    expect(updated.anchorWorldCache?.usdz).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe('InMemorySpatialRepository — dispute-lock guard', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('blocks child-table writes (INSERT/UPDATE) once scan is locked', async () => {
    const scan = await seedScan(repo)
    await walkScanToLockedForDispute(repo, scan.id)

    await expect(
      repo.createScanRoom({ scanId: scan.id }),
    ).rejects.toThrow(/locked_for_dispute/)
    await expect(
      repo.createScanMeasurement({ scanId: scan.id }),
    ).rejects.toThrow(/locked_for_dispute/)
    await expect(
      repo.createScanAnnotation({
        scanId: scan.id,
        kind: 'note',
        anchor2d: { svgX: 1, svgY: 1 },
      }),
    ).rejects.toThrow(/locked_for_dispute/)
    await expect(
      repo.createScanAsset({ scanId: scan.id, kind: 'thumbnail', storagePath: 't.png' }),
    ).rejects.toThrow(/locked_for_dispute/)
  })

  it('blocks measurement verify on locked scan', async () => {
    const scan = await seedScan(repo)
    const m = await repo.createScanMeasurement({ scanId: scan.id })
    await walkScanToLockedForDispute(repo, scan.id)
    await expect(
      repo.verifyScanMeasurement(m.id, { valueVerifiedM: 1.5, verifiedBy: USER_VERIFIER }),
    ).rejects.toThrow(/locked_for_dispute/)
  })
})

describe('InMemorySpatialRepository — read aggregates', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('getScanDetailView composes scan + assets + rooms + latest quality report', async () => {
    const scan = await seedScan(repo)
    await repo.createScanAsset({ scanId: scan.id, kind: 'usdz', storagePath: 'a.usdz' })
    await repo.createScanRoom({ scanId: scan.id, name: 'Bad' })
    await repo.createScanQualityReport({
      scanId: scan.id,
      score: 70,
      bucket: 'good',
      warnings: ['wall_coverage_low'],
      engineVersion: 'v1',
    })
    await new Promise(r => setTimeout(r, 2))
    const newer = await repo.createScanQualityReport({
      scanId: scan.id,
      score: 85,
      bucket: 'excellent',
      warnings: [],
      engineVersion: 'v1',
    })

    const view = await repo.getScanDetailView(scan.id)
    expect(view).not.toBeNull()
    expect(view!.scan.id).toBe(scan.id)
    expect(view!.assets).toHaveLength(1)
    expect(view!.rooms).toHaveLength(1)
    expect(view!.latestQualityReport?.id).toBe(newer.id)
  })

  it('getScanReviewView composes everything including surfaces flattened', async () => {
    const scan = await seedScan(repo)
    const room = await repo.createScanRoom({ scanId: scan.id })
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'w1',
      kind: 'wall',
    })
    await repo.createScanSurface({
      roomId: room.id,
      surfaceExternalId: 'd1',
      kind: 'door',
    })
    await repo.createScanMeasurement({ scanId: scan.id, label: 'wandhöhe' })
    await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'damage',
      anchorUv: { surfaceExternalId: 'w1', uv: [0.5, 0.5] },
    })

    const view = await repo.getScanReviewView(scan.id)
    expect(view).not.toBeNull()
    expect(view!.rooms).toHaveLength(1)
    expect(view!.surfaces.map(s => s.surfaceExternalId).sort()).toEqual(['d1', 'w1'])
    expect(view!.measurements).toHaveLength(1)
    expect(view!.annotations).toHaveLength(1)
  })

  it('returns null for non-existent scan', async () => {
    expect(await repo.getScanDetailView('nope')).toBeNull()
    expect(await repo.getScanReviewView('nope')).toBeNull()
  })
})

describe('InMemorySpatialRepository — recordScanEvent (idempotent audit append)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('inserts a new event with derived actor + payload', async () => {
    const scan = await seedScan(repo)
    const ev = await repo.recordScanEvent(scan.id, 'captured', { fps: 32 }, undefined, USER_CAPTURER)
    expect(ev.scanId).toBe(scan.id)
    expect(ev.action).toBe('captured')
    expect(ev.actorId).toBe(USER_CAPTURER)
    expect(ev.payload).toMatchObject({ fps: 32 })
  })

  it('idempotency: same (scanId, key) returns the first event, no double-insert', async () => {
    const scan = await seedScan(repo)
    const key = '6d8a5c7b-1111-2222-3333-444444444444'
    const first = await repo.recordScanEvent(scan.id, 'quality_run', { score: 80 }, key, USER_CAPTURER)
    const second = await repo.recordScanEvent(scan.id, 'quality_run', { score: 99 }, key, USER_CAPTURER)
    expect(second.id).toBe(first.id)
    expect((await repo.listScanEvents(scan.id))).toHaveLength(1)
  })

  it('different idempotency keys yield independent rows', async () => {
    const scan = await seedScan(repo)
    await repo.recordScanEvent(scan.id, 'verified', {}, '11111111-1111-1111-1111-111111111111', USER_CAPTURER)
    await repo.recordScanEvent(scan.id, 'verified', {}, '22222222-2222-2222-2222-222222222222', USER_CAPTURER)
    expect(await repo.listScanEvents(scan.id)).toHaveLength(2)
  })

  it('throws when the scan does not exist', async () => {
    await expect(
      repo.recordScanEvent('nope', 'captured'),
    ).rejects.toThrow(/scan .* not found/)
  })
})

describe('InMemorySpatialRepository — scan_annotations customer_visible (Block 3)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  const uv: AnchorUv = { surfaceExternalId: 'wall_1', uv: [0.5, 0.5] }

  it('defaults customer_visible per kind (damage/photo/measurement_ref → true)', async () => {
    const scan = await seedScan(repo)
    const damage = await repo.createScanAnnotation({ scanId: scan.id, kind: 'damage', anchorUv: uv })
    const photo = await repo.createScanAnnotation({ scanId: scan.id, kind: 'photo', anchorUv: uv })
    const meas = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'measurement_ref',
      anchorUv: uv,
    })
    expect(damage.customerVisible).toBe(true)
    expect(photo.customerVisible).toBe(true)
    expect(meas.customerVisible).toBe(true)
  })

  it('defaults customer_visible per kind (note/gewerk_marker → false)', async () => {
    const scan = await seedScan(repo)
    const note = await repo.createScanAnnotation({ scanId: scan.id, kind: 'note', anchorUv: uv })
    const marker = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'gewerk_marker',
      anchorUv: uv,
    })
    expect(note.customerVisible).toBe(false)
    expect(marker.customerVisible).toBe(false)
  })

  it('explicit customerVisible override wins over kind default', async () => {
    const scan = await seedScan(repo)
    const overridden = await repo.createScanAnnotation({
      scanId: scan.id,
      kind: 'note',
      anchorUv: uv,
      customerVisible: true,
    })
    expect(overridden.customerVisible).toBe(true)
  })

  it('updateScanAnnotation flips customer_visible', async () => {
    const scan = await seedScan(repo)
    const damage = await repo.createScanAnnotation({ scanId: scan.id, kind: 'damage', anchorUv: uv })
    const hidden = await repo.updateScanAnnotation(damage.id, { customerVisible: false })
    expect(hidden.customerVisible).toBe(false)
    const shown = await repo.updateScanAnnotation(damage.id, { customerVisible: true })
    expect(shown.customerVisible).toBe(true)
  })
})

describe('InMemorySpatialRepository — listCustomerVisibleScans (Block 3)', () => {
  let repo: InMemorySpatialRepository
  const CUSTOMER = 'customer_uuid_42'
  const CUSTOMER_B = 'customer_uuid_other'
  const HW = 'hw_uuid_7'

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  async function seedHwShared(opts: { jobId: string; shared: boolean }) {
    const scan = await repo.createScan({
      jobId: opts.jobId,
      source: 'roomplan',
      capturedBy: HW,
      ownerType: 'craftsman',
    })
    if (opts.shared) {
      const current = await repo.getScan(scan.id)
      if (!current) throw new Error('seed scan missing')
      // bypass update FSM by mutating the repo directly via test helper:
      // updateScan does not expose sharedWithCustomer; tests for the share
      // toggle live with the Supabase RLS suite. Use a fresh row that already
      // has the shared flag flipped via raw map mutation.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(repo as any).scans.set(scan.id, {
        ...current,
        sharedWithCustomer: true,
        sharedAt: Date.now(),
      })
    }
    return scan
  }

  async function seedSelfScan(opts: { customer: string }) {
    return repo.createScan({
      source: 'manual',
      capturedBy: opts.customer,
      ownerType: 'customer',
    })
  }

  it('returns Self-Scan owned by the customer', async () => {
    const self = await seedSelfScan({ customer: CUSTOMER })
    const result = await repo.listCustomerVisibleScans(CUSTOMER)
    expect(result.map(s => s.id)).toEqual([self.id])
  })

  it('returns HW-shared scan on any job', async () => {
    const shared = await seedHwShared({ jobId: 'job_x', shared: true })
    const result = await repo.listCustomerVisibleScans(CUSTOMER)
    expect(result.map(s => s.id)).toEqual([shared.id])
  })

  it('hides HW-private scans (shared_with_customer=false)', async () => {
    await seedHwShared({ jobId: 'job_x', shared: false })
    const result = await repo.listCustomerVisibleScans(CUSTOMER)
    expect(result).toEqual([])
  })

  it('hides other customers Self-Scans', async () => {
    await seedSelfScan({ customer: CUSTOMER_B })
    const result = await repo.listCustomerVisibleScans(CUSTOMER)
    expect(result).toEqual([])
  })

  it('combines Self-Scan + HW-shared sorted by createdAt desc', async () => {
    const self = await seedSelfScan({ customer: CUSTOMER })
    // ensure ordering by tweaking createdAt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(repo as any).scans.set(self.id, { ...(await repo.getScan(self.id))!, createdAt: 1000 })
    const shared = await seedHwShared({ jobId: 'job_x', shared: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(repo as any).scans.set(shared.id, { ...(await repo.getScan(shared.id))!, createdAt: 2000 })
    const result = await repo.listCustomerVisibleScans(CUSTOMER)
    expect(result.map(s => s.id)).toEqual([shared.id, self.id])
  })
})

describe('InMemorySpatialRepository — multi-project isolation', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('listScansForProject only returns scans of that project', async () => {
    await seedScan(repo, { projectId: PROJECT_A })
    await seedScan(repo, { projectId: PROJECT_A })
    await seedScan(repo, { projectId: PROJECT_B })

    const a = await repo.listScansForProject(PROJECT_A)
    const b = await repo.listScansForProject(PROJECT_B)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)
  })

  it('listScansForJob only returns scans of that job', async () => {
    await seedScan(repo, { jobId: JOB_A, projectId: null })
    await seedScan(repo, { jobId: JOB_A, projectId: null })
    await seedScan(repo, { jobId: 'job_b', projectId: null })

    const jobs = await repo.listScansForJob(JOB_A)
    expect(jobs).toHaveLength(2)
    expect(jobs.every(s => s.jobId === JOB_A)).toBe(true)
  })
})

describe('InMemorySpatialRepository — updateScanSharing (Block 2)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  it('happy share — sets sharedWithCustomer=true + stamps sharedAt + bumps updatedAt', async () => {
    const scan = await seedScan(repo, { jobId: JOB_A, projectId: null })
    expect(scan.sharedWithCustomer).toBe(false)
    expect(scan.sharedAt).toBeNull()
    // ensure clock moves so the bump is observable
    await new Promise(r => setTimeout(r, 2))
    const shared = await repo.updateScanSharing(scan.id, true)
    expect(shared.sharedWithCustomer).toBe(true)
    expect(shared.sharedAt).toBeGreaterThan(0)
    expect(shared.updatedAt).toBeGreaterThan(scan.updatedAt)
  })

  it('happy unshare — clears sharedAt back to null', async () => {
    const scan = await seedScan(repo, { jobId: JOB_A, projectId: null })
    const shared = await repo.updateScanSharing(scan.id, true)
    expect(shared.sharedAt).not.toBeNull()
    const unshared = await repo.updateScanSharing(scan.id, false)
    expect(unshared.sharedWithCustomer).toBe(false)
    expect(unshared.sharedAt).toBeNull()
  })

  it('sharing without job throws — mirror of DB CHECK scans_sharing_requires_job_chk', async () => {
    const scan = await seedScan(repo, { projectId: PROJECT_A })
    expect(scan.jobId).toBeNull()
    await expect(repo.updateScanSharing(scan.id, true)).rejects.toThrow(
      /scans_sharing_requires_job_chk/,
    )
  })

  it('unshare on jobless scan is a no-op (already false)', async () => {
    const scan = await seedScan(repo, { projectId: PROJECT_A })
    const result = await repo.updateScanSharing(scan.id, false)
    expect(result.sharedWithCustomer).toBe(false)
    // Same instance returned — no updatedAt bump.
    expect(result.updatedAt).toBe(scan.updatedAt)
  })

  it('same-value re-share short-circuits — no updatedAt bump (mirrors DB trigger no-op)', async () => {
    const scan = await seedScan(repo, { jobId: JOB_A, projectId: null })
    const first = await repo.updateScanSharing(scan.id, true)
    await new Promise(r => setTimeout(r, 2))
    const second = await repo.updateScanSharing(scan.id, true)
    expect(second.updatedAt).toBe(first.updatedAt)
    expect(second.sharedAt).toBe(first.sharedAt)
  })

  it('unknown scan throws', async () => {
    await expect(repo.updateScanSharing('does_not_exist', true)).rejects.toThrow(
      /not found/,
    )
  })

  it('write blocked when scan is locked_for_dispute', async () => {
    const scan = await seedScan(repo, { jobId: JOB_A, projectId: null })
    // walk to locked_for_dispute via the FSM
    await repo.updateScan(scan.id, { status: 'capturing' })
    await repo.updateScan(scan.id, { status: 'captured' })
    await repo.updateScan(scan.id, { status: 'quality_checked' })
    await repo.updateScan(scan.id, { status: 'provider_verified' })
    await repo.updateScan(scan.id, { status: 'locked_for_dispute' })
    await expect(repo.updateScanSharing(scan.id, true)).rejects.toThrow(
      /locked_for_dispute/,
    )
  })
})

describe('InMemorySpatialRepository — Phase 2 Customer-LiDAR (F1 + F2)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
  })

  // ── updateScanQuality (F1) ────────────────────────────────────────────────

  it('updateScanQuality writes score + label and exposes them via test-helper', async () => {
    const scan = await seedScan(repo)
    const result = await repo.updateScanQuality({
      scanId: scan.id,
      score: 82,
      label: 'high',
    })
    expect(result.id).toBe(scan.id)
    const persisted = repo.getScanQuality(scan.id)
    expect(persisted).toEqual({ score: 82, label: 'high' })
  })

  it('updateScanQuality clamps the DB CHECK on score range', async () => {
    const scan = await seedScan(repo)
    await expect(
      repo.updateScanQuality({ scanId: scan.id, score: -1, label: 'low' }),
    ).rejects.toThrow(/out of \[0, 100\] range/)
    await expect(
      repo.updateScanQuality({ scanId: scan.id, score: 101, label: 'high' }),
    ).rejects.toThrow(/out of \[0, 100\] range/)
  })

  it('updateScanQuality on unknown scan throws', async () => {
    await expect(
      repo.updateScanQuality({ scanId: 'missing', score: 50, label: 'medium' }),
    ).rejects.toThrow(/not found/)
  })

  // ── uploadMeshSnapshot (F2) ───────────────────────────────────────────────

  it('uploadMeshSnapshot stores blob size at the expected path', async () => {
    const scan = await seedScan(repo, {
      ownerType: 'customer',
      projectId: null,
    })
    const blob = new Blob([new Uint8Array([0x55, 0x53, 0x44, 0x5a])], {
      type: 'model/vnd.usdz+zip',
    })
    const result = await repo.uploadMeshSnapshot({
      scanId: scan.id,
      userId: USER_CAPTURER,
      blob,
    })
    expect(result.path).toBe(`${USER_CAPTURER}/${scan.id}.usdz`)
    expect(repo.getMeshSnapshotBytes(result.path)).toBe(blob.size)
  })

  it('uploadMeshSnapshot refuses duplicate upserts (mirrors upsert:false)', async () => {
    const scan = await seedScan(repo, {
      ownerType: 'customer',
      projectId: null,
    })
    const blob = new Blob([new Uint8Array([1, 2, 3])], {
      type: 'model/vnd.usdz+zip',
    })
    await repo.uploadMeshSnapshot({
      scanId: scan.id,
      userId: USER_CAPTURER,
      blob,
    })
    await expect(
      repo.uploadMeshSnapshot({
        scanId: scan.id,
        userId: USER_CAPTURER,
        blob,
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('uploadMeshSnapshot rejects empty blob', async () => {
    const scan = await seedScan(repo, {
      ownerType: 'customer',
      projectId: null,
    })
    const empty = new Blob([], { type: 'model/vnd.usdz+zip' })
    await expect(
      repo.uploadMeshSnapshot({
        scanId: scan.id,
        userId: USER_CAPTURER,
        blob: empty,
      }),
    ).rejects.toThrow(/blob is empty/)
  })
})
