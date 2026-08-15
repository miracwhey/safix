import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  uploadPhotoMock,
  submitReportMock,
  assertJobWorkerOrOwnerMock,
  reportRepoUpdateMock,
} = vi.hoisted(() => ({
  uploadPhotoMock: vi.fn(),
  submitReportMock: vi.fn(),
  assertJobWorkerOrOwnerMock: vi.fn(),
  reportRepoUpdateMock: vi.fn(),
}))

vi.mock('../../src/lib/worker/photoCaptureService', () => ({
  uploadJobPhoto: uploadPhotoMock,
}))
vi.mock('../../src/lib/worker/reportSubmitService', () => ({
  submitJobReport: submitReportMock,
}))
vi.mock('../../src/lib/worker/repository/JobReportRepository', () => ({
  SupabaseJobReportRepository: class {
    update = reportRepoUpdateMock
  },
}))
vi.mock('../../src/lib/auth/rbacGuards', () => ({
  assertJobWorkerOrOwner: assertJobWorkerOrOwnerMock,
}))
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import {
  captureJobPhotoWorkflow,
  addJobReportWorkflow,
  updateJobReportWorkflow,
} from '../../src/lib/worker/workerDokuWorkflow'
import type { JobReport } from '../../src/lib/worker/dokuTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { SessionState } from '../../src/lib/session'

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    projectId: 'p-1',
    title: 'Job',
    customer: 'Kunde',
    location: 'HH',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1000',
    photoCount: 0,
    notes: [],
    providerId: 'prov-1',
    ...over,
  } as Job
}

function makeSession(over: Partial<SessionState> = {}): SessionState {
  return {
    user: { id: 'u-1' },
    role: 'craftsman',
    craftsmanRole: 'worker',
    ...over,
  } as SessionState
}

beforeEach(() => {
  uploadPhotoMock.mockReset()
  submitReportMock.mockReset()
  reportRepoUpdateMock.mockReset()
  assertJobWorkerOrOwnerMock.mockReset()
})

const NOW = 1_746_374_400_000

function makeReport(over: Partial<JobReport> = {}): JobReport {
  return {
    id: 'r-1',
    jobId: 'j-1',
    providerId: 'prov-1',
    authoredBy: 'u-1',
    body: 'Original-Bericht',
    metadata: {},
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
  }
}

describe('Block C.3 · captureJobPhotoWorkflow', () => {
  it('runs assertJobWorkerOrOwner before service call', async () => {
    uploadPhotoMock.mockResolvedValue({
      photo: {
        id: 'p1',
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        storagePath: 'jobs/j-1/cu.jpg',
        clientUuid: 'cu',
        createdAt: 1,
      },
      wasReencoded: true,
      diagnostics: { originalSize: 100, finalSize: 50 },
    })
    const job = makeJob()
    const session = makeSession()
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })

    await captureJobPhotoWorkflow({ job, file }, session)

    expect(assertJobWorkerOrOwnerMock).toHaveBeenCalledWith(job, session)
    expect(uploadPhotoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'j-1',
        providerId: 'prov-1',
        uploadedBy: 'u-1',
        file,
      }),
      {},
    )
  })

  it('throws when session has no user (assert passed but session inconsistent)', async () => {
    assertJobWorkerOrOwnerMock.mockImplementation(() => {})
    const job = makeJob()
    const session = makeSession({ user: undefined })
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })

    await expect(
      captureJobPhotoWorkflow({ job, file }, session),
    ).rejects.toThrow('Sitzung')
    expect(uploadPhotoMock).not.toHaveBeenCalled()
  })

  it('throws when job has no providerId', async () => {
    const job = makeJob({ providerId: undefined })
    const session = makeSession()
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })

    await expect(
      captureJobPhotoWorkflow({ job, file }, session),
    ).rejects.toThrow('Betrieb')
    expect(uploadPhotoMock).not.toHaveBeenCalled()
  })

  it('propagates rbac error from assert', async () => {
    assertJobWorkerOrOwnerMock.mockImplementation(() => {
      throw new Error('rbac_worker_or_owner')
    })
    const job = makeJob()
    const session = makeSession()
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })

    await expect(
      captureJobPhotoWorkflow({ job, file }, session),
    ).rejects.toThrow('rbac_worker_or_owner')
    expect(uploadPhotoMock).not.toHaveBeenCalled()
  })
})

describe('Block C.3 · addJobReportWorkflow', () => {
  it('runs assertJobWorkerOrOwner + submits with authoredBy from session', async () => {
    submitReportMock.mockResolvedValue({
      id: 'r1',
      jobId: 'j-1',
      providerId: 'prov-1',
      authoredBy: 'u-1',
      body: 'Bericht',
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const job = makeJob()
    const session = makeSession()

    await addJobReportWorkflow({ job, body: 'Bericht' }, session)

    expect(assertJobWorkerOrOwnerMock).toHaveBeenCalledWith(job, session)
    expect(submitReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'j-1',
        providerId: 'prov-1',
        authoredBy: 'u-1',
        body: 'Bericht',
      }),
      {},
    )
  })

  it('forwards metadata when provided', async () => {
    submitReportMock.mockResolvedValue({
      id: 'r1',
      jobId: 'j-1',
      providerId: 'prov-1',
      authoredBy: 'u-1',
      body: 'B',
      metadata: { hours: 3 },
      createdAt: 1,
      updatedAt: 1,
    })

    await addJobReportWorkflow(
      { job: makeJob(), body: 'B', metadata: { hours: 3 } },
      makeSession(),
    )

    expect(submitReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { hours: 3 } }),
      {},
    )
  })
})

describe('Block FU-A · updateJobReportWorkflow', () => {
  it('runs assertJobWorkerOrOwner + updates within 24h window', async () => {
    reportRepoUpdateMock.mockResolvedValue({
      ...makeReport(),
      body: 'Korrigiert.',
      updatedAt: NOW,
    })
    const job = makeJob()
    const session = makeSession()
    const report = makeReport()

    const result = await updateJobReportWorkflow(
      { job, report, body: 'Korrigiert.' },
      session,
      { now: NOW },
    )

    expect(assertJobWorkerOrOwnerMock).toHaveBeenCalledWith(job, session)
    expect(reportRepoUpdateMock).toHaveBeenCalledWith({
      reportId: 'r-1',
      body: 'Korrigiert.',
    })
    expect(result.body).toBe('Korrigiert.')
  })

  it('throws when caller is not the original author', async () => {
    const job = makeJob()
    const session = makeSession({ user: { id: 'someone-else' } as SessionState['user'] })
    const report = makeReport({ authoredBy: 'u-1' })

    await expect(
      updateJobReportWorkflow({ job, report, body: 'X' }, session, { now: NOW }),
    ).rejects.toThrow('Verfasser')
    expect(reportRepoUpdateMock).not.toHaveBeenCalled()
  })

  it('throws when report is older than 24h', async () => {
    const job = makeJob()
    const session = makeSession()
    const report = makeReport({ createdAt: NOW - 25 * 60 * 60 * 1000 })

    await expect(
      updateJobReportWorkflow({ job, report, body: 'X' }, session, { now: NOW }),
    ).rejects.toThrow('24 Stunden')
    expect(reportRepoUpdateMock).not.toHaveBeenCalled()
  })

  it('throws on empty body before hitting repo', async () => {
    const job = makeJob()
    const session = makeSession()
    const report = makeReport()

    await expect(
      updateJobReportWorkflow(
        { job, report, body: '   ' },
        session,
        { now: NOW },
      ),
    ).rejects.toThrow('Bericht eintragen')
    expect(reportRepoUpdateMock).not.toHaveBeenCalled()
  })

  it('forwards metadata when provided', async () => {
    reportRepoUpdateMock.mockResolvedValue(makeReport({ metadata: { hours: 4 } }))
    await updateJobReportWorkflow(
      {
        job: makeJob(),
        report: makeReport(),
        body: 'B',
        metadata: { hours: 4 },
      },
      makeSession(),
      { now: NOW },
    )
    expect(reportRepoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { hours: 4 } }),
    )
  })

  it('maps server-side RLS deny (42501) to friendly 24h-window message', async () => {
    // Repräsentiert Clock-Skew: client meint <24h, Server-RLS meint >24h.
    reportRepoUpdateMock.mockRejectedValue(
      Object.assign(new Error('row-level security'), { code: '42501' }),
    )
    await expect(
      updateJobReportWorkflow(
        { job: makeJob(), report: makeReport(), body: 'B' },
        makeSession(),
        { now: NOW },
      ),
    ).rejects.toThrow('24 Stunden')
  })
})
