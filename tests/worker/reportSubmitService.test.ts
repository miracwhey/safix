import { describe, it, expect, vi } from 'vitest'

import { submitJobReport } from '../../src/lib/worker/reportSubmitService'
import type { JobReportRepository } from '../../src/lib/worker/repository/JobReportRepository'

function makeRepo(overrides: Partial<JobReportRepository> = {}): JobReportRepository {
  return {
    listForJob: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  }
}

describe('Block C.2 · submitJobReport', () => {
  it('rejects empty body before hitting repo', async () => {
    const repo = makeRepo()
    await expect(
      submitJobReport(
        { jobId: 'j', providerId: 'p', authoredBy: 'u', body: '   ' },
        { repository: repo },
      ),
    ).rejects.toThrow('Bericht eintragen')
    expect(repo.add).not.toHaveBeenCalled()
  })

  it('rejects body > 10000 chars', async () => {
    const repo = makeRepo()
    await expect(
      submitJobReport(
        { jobId: 'j', providerId: 'p', authoredBy: 'u', body: 'a'.repeat(10_001) },
        { repository: repo },
      ),
    ).rejects.toThrow('zu lang')
    expect(repo.add).not.toHaveBeenCalled()
  })

  it('forwards valid input to repo.add and returns the result', async () => {
    const reportFromRepo = {
      id: 'r-1',
      jobId: 'j',
      providerId: 'p',
      authoredBy: 'u',
      body: 'Bericht',
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const repo = makeRepo({
      add: vi.fn().mockResolvedValue(reportFromRepo),
    })

    const result = await submitJobReport(
      { jobId: 'j', providerId: 'p', authoredBy: 'u', body: 'Bericht' },
      { repository: repo },
    )

    expect(repo.add).toHaveBeenCalledWith({
      jobId: 'j',
      providerId: 'p',
      authoredBy: 'u',
      body: 'Bericht',
    })
    expect(result).toBe(reportFromRepo)
  })

  it('passes metadata when provided', async () => {
    const repo = makeRepo({
      add: vi.fn().mockResolvedValue({
        id: 'r-2',
        jobId: 'j',
        providerId: 'p',
        authoredBy: 'u',
        body: 'B',
        metadata: { hours: 3 },
        createdAt: 1,
        updatedAt: 1,
      }),
    })

    await submitJobReport(
      {
        jobId: 'j',
        providerId: 'p',
        authoredBy: 'u',
        body: 'B',
        metadata: { hours: 3 },
      },
      { repository: repo },
    )

    expect(repo.add).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { hours: 3 } }),
    )
  })
})
