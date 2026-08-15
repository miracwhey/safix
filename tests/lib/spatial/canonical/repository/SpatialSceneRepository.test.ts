/**
 * SpatialSceneRepository · findBySourceJob / findBySourceScan / create —
 * repository unit tests (Phase C · C-2 · Seam 11 · Szenen-Produktion B2).
 *
 * Covers the job → scene lookup that replaces the Phase-B list-then-filter
 * (`listByProviderOrg` + client-side `.find()`), the scan → scene idempotency
 * lookup, and the client-generated-id / validationReport create contract.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemorySpatialSceneRepository } from '../../../../../src/lib/spatial/canonical/repository/InMemorySpatialSceneRepository'

describe('SpatialSceneRepository · findBySourceJob', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
  })

  it('returns the scene attached to a job', async () => {
    const created = await repo.create({
      parametricStoragePath: 'u/s/parametric.json.gz',
      sourceJobId: 'job-1',
    })
    const found = await repo.findBySourceJob('job-1')
    expect(found).not.toBeNull()
    expect(found?.id).toBe(created.id)
  })

  it('returns null for a job with no scene', async () => {
    await repo.create({
      parametricStoragePath: 'u/s/parametric.json.gz',
      sourceJobId: 'job-1',
    })
    expect(await repo.findBySourceJob('job-unknown')).toBeNull()
  })

  it('does not return a different job\'s scene', async () => {
    await repo.create({ parametricStoragePath: 'a', sourceJobId: 'job-1' })
    expect(await repo.findBySourceJob('job-2')).toBeNull()
  })

  it('returns the newest scene when a job carries multiple', async () => {
    const first = await repo.create({ parametricStoragePath: 'a', sourceJobId: 'job-1' })
    // Distinct millisecond timestamp so the newest-first order is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await repo.create({ parametricStoragePath: 'b', sourceJobId: 'job-1' })

    const found = await repo.findBySourceJob('job-1')
    expect(found?.id).toBe(second.id)
    expect(found?.id).not.toBe(first.id)
  })
})

describe('SpatialSceneRepository · findBySourceScan', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
  })

  it('returns the scene produced from a scan', async () => {
    const created = await repo.create({
      parametricStoragePath: 'u/s/parametric.json.gz',
      sourceScanId: 'scan-1',
    })
    const found = await repo.findBySourceScan('scan-1')
    expect(found?.id).toBe(created.id)
  })

  it('returns null for a scan that was never promoted', async () => {
    await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(await repo.findBySourceScan('scan-unknown')).toBeNull()
  })

  it("does not return a different scan's scene", async () => {
    await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(await repo.findBySourceScan('scan-2')).toBeNull()
  })
})

describe('SpatialSceneRepository · create', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
  })

  it('honours a client-generated scene id', async () => {
    const created = await repo.create({
      id: 'scene-fixed-id',
      parametricStoragePath: 'a',
      sourceScanId: 'scan-1',
    })
    expect(created.id).toBe('scene-fixed-id')
    expect((await repo.findById('scene-fixed-id'))?.id).toBe('scene-fixed-id')
  })

  it('generates a uuid when id is omitted', async () => {
    const created = await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('rejects a duplicate explicit id', async () => {
    await repo.create({ id: 'dup', parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    await expect(
      repo.create({ id: 'dup', parametricStoragePath: 'b', sourceJobId: 'job-1' }),
    ).rejects.toThrow(/already exists/i)
  })

  it('folds a non-empty validationReport into metadata.validation_report', async () => {
    const created = await repo.create({
      parametricStoragePath: 'a',
      sourceScanId: 'scan-1',
      validationReport: { errors: 0, warnings: 2 },
    })
    expect(created.metadata.validation_report).toEqual({ errors: 0, warnings: 2 })
  })

  it('leaves metadata untouched when validationReport is empty', async () => {
    const created = await repo.create({
      parametricStoragePath: 'a',
      sourceScanId: 'scan-1',
      validationReport: {},
      metadata: { k: 'v' },
    })
    expect(created.metadata).toEqual({ k: 'v' })
  })
})

describe('SpatialSceneRepository · D2 · B7 versioning linkage', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
  })

  async function seedParent(): Promise<{ parentId: string; orgId: string }> {
    const parent = await repo.create({
      id: 'parent-scene',
      parametricStoragePath: 'parent.gz',
      sourceScanId: 'parent-scan',
      providerOrgId: 'org-1',
      customerId: 'customer-1',
    })
    return { parentId: parent.id, orgId: 'org-1' }
  }

  async function seedAcceptedRequest(sceneId: string, orgId: string) {
    const request = await repo.createRescanRequest({
      sceneId,
      providerOrgId: orgId,
      requestedByUserId: 'worker-1',
      requestedByRole: 'worker',
      reason: 'walls drift',
    })
    await repo.respondToRescanRequest(request.id, 'accepted', null)
    return request
  }

  it('records parentSceneId on a plain parent linkage', async () => {
    const { parentId } = await seedParent()
    const child = await repo.create({
      parametricStoragePath: 'child.gz',
      sourceScanId: 'child-scan',
      parentSceneId: parentId,
    })
    expect(child.parentSceneId).toBe(parentId)
  })

  it('atomically writes resulting_scene_id onto the rescan request on success', async () => {
    const { parentId, orgId } = await seedParent()
    const request = await seedAcceptedRequest(parentId, orgId)
    const child = await repo.create({
      parametricStoragePath: 'child.gz',
      sourceScanId: 'child-scan',
      rescanRequestId: request.id,
    })
    expect(child.parentSceneId).toBe(parentId)
    const refreshed = await repo.findRescanRequestById(request.id)
    expect(refreshed?.resultingSceneId).toBe(child.id)
  })

  it('derives parentSceneId from the rescan request when omitted', async () => {
    const { parentId, orgId } = await seedParent()
    const request = await seedAcceptedRequest(parentId, orgId)
    const child = await repo.create({
      parametricStoragePath: 'child.gz',
      sourceScanId: 'child-scan',
      rescanRequestId: request.id,
    })
    expect(child.parentSceneId).toBe(parentId)
  })

  it('rejects a parent mismatch when both rescanRequestId and parentSceneId are supplied', async () => {
    const { parentId, orgId } = await seedParent()
    const request = await seedAcceptedRequest(parentId, orgId)
    await expect(
      repo.create({
        parametricStoragePath: 'child.gz',
        sourceScanId: 'child-scan',
        rescanRequestId: request.id,
        parentSceneId: 'someone-elses-parent',
      }),
    ).rejects.toThrow(/parentSceneId must match/i)
  })

  it('rejects a rescan request that is not accepted', async () => {
    const { parentId, orgId } = await seedParent()
    const request = await repo.createRescanRequest({
      sceneId: parentId,
      providerOrgId: orgId,
      requestedByUserId: 'worker-1',
      requestedByRole: 'worker',
      reason: 'walls drift',
    })
    await expect(
      repo.create({
        parametricStoragePath: 'child.gz',
        sourceScanId: 'child-scan',
        rescanRequestId: request.id,
      }),
    ).rejects.toThrow(/must be accepted/i)
  })

  it('rejects an unknown rescanRequestId', async () => {
    await expect(
      repo.create({
        parametricStoragePath: 'child.gz',
        sourceScanId: 'child-scan',
        rescanRequestId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('is idempotent — a second create for the same fulfilled request returns the existing scene', async () => {
    const { parentId, orgId } = await seedParent()
    const request = await seedAcceptedRequest(parentId, orgId)
    const first = await repo.create({
      parametricStoragePath: 'child.gz',
      sourceScanId: 'child-scan',
      rescanRequestId: request.id,
    })
    // A different new scan_id, same request — the request is already fulfilled
    // so the existing scene is returned (mirror of the RPC short-circuit).
    const second = await repo.create({
      parametricStoragePath: 'second.gz',
      sourceScanId: 'second-scan',
      rescanRequestId: request.id,
    })
    expect(second.id).toBe(first.id)
  })
})

describe('SpatialSceneRepository · updateCustomerVerifyState + parametric_version (H1/L4.b)', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
  })

  it('walks a legal verify-state transition and stamps the resume columns', async () => {
    const s = await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(s.customerVerifyState).toBe('not_started')
    const r = await repo.updateCustomerVerifyState(s.id, {
      customerVerifyState: 'in_progress',
      customerVerifyLastStage: 2,
      customerVerifyLastActiveAt: '2026-06-01T10:00:00.000Z',
    })
    expect(r.customerVerifyState).toBe('in_progress')
    expect(r.customerVerifyLastStage).toBe(2)
    expect(r.customerVerifyLastActiveAt).toBe('2026-06-01T10:00:00.000Z')
  })

  it('rejects an illegal verify-state transition (not_started → approved)', async () => {
    const s = await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    await expect(
      repo.updateCustomerVerifyState(s.id, { customerVerifyState: 'approved' }),
    ).rejects.toThrow()
  })

  it('a stage-only touch keeps the state and does NOT bump parametric_version', async () => {
    const s = await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(s.parametricVersion).toBe(0)
    const r = await repo.updateCustomerVerifyState(s.id, { customerVerifyLastStage: 3 })
    expect(r.customerVerifyState).toBe('not_started')
    expect(r.customerVerifyLastStage).toBe(3)
    expect(r.parametricVersion).toBe(0)
  })

  it('a blob/geometry update() bumps parametric_version (H1 optimistic token)', async () => {
    const s = await repo.create({ parametricStoragePath: 'a', sourceScanId: 'scan-1' })
    expect(s.parametricVersion).toBe(0)
    const u1 = await repo.update(s.id, { parametricStoragePath: 'b' })
    expect(u1.parametricVersion).toBe(1)
    const u2 = await repo.update(s.id, { isRenderable: true })
    expect(u2.parametricVersion).toBe(2)
  })
})
