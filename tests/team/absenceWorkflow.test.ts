import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installMockSession,
  mockOwnerSession,
  mockWorkerSession,
  resetMockSession,
} from '../helpers/mockSession'
import {
  setAbsenceRepository,
  setTeamMemberRepository,
  setTimeEntryRepository,
} from '../../src/lib/team/repository'
import { InMemoryAbsenceRepository } from '../../src/lib/team/repository/InMemoryAbsenceRepository'
import { InMemoryTeamMemberRepository } from '../../src/lib/team/repository/InMemoryTeamMemberRepository'
import { InMemoryTimeEntryRepository } from '../../src/lib/team/repository/InMemoryTimeEntryRepository'
import {
  reportAbsenceWorkflow,
  cancelAbsenceWorkflow,
  requestSickNoteWorkflow,
  AbsenceDateRangeError,
} from '../../src/lib/workflow/absenceWorkflow'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import type { TeamMember } from '../../src/lib/jobs/types'

const MEMBER_ID = 'm-anna'
const WORKER_USER_ID = 'u-anna'
const PROVIDER_ID = 'p-acme'
const OWNER_USER_ID = 'u-owner'

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

let absRepo: InMemoryAbsenceRepository
let teRepo: InMemoryTimeEntryRepository

function seedTeam(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

beforeEach(() => {
  absRepo = new InMemoryAbsenceRepository()
  teRepo = new InMemoryTimeEntryRepository()
  setAbsenceRepository(absRepo)
  setTimeEntryRepository(teRepo)
  seedTeam([makeMember()])
})

afterEach(() => {
  resetMockSession()
  vi.restoreAllMocks()
})

describe('reportAbsenceWorkflow', () => {
  it('inserts an active sick row when called by the worker themselves', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const result = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })
    expect(result.absence.status).toBe('active')
    expect(result.absence.type).toBe('sick')
    expect(absRepo.getAll()).toHaveLength(1)
  })

  it('rejects when worker session does not match the member', async () => {
    installMockSession(mockWorkerSession('u-someone-else'))
    await expect(
      reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
        type: 'sick',
        startDate: '2026-05-08',
        endDate: '2026-05-08',
        skipNotify: true,
      }),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('owner-on-behalf path is allowed', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })
    expect(result.absence.providerId).toBe(PROVIDER_ID)
  })

  it('rejects when endDate < startDate', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
        type: 'sick',
        startDate: '2026-05-10',
        endDate: '2026-05-09',
        skipNotify: true,
      }),
    ).rejects.toBeInstanceOf(AbsenceDateRangeError)
  })

  it('atomically auto-stops an active day-timer before inserting', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    // Seed an active day-timer from 2 hours ago.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    await teRepo.create({
      memberId: MEMBER_ID,
      providerId: PROVIDER_ID,
      kind: 'day',
      jobId: null,
      startedAt: twoHoursAgo,
    })

    const now = new Date()
    const result = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      now,
      skipNotify: true,
    })

    expect(result.autoStoppedDayEntryId).toBeDefined()
    const closed = teRepo.getAll().find((e) => e.kind === 'day')
    expect(closed?.status).toBe('closed')
    expect(closed?.durationMinutes).toBeGreaterThan(0)
    expect(result.absence.status).toBe('active')
  })

  it('continues to insert absence even if auto-stop fails (best-effort policy)', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    // Force the time-entry update to fail.
    vi.spyOn(teRepo, 'update').mockRejectedValueOnce(new Error('forced'))
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    await teRepo.create({
      memberId: MEMBER_ID,
      providerId: PROVIDER_ID,
      kind: 'day',
      jobId: null,
      startedAt: twoHoursAgo,
    })

    const result = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })
    // Absence still landed.
    expect(result.absence.status).toBe('active')
    // Day-timer was NOT recorded as auto-stopped (since update threw).
    expect(result.autoStoppedDayEntryId).toBeUndefined()
  })
})

describe('cancelAbsenceWorkflow', () => {
  it('flips active → cancelled with a timestamp', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const reported = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })
    const cancelled = await cancelAbsenceWorkflow(reported.absence.id, { skipNotify: true })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledAt).not.toBeNull()
  })

  it('rejects when caller is neither worker for the member nor owner', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const reported = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })

    installMockSession(mockWorkerSession('u-bad'))
    await expect(
      cancelAbsenceWorkflow(reported.absence.id, { skipNotify: true }),
    ).rejects.toBeInstanceOf(RbacError)
  })
})

describe('requestSickNoteWorkflow', () => {
  it('owner can flip sick_note_requested true', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const reported = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })

    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const updated = await requestSickNoteWorkflow(reported.absence.id)
    expect(updated.sickNoteRequested).toBe(true)
    expect(updated.sickNoteRequestedAt).not.toBeNull()
  })

  it('rejects when caller is not owner', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const reported = await reportAbsenceWorkflow(MEMBER_ID, PROVIDER_ID, {
      type: 'sick',
      startDate: '2026-05-08',
      endDate: '2026-05-08',
      skipNotify: true,
    })
    await expect(requestSickNoteWorkflow(reported.absence.id)).rejects.toBeInstanceOf(RbacError)
  })
})
