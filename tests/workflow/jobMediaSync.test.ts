import { describe, it, expect, vi, beforeEach } from 'vitest'
import { syncJobPhotoCount } from '../../src/lib/workflow/jobMediaSync'
import { supabase } from '../../src/lib/supabase'

vi.mock('../../src/lib/supabase', () => ({
  supabase: { from: vi.fn() },
}))

const updateSpy = vi.fn(async () => undefined)
const getJobByIdSpy = vi.fn()

vi.mock('../../src/lib/jobs/jobsStore', () => ({
  getJobById: (...args: unknown[]) => getJobByIdSpy(...args),
}))

vi.mock('../../src/lib/jobs/repository', () => ({
  getJobRepository: () => ({
    update: (...args: unknown[]) => updateSpy(...args),
  }),
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(supabase.from).mockReset()
  updateSpy.mockReset()
  updateSpy.mockResolvedValue(undefined)
  getJobByIdSpy.mockReset()
})

function mockMediaCount(count: number | null, error?: { message: string }) {
  vi.mocked(supabase.from).mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () =>
          Promise.resolve({
            data: null,
            count,
            error: error ?? null,
          }),
      }),
    }),
  } as unknown as ReturnType<typeof supabase.from>)
}

describe('syncJobPhotoCount', () => {
  it('returns job_missing when jobId is blank', async () => {
    const result = await syncJobPhotoCount('')
    expect(result).toEqual({ status: 'job_missing', jobId: '' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns count_failed when supabase errors', async () => {
    mockMediaCount(null, { message: 'rls' })
    const result = await syncJobPhotoCount('job-1')
    expect(result.status).toBe('count_failed')
  })

  it('returns job_missing when the local cache has no job', async () => {
    mockMediaCount(2)
    getJobByIdSpy.mockReturnValue(undefined)
    const result = await syncJobPhotoCount('job-1')
    expect(result).toEqual({ status: 'job_missing', jobId: 'job-1' })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('returns unchanged and skips the write when count matches', async () => {
    mockMediaCount(3)
    getJobByIdSpy.mockReturnValue({ id: 'job-1', photoCount: 3 })
    const result = await syncJobPhotoCount('job-1')
    expect(result).toEqual({ status: 'unchanged', jobId: 'job-1', count: 3 })
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('writes the new count and reports updated when drift is detected', async () => {
    mockMediaCount(5)
    getJobByIdSpy.mockReturnValue({ id: 'job-1', photoCount: 2 })
    const result = await syncJobPhotoCount('job-1')
    expect(result).toEqual({
      status: 'updated',
      jobId: 'job-1',
      previous: 2,
      next: 5,
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const updater = updateSpy.mock.calls[0][1] as (j: { photoCount: number }) => unknown
    expect(updater({ photoCount: 2 })).toEqual({ photoCount: 5 })
  })

  it('handles a null count from supabase as 0', async () => {
    mockMediaCount(null)
    getJobByIdSpy.mockReturnValue({ id: 'job-1', photoCount: 4 })
    const result = await syncJobPhotoCount('job-1')
    expect(result).toEqual({
      status: 'updated',
      jobId: 'job-1',
      previous: 4,
      next: 0,
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
  })

  it('returns count_failed when the repo update throws', async () => {
    mockMediaCount(7)
    getJobByIdSpy.mockReturnValue({ id: 'job-1', photoCount: 1 })
    updateSpy.mockRejectedValueOnce(new Error('boom'))
    const result = await syncJobPhotoCount('job-1')
    expect(result.status).toBe('count_failed')
  })
})
