import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must hoist to top via vi.hoisted before module imports.
const { fromMock, selectMock, eqMock, orderMock, insertMock, insertSelectMock, insertSingleMock, deleteMock, deleteEqMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  orderMock: vi.fn(),
  insertMock: vi.fn(),
  insertSelectMock: vi.fn(),
  insertSingleMock: vi.fn(),
  deleteMock: vi.fn(),
  deleteEqMock: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: fromMock },
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import { SupabaseJobPhotoRepository } from '../../src/lib/worker/repository/JobPhotoRepository'

const ROW = {
  id: 'p-1',
  job_id: 'job-42',
  provider_id: 'prov-1',
  uploaded_by: 'user-w1',
  storage_path: 'jobs/job-42/cuuid-1.jpg',
  client_uuid: 'cuuid-1',
  width_px: 2560,
  height_px: 1707,
  size_bytes: 1_234_567,
  created_at: '2026-05-08T12:00:00Z',
}

describe('Block C.2 · SupabaseJobPhotoRepository', () => {
  beforeEach(() => {
    fromMock.mockReset()
    selectMock.mockReset()
    eqMock.mockReset()
    orderMock.mockReset()
    insertMock.mockReset()
    insertSelectMock.mockReset()
    insertSingleMock.mockReset()
    deleteMock.mockReset()
    deleteEqMock.mockReset()
  })

  describe('listForJob', () => {
    it('queries job_photos filtered by job_id ordered by created_at desc', async () => {
      orderMock.mockResolvedValue({ data: [ROW], error: null })
      eqMock.mockReturnValue({ order: orderMock })
      selectMock.mockReturnValue({ eq: eqMock })
      fromMock.mockReturnValue({ select: selectMock })

      const repo = new SupabaseJobPhotoRepository()
      const result = await repo.listForJob('job-42')

      expect(fromMock).toHaveBeenCalledWith('job_photos')
      expect(selectMock).toHaveBeenCalledWith('*')
      expect(eqMock).toHaveBeenCalledWith('job_id', 'job-42')
      expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'p-1',
        jobId: 'job-42',
        providerId: 'prov-1',
        uploadedBy: 'user-w1',
        storagePath: 'jobs/job-42/cuuid-1.jpg',
        clientUuid: 'cuuid-1',
        widthPx: 2560,
        heightPx: 1707,
        sizeBytes: 1_234_567,
      })
      expect(typeof result[0]!.createdAt).toBe('number')
    })

    it('omits null width/height/size from domain object', async () => {
      orderMock.mockResolvedValue({
        data: [{ ...ROW, width_px: null, height_px: null, size_bytes: null }],
        error: null,
      })
      eqMock.mockReturnValue({ order: orderMock })
      selectMock.mockReturnValue({ eq: eqMock })
      fromMock.mockReturnValue({ select: selectMock })

      const repo = new SupabaseJobPhotoRepository()
      const result = await repo.listForJob('job-42')

      expect(result[0]).not.toHaveProperty('widthPx')
      expect(result[0]).not.toHaveProperty('heightPx')
      expect(result[0]).not.toHaveProperty('sizeBytes')
    })

    it('throws on supabase error', async () => {
      orderMock.mockResolvedValue({ data: null, error: { message: 'rls denied' } })
      eqMock.mockReturnValue({ order: orderMock })
      selectMock.mockReturnValue({ eq: eqMock })
      fromMock.mockReturnValue({ select: selectMock })

      const repo = new SupabaseJobPhotoRepository()
      await expect(repo.listForJob('job-42')).rejects.toMatchObject({ message: 'rls denied' })
    })
  })

  describe('add', () => {
    it('inserts row with required fields and returns mapped JobPhoto', async () => {
      insertSingleMock.mockResolvedValue({ data: ROW, error: null })
      insertSelectMock.mockReturnValue({ single: insertSingleMock })
      insertMock.mockReturnValue({ select: insertSelectMock })
      fromMock.mockReturnValue({ insert: insertMock })

      const repo = new SupabaseJobPhotoRepository()
      const result = await repo.add({
        jobId: 'job-42',
        providerId: 'prov-1',
        uploadedBy: 'user-w1',
        storagePath: 'jobs/job-42/cuuid-1.jpg',
        clientUuid: 'cuuid-1',
        sizeBytes: 1_234_567,
      })

      expect(insertMock).toHaveBeenCalledWith({
        job_id: 'job-42',
        provider_id: 'prov-1',
        uploaded_by: 'user-w1',
        storage_path: 'jobs/job-42/cuuid-1.jpg',
        client_uuid: 'cuuid-1',
        width_px: null,
        height_px: null,
        size_bytes: 1_234_567,
      })
      expect(result.id).toBe('p-1')
    })

    it('throws on supabase error (e.g. unique violation)', async () => {
      insertSingleMock.mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'duplicate' },
      })
      insertSelectMock.mockReturnValue({ single: insertSingleMock })
      insertMock.mockReturnValue({ select: insertSelectMock })
      fromMock.mockReturnValue({ insert: insertMock })

      const repo = new SupabaseJobPhotoRepository()
      await expect(
        repo.add({
          jobId: 'job-42',
          providerId: 'prov-1',
          uploadedBy: 'user-w1',
          storagePath: 'jobs/job-42/cuuid-1.jpg',
          clientUuid: 'cuuid-1',
        }),
      ).rejects.toMatchObject({ code: '23505' })
    })
  })

  describe('delete', () => {
    it('deletes by id', async () => {
      deleteEqMock.mockResolvedValue({ data: null, error: null })
      deleteMock.mockReturnValue({ eq: deleteEqMock })
      fromMock.mockReturnValue({ delete: deleteMock })

      const repo = new SupabaseJobPhotoRepository()
      await repo.delete('p-1')

      expect(deleteEqMock).toHaveBeenCalledWith('id', 'p-1')
    })

    it('throws on error', async () => {
      deleteEqMock.mockResolvedValue({ data: null, error: { message: '24h elapsed' } })
      deleteMock.mockReturnValue({ eq: deleteEqMock })
      fromMock.mockReturnValue({ delete: deleteMock })

      const repo = new SupabaseJobPhotoRepository()
      await expect(repo.delete('p-1')).rejects.toMatchObject({ message: '24h elapsed' })
    })
  })
})
