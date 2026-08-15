import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  installMockSession,
  mockOwnerSession,
  mockWorkerSession,
  resetMockSession,
} from '../helpers/mockSession'
import {
  setTeamMemberRepository,
  setTimeEntryRepository,
  TimeEntryActiveConflictError,
} from '../../src/lib/team/repository'
import { InMemoryTeamMemberRepository } from '../../src/lib/team/repository/InMemoryTeamMemberRepository'
import { InMemoryTimeEntryRepository } from '../../src/lib/team/repository/InMemoryTimeEntryRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import {
  rejectTimeEntryWorkflow,
  startActiveDayTimerForMemberWorkflow,
  startActiveJobTimerForMemberWorkflow,
  stopActiveDayTimerForMemberWorkflow,
  stopActiveJobTimerForMemberWorkflow,
  TimeEntryJobAssignmentError,
  TimeEntryNoActiveTimerError,
} from '../../src/lib/workflow/timeEntryWorkflow'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MEMBER_ID = 'm-anna'
const WORKER_USER_ID = 'u-anna'
const PROVIDER_ID = 'p-acme'
const OWNER_USER_ID = 'u-owner'
const JOB_ASSIGNED_ID = 'job-assigned'
const JOB_OTHER_ID = 'job-other'

let teRepo: InMemoryTimeEntryRepository

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: MEMBER_ID,
    name: 'Anna',
    role: 'worker',
    isActive: true,
    userId: WORKER_USER_ID,
    providerId: PROVIDER_ID,
    phone: null,
    email: null,
    avatarUrl: null,
    weeklyTargetHours: null,
    dailyTargetHours: null,
    ...overrides,
  } as TeamMember
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    title: 'Bad-Renovierung',
    customer: 'Müller',
    location: 'Berlin',
    dateLabel: 'heute',
    status: 'in_progress',
    amount: '0',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: OWNER_USER_ID,
    customerUserId: 'cust-1',
    providerId: PROVIDER_ID,
    ...overrides,
  } as Job
}

function seedTeam(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

function seedJobs(jobs: Job[]): void {
  setJobRepository(new InMemoryJobRepository(jobs))
}

beforeEach(() => {
  resetMockSession()
  teRepo = new InMemoryTimeEntryRepository()
  setTimeEntryRepository(teRepo)
  seedTeam([makeMember()])
  seedJobs([
    makeJob({ id: JOB_ASSIGNED_ID, assignedMemberIds: [MEMBER_ID] }),
    makeJob({ id: JOB_OTHER_ID, assignedMemberIds: ['m-someone-else'] }),
  ])
})

afterEach(() => {
  resetMockSession()
})

// ─────────────────────────────────────────────────────────────────────────────
// startActiveDayTimerForMemberWorkflow
// ─────────────────────────────────────────────────────────────────────────────

describe('startActiveDayTimerForMemberWorkflow', () => {
  it('rejects unauthenticated callers', async () => {
    await expect(
      startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID),
    ).rejects.toThrow(RbacError)
  })

  it('rejects worker for a different member', async () => {
    installMockSession(mockWorkerSession('u-someone-else'))
    await expect(
      startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID),
    ).rejects.toThrow(RbacError)
  })

  it('starts a day timer for the matching worker', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const entry = await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, {
      now: new Date('2026-05-04T07:00:00Z'),
    })
    expect(entry.kind).toBe('day')
    expect(entry.status).toBe('active')
    expect(entry.startedAt).toBe('2026-05-04T07:00:00.000Z')
  })

  it('throws TimeEntryActiveConflictError on second start', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID)
    await expect(
      startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID),
    ).rejects.toBeInstanceOf(TimeEntryActiveConflictError)
  })

  it('allows owner to start timer for any member', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const entry = await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID)
    expect(entry.kind).toBe('day')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// startActiveJobTimerForMemberWorkflow
// ─────────────────────────────────────────────────────────────────────────────

describe('startActiveJobTimerForMemberWorkflow', () => {
  it('rejects when member is not assigned to the job', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, JOB_OTHER_ID),
    ).rejects.toBeInstanceOf(TimeEntryJobAssignmentError)
  })

  it('rejects when job does not exist', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, 'no-such-job'),
    ).rejects.toThrow(/not found/i)
  })

  it('starts when member is assigned', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const entry = await startActiveJobTimerForMemberWorkflow(
      MEMBER_ID,
      PROVIDER_ID,
      JOB_ASSIGNED_ID,
    )
    expect(entry.kind).toBe('job')
    expect(entry.jobId).toBe(JOB_ASSIGNED_ID)
    expect(entry.status).toBe('active')
  })

  it('detects already-running job-timer conflict', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, JOB_ASSIGNED_ID)
    await expect(
      startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, JOB_ASSIGNED_ID),
    ).rejects.toBeInstanceOf(TimeEntryActiveConflictError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// stopActiveDayTimerForMemberWorkflow (atomic auto-stop)
// ─────────────────────────────────────────────────────────────────────────────

describe('stopActiveDayTimerForMemberWorkflow', () => {
  it('throws when no day timer is active', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      stopActiveDayTimerForMemberWorkflow(MEMBER_ID),
    ).rejects.toBeInstanceOf(TimeEntryNoActiveTimerError)
  })

  it('closes the day timer with computed duration', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, {
      now: new Date('2026-05-04T07:00:00Z'),
    })
    const result = await stopActiveDayTimerForMemberWorkflow(MEMBER_ID, {
      now: new Date('2026-05-04T15:00:00Z'),
    })
    expect(result.day.status).toBe('closed')
    expect(result.day.durationMinutes).toBe(8 * 60)
    expect(result.day.endedAt).toBe('2026-05-04T15:00:00.000Z')
    expect(result.job).toBeUndefined()
  })

  it('also auto-closes a running job timer (atomic)', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, {
      now: new Date('2026-05-04T07:00:00Z'),
    })
    await startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, JOB_ASSIGNED_ID, {
      now: new Date('2026-05-04T09:00:00Z'),
    })
    const result = await stopActiveDayTimerForMemberWorkflow(MEMBER_ID, {
      now: new Date('2026-05-04T15:00:00Z'),
    })
    expect(result.day.status).toBe('closed')
    expect(result.day.durationMinutes).toBe(8 * 60)
    expect(result.job?.status).toBe('closed')
    expect(result.job?.durationMinutes).toBe(6 * 60)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// stopActiveJobTimerForMemberWorkflow
// ─────────────────────────────────────────────────────────────────────────────

describe('stopActiveJobTimerForMemberWorkflow', () => {
  it('throws when no job timer is active', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(stopActiveJobTimerForMemberWorkflow(MEMBER_ID)).rejects.toBeInstanceOf(
      TimeEntryNoActiveTimerError,
    )
  })

  it('closes the job timer without touching day', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await startActiveDayTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, {
      now: new Date('2026-05-04T07:00:00Z'),
    })
    await startActiveJobTimerForMemberWorkflow(MEMBER_ID, PROVIDER_ID, JOB_ASSIGNED_ID, {
      now: new Date('2026-05-04T09:00:00Z'),
    })
    const stopped = await stopActiveJobTimerForMemberWorkflow(MEMBER_ID, {
      now: new Date('2026-05-04T11:30:00Z'),
    })
    expect(stopped.status).toBe('closed')
    expect(stopped.durationMinutes).toBe(150)
    // Day-timer must remain active
    const dayActive = teRepo.getAll().find((e) => e.kind === 'day')
    expect(dayActive?.status).toBe('active')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// rejectTimeEntryWorkflow
// ─────────────────────────────────────────────────────────────────────────────

describe('rejectTimeEntryWorkflow', () => {
  it('rejects worker callers', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    teRepo.seed([
      {
        id: 'te-1',
        providerId: PROVIDER_ID,
        memberId: MEMBER_ID,
        kind: 'day',
        jobId: null,
        startedAt: '2026-05-04T07:00:00.000Z',
        endedAt: '2026-05-04T15:00:00.000Z',
        durationMinutes: 480,
        note: null,
        status: 'closed',
        rejectedReason: null,
        rejectedBy: null,
        createdAt: '2026-05-04T07:00:00.000Z',
        updatedAt: '2026-05-04T15:00:00.000Z',
      },
    ])
    await expect(
      rejectTimeEntryWorkflow('te-1', 'because'),
    ).rejects.toThrow(RbacError)
  })

  it('requires a reason', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    teRepo.seed([
      {
        id: 'te-1',
        providerId: PROVIDER_ID,
        memberId: MEMBER_ID,
        kind: 'day',
        jobId: null,
        startedAt: '2026-05-04T07:00:00.000Z',
        endedAt: '2026-05-04T15:00:00.000Z',
        durationMinutes: 480,
        note: null,
        status: 'closed',
        rejectedReason: null,
        rejectedBy: null,
        createdAt: '2026-05-04T07:00:00.000Z',
        updatedAt: '2026-05-04T15:00:00.000Z',
      },
    ])
    await expect(rejectTimeEntryWorkflow('te-1', '   ')).rejects.toThrow(/reason/i)
  })

  it('blocks rejecting an active entry', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    teRepo.seed([
      {
        id: 'te-1',
        providerId: PROVIDER_ID,
        memberId: MEMBER_ID,
        kind: 'day',
        jobId: null,
        startedAt: '2026-05-04T07:00:00.000Z',
        endedAt: null,
        durationMinutes: null,
        note: null,
        status: 'active',
        rejectedReason: null,
        rejectedBy: null,
        createdAt: '2026-05-04T07:00:00.000Z',
        updatedAt: '2026-05-04T07:00:00.000Z',
      },
    ])
    await expect(rejectTimeEntryWorkflow('te-1', 'too long')).rejects.toThrow(/active/i)
  })

  it('owner rejects with reason — sets rejectedBy + rejectedReason', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    teRepo.seed([
      {
        id: 'te-1',
        providerId: PROVIDER_ID,
        memberId: MEMBER_ID,
        kind: 'day',
        jobId: null,
        startedAt: '2026-05-04T07:00:00.000Z',
        endedAt: '2026-05-04T15:00:00.000Z',
        durationMinutes: 480,
        note: null,
        status: 'closed',
        rejectedReason: null,
        rejectedBy: null,
        createdAt: '2026-05-04T07:00:00.000Z',
        updatedAt: '2026-05-04T15:00:00.000Z',
      },
    ])
    const result = await rejectTimeEntryWorkflow('te-1', '  Pause vergessen  ')
    expect(result.status).toBe('rejected')
    expect(result.rejectedReason).toBe('Pause vergessen')
    expect(result.rejectedBy).toBe(OWNER_USER_ID)
  })
})
