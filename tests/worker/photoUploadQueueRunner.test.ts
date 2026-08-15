import { describe, it, expect, vi, beforeEach } from 'vitest'

const { storage, storageUploadMock, storageFromMock, authGetSessionMock } = vi.hoisted(() => ({
  storage: new Map<string, unknown>(),
  storageUploadMock: vi.fn(),
  storageFromMock: vi.fn(),
  authGetSessionMock: vi.fn(),
}))

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => storage.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    storage.set(key, value)
  }),
  del: vi.fn(async (key: string) => {
    storage.delete(key)
  }),
}))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    storage: { from: storageFromMock },
    auth: { getSession: authGetSessionMock },
  },
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import {
  enqueuePhotoUpload,
  peekPhotoUploads,
  __testOnly_resetQueue,
} from '../../src/lib/worker/photoUploadQueue'
import {
  runPhotoUploadQueueNowForTest,
  __testOnly_resetRunner,
} from '../../src/lib/worker/photoUploadQueueRunner'
import type { JobPhotoRepository } from '../../src/lib/worker/repository/JobPhotoRepository'

// NOW = real Date.now() at test start, so photoUploadQueue's 7-day age
// cap doesn't prune our fixtures. Vitest fakeTimers + setSystemTime had
// inconsistent interaction with the idb-keyval mock — using real-now is
// simpler and equally deterministic for these short-lived assertions.
const NOW = Date.now()

function makeBlob(): Blob {
  return new Blob(['jpeg'], { type: 'image/jpeg' })
}

function makeRepo(overrides: Partial<JobPhotoRepository> = {}): JobPhotoRepository {
  return {
    listForJob: vi.fn(),
    add: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

function mockSession(userId: string) {
  authGetSessionMock.mockResolvedValue({ data: { session: { user: { id: userId } } } })
}

beforeEach(async () => {
  storage.clear()
  storageUploadMock.mockReset()
  storageFromMock.mockReset()
  authGetSessionMock.mockReset()
  storageFromMock.mockReturnValue({ upload: storageUploadMock })
  // Default: user 'u-1' is logged in (matches uploadedBy in fixtures below).
  mockSession('u-1')
  __testOnly_resetRunner()
  await __testOnly_resetQueue()
})

describe('Block FU-A · photoUploadQueueRunner', () => {
  it('drains a single pending upload to bucket worker-doku-photos + repo', async () => {
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    const addMock = vi.fn().mockResolvedValue({
      id: 'p-1',
      jobId: 'j-1',
      providerId: 'prov-1',
      uploadedBy: 'u-1',
      storagePath: 'jobs/j-1/cu-1.jpg',
      clientUuid: 'cu-1',
      createdAt: NOW,
    })
    const repo = makeRepo({ add: addMock })

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-1',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-1.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
        sizeBytes: 100,
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    expect(storageFromMock).toHaveBeenCalledWith('worker-doku-photos')
    expect(storageUploadMock).toHaveBeenCalledWith(
      'jobs/j-1/cu-1.jpg',
      expect.any(Blob),
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(addMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUuid: 'cu-1',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-1.jpg',
      }),
    )

    // Queue ist nach erfolgreichem Drain leer.
    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(0)
  })

  it('leaves entry in queue + increments attempts when storage upload fails', async () => {
    storageUploadMock.mockResolvedValue({
      data: null,
      error: { message: 'network down' },
    })
    const addMock = vi.fn()
    const repo = makeRepo({ add: addMock })

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-2',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-2.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    expect(addMock).not.toHaveBeenCalled()
    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.attempts).toBe(1)
  })

  it('removes entry when storage says already-exists + DB-INSERT succeeds (idempotent recovery)', async () => {
    storageUploadMock.mockResolvedValue({
      data: null,
      error: { message: 'The resource already exists' },
    })
    const addMock = vi.fn().mockResolvedValue({
      id: 'p-3',
      jobId: 'j-1',
      providerId: 'prov-1',
      uploadedBy: 'u-1',
      storagePath: 'jobs/j-1/cu-3.jpg',
      clientUuid: 'cu-3',
      createdAt: NOW,
    })
    const repo = makeRepo({ add: addMock })

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-3',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-3.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    expect(addMock).toHaveBeenCalled()
    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(0)
  })

  it('removes entry when DB-INSERT returns 23505 (already inserted)', async () => {
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    const addMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    )
    const repo = makeRepo({ add: addMock })

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-4',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-4.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(0)
  })

  it('keeps entry on non-23505 DB error (retry next tick)', async () => {
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    const addMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('rls'), { code: '42501' }),
    )
    const repo = makeRepo({ add: addMock })

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-5',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-5.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.attempts).toBe(1)
  })

  it('does nothing when queue is empty', async () => {
    const repo = makeRepo()
    await runPhotoUploadQueueNowForTest({ repository: repo })
    expect(storageFromMock).not.toHaveBeenCalled()
    expect(repo.add).not.toHaveBeenCalled()
  })

  it('FU.8 — drops entry + logs warning when uploadedBy !== current session user', async () => {
    const { logWarning } = await import('../../src/lib/observability')
    mockSession('u-other')
    const repo = makeRepo()

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-mismatch',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-mismatch.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    expect(storageUploadMock).not.toHaveBeenCalled()
    expect(repo.add).not.toHaveBeenCalled()
    expect(logWarning).toHaveBeenCalledWith(
      'worker.photo_queue.dropped_user_mismatch',
      expect.objectContaining({ clientUuid: 'cu-mismatch', uploadedBy: 'u-1' }),
    )
    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(0)
  })

  it('FU.8 — skips entire tick when no active session (queue preserved)', async () => {
    authGetSessionMock.mockResolvedValue({ data: { session: null } })
    const repo = makeRepo()

    await enqueuePhotoUpload(
      {
        clientUuid: 'cu-nosession',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu-nosession.jpg',
        blob: makeBlob(),
        contentType: 'image/jpeg',
      },
      NOW,
    )

    await runPhotoUploadQueueNowForTest({ repository: repo })

    expect(storageUploadMock).not.toHaveBeenCalled()
    expect(repo.add).not.toHaveBeenCalled()
    const remaining = await peekPhotoUploads(NOW + 1000)
    expect(remaining).toHaveLength(1)
  })
})
