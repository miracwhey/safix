import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  CorrectionWorkflowError,
  approveCorrectionWorkflow,
  rejectCorrectionWorkflow,
  submitCorrectionWorkflow,
} from '../../src/lib/workflow/correctionWorkflow'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import {
  setCorrectionRepository,
  type CorrectionRequest,
} from '../../src/lib/corrections'
import { InMemoryCorrectionRepository } from '../../src/lib/corrections/repository/InMemoryCorrectionRepository'
import {
  InMemoryTeamMemberRepository,
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import {
  setNotificationRepository,
  InMemoryNotificationRepository,
} from '../../src/lib/notifications/repository'
import { setCalendarRepository } from '../../src/lib/calendar/repository/registry'
import { InMemoryCalendarRepository } from '../../src/lib/calendar/repository/InMemoryCalendarRepository'
import {
  installMockSession,
  resetMockSession,
  mockOwnerSession,
  mockWorkerSession,
} from '../helpers/mockSession'
import type { TeamMember } from '../../src/lib/jobs/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'prov-A'
const OTHER_PROVIDER_ID = 'prov-B'
const OWNER_USER_ID = 'user-owner'
const WORKER_USER_ID = 'user-worker'
const FOREIGN_OWNER_USER_ID = 'user-foreign-owner'
const TEAM_MEMBER_OWNER_ID = 'tm-owner'
const TEAM_MEMBER_WORKER_ID = 'tm-worker'

const ownerMember: TeamMember = {
  id: TEAM_MEMBER_OWNER_ID,
  userId: OWNER_USER_ID,
  providerId: PROVIDER_ID,
  fullName: 'Owner User',
  role: 'owner',
}

const workerMember: TeamMember = {
  id: TEAM_MEMBER_WORKER_ID,
  userId: WORKER_USER_ID,
  providerId: PROVIDER_ID,
  fullName: 'Worker User',
  role: 'worker',
}

const foreignOwner: TeamMember = {
  id: 'tm-foreign',
  userId: FOREIGN_OWNER_USER_ID,
  providerId: OTHER_PROVIDER_ID,
  fullName: 'Foreign Owner',
  role: 'owner',
}

function makeCalendarEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'cal-1',
    jobId: 'job-1',
    kind: 'job',
    providerId: PROVIDER_ID,
    title: 'Bad Müller',
    description: '',
    customerName: 'Müller',
    location: 'Berlin',
    dateLabel: 'Mo 28.04.',
    dateKey: '2026-04-28',
    startsAtLabel: '08:00',
    endsAtLabel: '16:00',
    assignedMemberIds: [TEAM_MEMBER_WORKER_ID],
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setCorrectionRepository(new InMemoryCorrectionRepository([]))
  setTeamMemberRepository(new InMemoryTeamMemberRepository())
  setNotificationRepository(new InMemoryNotificationRepository())
  setCalendarRepository(new InMemoryCalendarRepository([]))
  // Replace mock team data with our deterministic fixture set.
  const teamRepo = new InMemoryTeamMemberRepository()
  teamRepo.add(ownerMember)
  teamRepo.add(workerMember)
  teamRepo.add(foreignOwner)
  setTeamMemberRepository(teamRepo)
})

afterEach(() => {
  resetMockSession()
})

// ── Submit ───────────────────────────────────────────────────────────────────

describe('submitCorrectionWorkflow', () => {
  it('creates a correction with worker membership fields', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const result = await submitCorrectionWorkflow({
      kind: 'wrong_time',
      description: 'Arbeitszeit Mo 28.04. ist falsch',
    })

    expect(result.providerId).toBe(PROVIDER_ID)
    expect(result.workerTeamMemberId).toBe(TEAM_MEMBER_WORKER_ID)
    expect(result.workerProfileId).toBe(WORKER_USER_ID)
    expect(result.status).toBe('open')
    expect(result.kind).toBe('wrong_time')
  })

  it('rejects empty description', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      submitCorrectionWorkflow({ kind: 'wrong_time', description: '   ' }),
    ).rejects.toBeInstanceOf(CorrectionWorkflowError)
  })

  it('rejects callers without a session', async () => {
    resetMockSession()
    await expect(
      submitCorrectionWorkflow({ kind: 'other', description: 'any' }),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('rejects callers who are not a team member', async () => {
    installMockSession(mockWorkerSession('user-no-team'))
    await expect(
      submitCorrectionWorkflow({ kind: 'other', description: 'any' }),
    ).rejects.toBeInstanceOf(CorrectionWorkflowError)
  })

  it('passes through optional requestedDate and calendarEntryId', async () => {
    setCalendarRepository(new InMemoryCalendarRepository([makeCalendarEntry()]))
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const result = await submitCorrectionWorkflow({
      kind: 'missing_time',
      description: 'fehlt',
      requestedDate: '2026-04-28',
      calendarEntryId: 'cal-1',
    })
    expect(result.requestedDate).toBe('2026-04-28')
    expect(result.calendarEntryId).toBe('cal-1')
  })

  // Block 7.2.4 — structured fields on submit
  it('persists structured fields when provided', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const result = await submitCorrectionWorkflow({
      kind: 'wrong_time',
      description: 'falsche Zeit',
      field: 'Arbeitszeit Mo 28.04.',
      currentValue: '6h',
      proposedValue: '8h',
      reason: 'Foto zeigt 7:30–15:30',
    })
    expect(result.field).toBe('Arbeitszeit Mo 28.04.')
    expect(result.currentValue).toBe('6h')
    expect(result.proposedValue).toBe('8h')
    expect(result.reason).toBe('Foto zeigt 7:30–15:30')
  })

  it('omits whitespace-only structured fields', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    const result = await submitCorrectionWorkflow({
      kind: 'other',
      description: 'beschreibung',
      field: '   ',
      currentValue: '',
      proposedValue: '\t',
      reason: undefined,
    })
    expect(result.field).toBeUndefined()
    expect(result.currentValue).toBeUndefined()
    expect(result.proposedValue).toBeUndefined()
    expect(result.reason).toBeUndefined()
  })
})

// ── Approve ──────────────────────────────────────────────────────────────────

describe('approveCorrectionWorkflow', () => {
  let openCorrection: CorrectionRequest

  beforeEach(async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    openCorrection = await submitCorrectionWorkflow({
      kind: 'wrong_time',
      description: 'falsche Zeit',
    })
  })

  it('transitions open → resolved as the team owner', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await approveCorrectionWorkflow(openCorrection.id, {
      ownerNote: 'übernommen',
    })
    expect(result.status).toBe('resolved')
    expect(result.ownerNote).toBe('übernommen')
  })

  it('rejects approval by a worker', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      approveCorrectionWorkflow(openCorrection.id),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('rejects approval by an owner of a different team', async () => {
    installMockSession(mockOwnerSession(FOREIGN_OWNER_USER_ID))
    await expect(
      approveCorrectionWorkflow(openCorrection.id),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('is idempotent on already-resolved corrections', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await approveCorrectionWorkflow(openCorrection.id, { ownerNote: 'first' })
    const second = await approveCorrectionWorkflow(openCorrection.id)
    expect(second.status).toBe('resolved')
    expect(second.ownerNote).toBe('first')
  })

  it('refuses to revive a rejected correction', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await rejectCorrectionWorkflow(openCorrection.id, 'no')
    await expect(
      approveCorrectionWorkflow(openCorrection.id),
    ).rejects.toBeInstanceOf(CorrectionWorkflowError)
  })

  it('throws not-found for unknown id', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await expect(
      approveCorrectionWorkflow('cr-missing'),
    ).rejects.toBeInstanceOf(CorrectionWorkflowError)
  })
})

// ── Reject ───────────────────────────────────────────────────────────────────

describe('rejectCorrectionWorkflow', () => {
  let openCorrection: CorrectionRequest

  beforeEach(async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    openCorrection = await submitCorrectionWorkflow({
      kind: 'wrong_time',
      description: 'falsche Zeit',
    })
  })

  it('transitions open → rejected with note as the team owner', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await rejectCorrectionWorkflow(
      openCorrection.id,
      'Pause abziehen',
    )
    expect(result.status).toBe('rejected')
    expect(result.ownerNote).toBe('Pause abziehen')
  })

  it('rejects calls without a non-empty note', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await expect(
      rejectCorrectionWorkflow(openCorrection.id, '   '),
    ).rejects.toBeInstanceOf(CorrectionWorkflowError)
  })

  it('rejects rejection by a worker', async () => {
    installMockSession(mockWorkerSession(WORKER_USER_ID))
    await expect(
      rejectCorrectionWorkflow(openCorrection.id, 'foreign'),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('rejects rejection by a foreign owner', async () => {
    installMockSession(mockOwnerSession(FOREIGN_OWNER_USER_ID))
    await expect(
      rejectCorrectionWorkflow(openCorrection.id, 'foreign'),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('is idempotent on already-rejected corrections', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await rejectCorrectionWorkflow(openCorrection.id, 'first')
    const second = await rejectCorrectionWorkflow(openCorrection.id, 'second')
    expect(second.status).toBe('rejected')
    expect(second.ownerNote).toBe('first')
  })
})
