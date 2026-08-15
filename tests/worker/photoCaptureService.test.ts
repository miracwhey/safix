import { describe, it, expect, vi, beforeEach } from 'vitest'

const { storageUploadMock, storageRemoveMock, storageFromMock, runPipelineMock, enqueueMock } = vi.hoisted(() => ({
  storageUploadMock: vi.fn(),
  storageRemoveMock: vi.fn(),
  storageFromMock: vi.fn(),
  runPipelineMock: vi.fn(),
  enqueueMock: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    storage: {
      from: storageFromMock,
    },
  },
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))
vi.mock('../../src/lib/media/preUploadPipeline', () => ({
  runPreUploadPipeline: runPipelineMock,
}))
vi.mock('../../src/lib/worker/photoUploadQueue', () => ({
  enqueuePhotoUpload: enqueueMock,
}))

import { uploadJobPhoto } from '../../src/lib/worker/photoCaptureService'
import type { JobPhotoRepository } from '../../src/lib/worker/repository/JobPhotoRepository'

function makeFile(name = 'photo.jpg', bytes = 'jpeg-bytes', type = 'image/jpeg'): File {
  return new File([bytes], name, { type })
}

function makeRepo(overrides: Partial<JobPhotoRepository> = {}): JobPhotoRepository {
  return {
    listForJob: vi.fn(),
    add: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  storageUploadMock.mockReset()
  storageRemoveMock.mockReset()
  storageFromMock.mockReset()
  runPipelineMock.mockReset()
  enqueueMock.mockReset()
  storageFromMock.mockReturnValue({
    upload: storageUploadMock,
    remove: storageRemoveMock,
  })
})

describe('Block C.2 · uploadJobPhoto', () => {
  it('runs pipeline, uploads to bucket worker-doku-photos, inserts row, returns CapturePhotoResult', async () => {
    const file = makeFile()
    runPipelineMock.mockResolvedValue({
      ok: true,
      file,
      diagnostics: { originalSize: 100, finalSize: 80, compressed: true, sniffedType: 'image/jpeg' },
    })
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    const repo = makeRepo({
      add: vi.fn().mockResolvedValue({
        id: 'p-1',
        jobId: 'job-42',
        providerId: 'prov-1',
        uploadedBy: 'user-w1',
        storagePath: 'jobs/job-42/cuuid-fixed.jpg',
        clientUuid: 'cuuid-fixed',
        sizeBytes: 9,
        createdAt: 1_746_374_400_000,
      }),
    })

    const result = await uploadJobPhoto(
      { jobId: 'job-42', providerId: 'prov-1', uploadedBy: 'user-w1', file },
      { repository: repo, generateClientUuid: () => 'cuuid-fixed' },
    )

    expect(storageFromMock).toHaveBeenCalledWith('worker-doku-photos')
    expect(storageUploadMock).toHaveBeenCalledWith(
      'jobs/job-42/cuuid-fixed.jpg',
      file,
      expect.objectContaining({ contentType: 'image/jpeg', upsert: false }),
    )
    expect(repo.add).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-42',
        providerId: 'prov-1',
        uploadedBy: 'user-w1',
        storagePath: 'jobs/job-42/cuuid-fixed.jpg',
        clientUuid: 'cuuid-fixed',
      }),
    )
    expect(result.photo.id).toBe('p-1')
    expect(result.wasReencoded).toBe(true)
    expect(result.diagnostics).toEqual({ originalSize: 100, finalSize: 80 })
  })

  it('throws pipeline rejection reason when magic-byte sniff fails', async () => {
    runPipelineMock.mockResolvedValue({ ok: false, reason: 'Dateiformat unbekannt.' })
    const repo = makeRepo()

    await expect(
      uploadJobPhoto(
        { jobId: 'job-42', providerId: 'prov-1', uploadedBy: 'user-w1', file: makeFile() },
        { repository: repo, generateClientUuid: () => 'x' },
      ),
    ).rejects.toThrow('Dateiformat unbekannt.')
    expect(storageUploadMock).not.toHaveBeenCalled()
    expect(repo.add).not.toHaveBeenCalled()
  })

  it('enqueues offline + throws friendly error when storage upload fails', async () => {
    const file = makeFile()
    runPipelineMock.mockResolvedValue({
      ok: true,
      file,
      diagnostics: { originalSize: 100, finalSize: 80, compressed: true, sniffedType: 'image/jpeg' },
    })
    storageUploadMock.mockResolvedValue({
      data: null,
      error: { message: 'network down' },
    })
    const repo = makeRepo()

    await expect(
      uploadJobPhoto(
        { jobId: 'job-42', providerId: 'prov-1', uploadedBy: 'user-w1', file },
        { repository: repo, generateClientUuid: () => 'cu1' },
      ),
    ).rejects.toThrow(/Verbindung wieder steht/)

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientUuid: 'cu1',
        jobId: 'job-42',
        storagePath: 'jobs/job-42/cu1.jpg',
        blob: file,
        contentType: 'image/jpeg',
      }),
    )
    expect(repo.add).not.toHaveBeenCalled()
  })

  it('does NOT clean up + does NOT enqueue when DB-INSERT returns 23505 (idempotent collision)', async () => {
    const file = makeFile()
    runPipelineMock.mockResolvedValue({
      ok: true,
      file,
      diagnostics: { originalSize: 100, finalSize: 80, compressed: true, sniffedType: 'image/jpeg' },
    })
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    storageRemoveMock.mockResolvedValue({ data: {}, error: null })
    const repo = makeRepo({
      add: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' })),
    })

    await expect(
      uploadJobPhoto(
        { jobId: 'job-42', providerId: 'prov-1', uploadedBy: 'user-w1', file },
        { repository: repo, generateClientUuid: () => 'cu-dupe' },
      ),
    ).rejects.toThrow(/bereits hochgeladen/)

    expect(storageRemoveMock).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('cleans up storage object + enqueues when DB-INSERT fails', async () => {
    const file = makeFile()
    runPipelineMock.mockResolvedValue({
      ok: true,
      file,
      diagnostics: { originalSize: 100, finalSize: 80, compressed: true, sniffedType: 'image/jpeg' },
    })
    storageUploadMock.mockResolvedValue({ data: {}, error: null })
    storageRemoveMock.mockResolvedValue({ data: {}, error: null })
    const repo = makeRepo({
      add: vi.fn().mockRejectedValue(Object.assign(new Error('rls'), { code: '42501' })),
    })

    await expect(
      uploadJobPhoto(
        { jobId: 'job-42', providerId: 'prov-1', uploadedBy: 'user-w1', file },
        { repository: repo, generateClientUuid: () => 'cu2' },
      ),
    ).rejects.toThrow(/Verbindung wieder steht/)

    expect(storageRemoveMock).toHaveBeenCalledWith(['jobs/job-42/cu2.jpg'])
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientUuid: 'cu2' }),
    )
  })
})
