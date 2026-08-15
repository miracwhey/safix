/**
 * promoteScanToScene — workflow orchestrator unit tests (Szenen-Produktion · B4).
 *
 * The native plugin + the encode/upload storage seam are module-mocked; the
 * scene repository is a real InMemory instance. Covers idempotency, the three
 * typed failure reasons, the happy path, and the validation_state derivation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roomPlanMock, encodeMock, uploadMock } = vi.hoisted(() => ({
  roomPlanMock: { getCanonicalScene: vi.fn() },
  encodeMock: vi.fn(),
  uploadMock: vi.fn(),
}))

vi.mock('@fixup/capacitor-roomplan', () => ({ RoomPlan: roomPlanMock }))
vi.mock(
  '../../../../../src/lib/spatial/canonical/storage/parametric-storage',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../../src/lib/spatial/canonical/storage/parametric-storage')
      >()
    return { ...actual, encodeParametricBlob: encodeMock }
  },
)
vi.mock(
  '../../../../../src/lib/spatial/canonical/storage/uploadParametricBlob',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../../src/lib/spatial/canonical/storage/uploadParametricBlob')
      >()
    return { ...actual, uploadParametricBlob: uploadMock }
  },
)

import { InMemorySpatialSceneRepository } from '../../../../../src/lib/spatial/canonical/repository/InMemorySpatialSceneRepository'
import { promoteScanToScene } from '../../../../../src/lib/spatial/canonical/workflow/promoteScanToScene'

/** A ValidationReport-shaped object with `errors`/`warnings` counts. */
function makeReport(errors = 0, warnings = 0) {
  return {
    scene_id: 'scan-1',
    validated_at: '2026-05-22T00:00:00.000Z',
    errors: Array.from({ length: errors }, () => ({
      code: 'ROOM_NO_WALLS',
      severity: 'error',
      affected_node_ids: [],
      message: 'err',
    })),
    warnings: Array.from({ length: warnings }, () => ({
      code: 'WALL_HEIGHT_UNUSUAL',
      severity: 'warning',
      affected_node_ids: [],
      message: 'warn',
    })),
    hints: [],
    is_renderable: true,
    is_walkable: true,
    requires_user_confirmation: errors > 0,
  }
}

/** A converter document carrying an embedded validation_report. */
function makeDocument(errors = 0, warnings = 0) {
  return {
    schema_version: '1.0',
    scene_graph: { id: 'scan-1' },
    validation_report: makeReport(errors, warnings),
  }
}

const INPUT = { scanId: 'scan-1', uploaderUserId: 'user-1' }

describe('promoteScanToScene', () => {
  let repo: InMemorySpatialSceneRepository

  beforeEach(() => {
    repo = new InMemorySpatialSceneRepository()
    roomPlanMock.getCanonicalScene.mockReset()
    encodeMock.mockReset()
    uploadMock.mockReset()
    roomPlanMock.getCanonicalScene.mockResolvedValue({ document: makeDocument() })
    encodeMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      sha256: 'abc123',
      sizeBytes: 3,
    })
    uploadMock.mockImplementation((path: string) => Promise.resolve({ ok: true, path }))
  })

  it('creates a scene end-to-end and records the SHA + content-addressed path', async () => {
    const result = await promoteScanToScene(INPUT, repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyExisted).toBe(false)
    expect(result.scene.sourceScanId).toBe('scan-1')
    expect(result.scene.parametricSha256).toBe('abc123')
    expect(result.scene.parametricStoragePath).toBe('user-1/' + result.scene.id + '/parametric-abc123.json.gz')
    expect(result.scene.validationState).toBe('passed')
    // The scene is persisted + discoverable by the idempotency lookup.
    expect((await repo.findBySourceScan('scan-1'))?.id).toBe(result.scene.id)
  })

  it('is idempotent — a re-promotion returns the existing scene without converting', async () => {
    const first = await promoteScanToScene(INPUT, repo)
    expect(first.ok).toBe(true)
    roomPlanMock.getCanonicalScene.mockClear()

    const second = await promoteScanToScene(INPUT, repo)
    expect(second.ok).toBe(true)
    if (!second.ok || !first.ok) return
    expect(second.alreadyExisted).toBe(true)
    expect(second.scene.id).toBe(first.scene.id)
    expect(roomPlanMock.getCanonicalScene).not.toHaveBeenCalled()
  })

  it('maps a document with errors → validation_state blocked', async () => {
    roomPlanMock.getCanonicalScene.mockResolvedValue({ document: makeDocument(2, 0) })
    const result = await promoteScanToScene(INPUT, repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scene.validationState).toBe('blocked')
    expect(result.scene.requiresUserConfirmation).toBe(true)
  })

  it('maps a document with only warnings → validation_state passed_with_warnings', async () => {
    roomPlanMock.getCanonicalScene.mockResolvedValue({ document: makeDocument(0, 3) })
    const result = await promoteScanToScene(INPUT, repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scene.validationState).toBe('passed_with_warnings')
  })

  it('returns convert_failed when the native converter rejects', async () => {
    roomPlanMock.getCanonicalScene.mockRejectedValue(
      Object.assign(new Error('no scan'), { code: 'CANONICAL_CONVERT_NO_SCAN' }),
    )
    const result = await promoteScanToScene(INPUT, repo)
    expect(result).toMatchObject({ ok: false, reason: 'convert_failed' })
    expect(encodeMock).not.toHaveBeenCalled()
  })

  it('returns convert_failed when the document fails to encode', async () => {
    encodeMock.mockRejectedValue(new Error('schema invalid'))
    const result = await promoteScanToScene(INPUT, repo)
    expect(result).toMatchObject({ ok: false, reason: 'convert_failed' })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('returns upload_failed when the blob upload fails', async () => {
    uploadMock.mockResolvedValue({ ok: false, error: 'storage down' })
    const result = await promoteScanToScene(INPUT, repo)
    expect(result).toMatchObject({ ok: false, reason: 'upload_failed', message: 'storage down' })
    expect(await repo.findBySourceScan('scan-1')).toBeNull()
  })

  it('returns insert_failed when the scene RPC rejects', async () => {
    vi.spyOn(repo, 'create').mockRejectedValue(new Error('rpc denied'))
    const result = await promoteScanToScene(INPUT, repo)
    expect(result).toMatchObject({ ok: false, reason: 'insert_failed' })
  })

  it('passes the job context through to the scene origin', async () => {
    const result = await promoteScanToScene({ ...INPUT, jobId: 'job-9' }, repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scene.sourceJobId).toBe('job-9')
  })

  describe('D2 · B7 versioning linkage', () => {
    async function seedAcceptedRequest(parentSceneId: string) {
      await repo.create({
        id: parentSceneId,
        parametricStoragePath: 'parent.gz',
        sourceScanId: 'parent-scan',
        customerId: 'customer-1',
        providerOrgId: 'org-1',
      })
      const request = await repo.createRescanRequest({
        sceneId: parentSceneId,
        providerOrgId: 'org-1',
        requestedByUserId: 'worker-1',
        requestedByRole: 'worker',
        reason: 'walls drift',
      })
      await repo.respondToRescanRequest(request.id, 'accepted', null)
      return request
    }

    it('records parentSceneId on the new scene when passed plain', async () => {
      // Seed a parent so the InMemory repo can validate the linkage.
      await repo.create({
        id: 'parent-scene',
        parametricStoragePath: 'parent.gz',
        sourceScanId: 'parent-scan',
      })
      const result = await promoteScanToScene(
        { ...INPUT, parentSceneId: 'parent-scene' },
        repo,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.scene.parentSceneId).toBe('parent-scene')
    })

    it('writes resulting_scene_id onto the rescan request on the happy path', async () => {
      const request = await seedAcceptedRequest('parent-scene')
      const result = await promoteScanToScene(
        { ...INPUT, rescanRequestId: request.id },
        repo,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.scene.parentSceneId).toBe('parent-scene')
      const refreshed = await repo.findRescanRequestById(request.id)
      expect(refreshed?.resultingSceneId).toBe(result.scene.id)
    })

    it('short-circuits without converting when the request is already fulfilled', async () => {
      const request = await seedAcceptedRequest('parent-scene')
      // First call fulfils the request.
      const first = await promoteScanToScene(
        { ...INPUT, rescanRequestId: request.id },
        repo,
      )
      expect(first.ok).toBe(true)
      roomPlanMock.getCanonicalScene.mockClear()
      encodeMock.mockClear()
      uploadMock.mockClear()

      // Second call with a different scan id — Pre-Check 1.5 returns the
      // request's resulting_scene without touching the native converter or
      // re-uploading a blob.
      const second = await promoteScanToScene(
        { scanId: 'fresh-scan', uploaderUserId: 'user-1', rescanRequestId: request.id },
        repo,
      )
      expect(second.ok).toBe(true)
      if (!second.ok || !first.ok) return
      expect(second.alreadyExisted).toBe(true)
      expect(second.scene.id).toBe(first.scene.id)
      expect(roomPlanMock.getCanonicalScene).not.toHaveBeenCalled()
      expect(encodeMock).not.toHaveBeenCalled()
      expect(uploadMock).not.toHaveBeenCalled()
    })

    it('returns insert_failed when the rescan request is not accepted', async () => {
      // Seed parent + a request that is still pending (no respondTo).
      await repo.create({
        id: 'parent-scene',
        parametricStoragePath: 'parent.gz',
        sourceScanId: 'parent-scan',
      })
      const request = await repo.createRescanRequest({
        sceneId: 'parent-scene',
        providerOrgId: 'org-1',
        requestedByUserId: 'worker-1',
        requestedByRole: 'worker',
        reason: 'walls drift',
      })
      const result = await promoteScanToScene(
        { ...INPUT, rescanRequestId: request.id },
        repo,
      )
      expect(result).toMatchObject({ ok: false, reason: 'insert_failed' })
    })
  })
})
