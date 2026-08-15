import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  approveCorrectionWorkflow,
  submitCorrectionWorkflow,
} from '../../src/lib/workflow/correctionWorkflow'
import {
  setCorrectionRepository,
  type CorrectionKind,
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
import { getCalendarEntryById } from '../../src/lib/calendar/calendarStore'
import {
  installMockSession,
  resetMockSession,
  mockOwnerSession,
  mockWorkerSession,
} from '../helpers/mockSession'
import type { TeamMember } from '../../src/lib/jobs/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'prov-A'
const OWNER_USER_ID = 'user-owner'
const WORKER_USER_ID = 'user-worker'
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

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
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
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function seedOpenCorrection(opts: {
  kind: CorrectionKind
  proposedValue?: string
  calendarEntryId?: string
}) {
  installMockSession(mockWorkerSession(WORKER_USER_ID))
  return submitCorrectionWorkflow({
    kind: opts.kind,
    description: 'irgendeine Beschreibung',
    ...(opts.proposedValue ? { proposedValue: opts.proposedValue } : {}),
    ...(opts.calendarEntryId ? { calendarEntryId: opts.calendarEntryId } : {}),
  })
}

beforeEach(() => {
  setCorrectionRepository(new InMemoryCorrectionRepository([]))
  setNotificationRepository(new InMemoryNotificationRepository())
  setCalendarRepository(new InMemoryCalendarRepository([makeEntry()]))
  const teamRepo = new InMemoryTeamMemberRepository()
  teamRepo.add(ownerMember)
  teamRepo.add(workerMember)
  setTeamMemberRepository(teamRepo)
})

afterEach(() => {
  resetMockSession()
})

// ── Auto-Apply on approve ────────────────────────────────────────────────────

describe('approveCorrectionWorkflow → auto-apply (Block 7.2.7b)', () => {
  it('applies wrong_time + valid proposedValue → updates entry + sets appliedAt', async () => {
    const correction = await seedOpenCorrection({
      kind: 'wrong_time',
      proposedValue: '09:00-13:00',
      calendarEntryId: 'cal-1',
    })

    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await approveCorrectionWorkflow(correction.id)

    expect(result.status).toBe('resolved')
    expect(result.appliedAt).toBeDefined()
    expect(result.appliedTargetEntryId).toBe('cal-1')
    expect(result.applySkipReason).toBeUndefined()

    const updatedEntry = getCalendarEntryById('cal-1')
    expect(updatedEntry).toBeDefined()
    expect(updatedEntry!.startsAtLabel).toBe('09:00')
    expect(updatedEntry!.endsAtLabel).toBe('13:00')
    expect(updatedEntry!.dateKey).toBe('2026-04-28') // dateKey untouched
  })

  it('approves "other" kind → no entry change + skipReason kind_not_supported', async () => {
    const correction = await seedOpenCorrection({
      kind: 'other',
      calendarEntryId: 'cal-1',
    })

    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await approveCorrectionWorkflow(correction.id)

    expect(result.status).toBe('resolved')
    expect(result.appliedAt).toBeUndefined()
    expect(result.applySkipReason).toBe('kind_not_supported')

    const entry = getCalendarEntryById('cal-1')
    expect(entry!.startsAtLabel).toBe('08:00') // unchanged
    expect(entry!.endsAtLabel).toBe('16:00')
  })

  it('approves wrong_time + invalid proposedValue → no entry change + skipReason invalid_time_format + status resolved', async () => {
    const correction = await seedOpenCorrection({
      kind: 'wrong_time',
      proposedValue: 'morgens',
      calendarEntryId: 'cal-1',
    })

    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await approveCorrectionWorkflow(correction.id)

    expect(result.status).toBe('resolved')
    expect(result.appliedAt).toBeUndefined()
    expect(result.applySkipReason).toBe('invalid_time_format')

    const entry = getCalendarEntryById('cal-1')
    expect(entry!.startsAtLabel).toBe('08:00') // unchanged
  })

  it('approves wrong_time without calendarEntryId → skipReason missing_calendar_entry', async () => {
    const correction = await seedOpenCorrection({
      kind: 'wrong_time',
      proposedValue: '09:00-13:00',
    })

    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const result = await approveCorrectionWorkflow(correction.id)

    expect(result.status).toBe('resolved')
    expect(result.applySkipReason).toBe('missing_calendar_entry')
  })
})
