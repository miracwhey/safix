import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock, selectMock, eqMock, orderMock, insertMock, insertSelectMock, insertSingleMock, updateMock, updateEqMock, updateSelectMock, updateSingleMock, deleteMock, deleteEqMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  orderMock: vi.fn(),
  insertMock: vi.fn(),
  insertSelectMock: vi.fn(),
  insertSingleMock: vi.fn(),
  updateMock: vi.fn(),
  updateEqMock: vi.fn(),
  updateSelectMock: vi.fn(),
  updateSingleMock: vi.fn(),
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

import { SupabaseJobReportRepository } from '../../src/lib/worker/repository/JobReportRepository'

const ROW = {
  id: 'r-1',
  job_id: 'job-42',
  provider_id: 'prov-1',
  authored_by: 'user-w1',
  body: 'Bauteil X getauscht; Funktion verifiziert.',
  metadata: { material_used: ['Schraube M6'] },
  created_at: '2026-05-08T12:00:00Z',
  updated_at: '2026-05-08T12:00:00Z',
}

describe('Block C.2 · SupabaseJobReportRepository', () => {
  beforeEach(() => {
    fromMock.mockReset()
    selectMock.mockReset()
    eqMock.mockReset()
    orderMock.mockReset()
    insertMock.mockReset()
    insertSelectMock.mockReset()
    insertSingleMock.mockReset()
    updateMock.mockReset()
    updateEqMock.mockReset()
    updateSelectMock.mockReset()
    updateSingleMock.mockReset()
    deleteMock.mockReset()
    deleteEqMock.mockReset()
  })

  describe('listForJob', () => {
    it('queries reports filtered + ordered', async () => {
      orderMock.mockResolvedValue({ data: [ROW], error: null })
      eqMock.mockReturnValue({ order: orderMock })
      selectMock.mockReturnValue({ eq: eqMock })
      fromMock.mockReturnValue({ select: selectMock })

      const repo = new SupabaseJobReportRepository()
      const result = await repo.listForJob('job-42')

      expect(fromMock).toHaveBeenCalledWith('job_reports')
      expect(orderMock).toHaveBeenCalledWith('created_at', { ascending: false })
      expect(result[0]).toMatchObject({
        id: 'r-1',
        body: 'Bauteil X getauscht; Funktion verifiziert.',
        metadata: { material_used: ['Schraube M6'] },
      })
    })

    it('falls back to {} for null metadata', async () => {
      orderMock.mockResolvedValue({ data: [{ ...ROW, metadata: null }], error: null })
      eqMock.mockReturnValue({ order: orderMock })
      selectMock.mockReturnValue({ eq: eqMock })
      fromMock.mockReturnValue({ select: selectMock })

      const repo = new SupabaseJobReportRepository()
      const result = await repo.listForJob('job-42')

      expect(result[0]!.metadata).toEqual({})
    })
  })

  describe('add', () => {
    it('inserts with default empty metadata', async () => {
      insertSingleMock.mockResolvedValue({ data: ROW, error: null })
      insertSelectMock.mockReturnValue({ single: insertSingleMock })
      insertMock.mockReturnValue({ select: insertSelectMock })
      fromMock.mockReturnValue({ insert: insertMock })

      const repo = new SupabaseJobReportRepository()
      await repo.add({
        jobId: 'job-42',
        providerId: 'prov-1',
        authoredBy: 'user-w1',
        body: 'Bericht',
      })

      expect(insertMock).toHaveBeenCalledWith({
        job_id: 'job-42',
        provider_id: 'prov-1',
        authored_by: 'user-w1',
        body: 'Bericht',
        metadata: {},
      })
    })

    it('forwards explicit metadata', async () => {
      insertSingleMock.mockResolvedValue({ data: ROW, error: null })
      insertSelectMock.mockReturnValue({ single: insertSingleMock })
      insertMock.mockReturnValue({ select: insertSelectMock })
      fromMock.mockReturnValue({ insert: insertMock })

      const repo = new SupabaseJobReportRepository()
      await repo.add({
        jobId: 'job-42',
        providerId: 'prov-1',
        authoredBy: 'user-w1',
        body: 'Bericht',
        metadata: { hours_spent: 3 },
      })

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { hours_spent: 3 } }),
      )
    })

    it('throws on body-length-violation (server-side CHECK)', async () => {
      insertSingleMock.mockResolvedValue({
        data: null,
        error: { code: '23514', message: 'job_reports_body_length' },
      })
      insertSelectMock.mockReturnValue({ single: insertSingleMock })
      insertMock.mockReturnValue({ select: insertSelectMock })
      fromMock.mockReturnValue({ insert: insertMock })

      const repo = new SupabaseJobReportRepository()
      await expect(
        repo.add({
          jobId: 'job-42',
          providerId: 'prov-1',
          authoredBy: 'user-w1',
          body: '',
        }),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('update', () => {
    it('patches only provided fields', async () => {
      updateSingleMock.mockResolvedValue({ data: { ...ROW, body: 'Korrigiert.' }, error: null })
      updateSelectMock.mockReturnValue({ single: updateSingleMock })
      updateEqMock.mockReturnValue({ select: updateSelectMock })
      updateMock.mockReturnValue({ eq: updateEqMock })
      fromMock.mockReturnValue({ update: updateMock })

      const repo = new SupabaseJobReportRepository()
      const result = await repo.update({ reportId: 'r-1', body: 'Korrigiert.' })

      expect(updateMock).toHaveBeenCalledWith({ body: 'Korrigiert.' })
      expect(updateEqMock).toHaveBeenCalledWith('id', 'r-1')
      expect(result.body).toBe('Korrigiert.')
    })
  })

  describe('delete', () => {
    it('deletes by id', async () => {
      deleteEqMock.mockResolvedValue({ data: null, error: null })
      deleteMock.mockReturnValue({ eq: deleteEqMock })
      fromMock.mockReturnValue({ delete: deleteMock })

      const repo = new SupabaseJobReportRepository()
      await repo.delete('r-1')

      expect(deleteEqMock).toHaveBeenCalledWith('id', 'r-1')
    })
  })
})
