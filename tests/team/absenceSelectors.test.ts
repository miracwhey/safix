import { describe, expect, it } from 'vitest'

import {
  deriveActiveSickToday,
  deriveAbsenceDaysCount,
  deriveAbsenceHistory,
  deriveSpringerCandidates,
  deriveReassignmentPreview,
} from '../../src/lib/team/absenceSelectors'
import type { Absence } from '../../src/lib/team/absenceTypes'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

const TODAY = '2026-05-08'

function makeAbsence(overrides: Partial<Absence> = {}): Absence {
  return {
    id: overrides.id ?? 'a-1',
    providerId: overrides.providerId ?? 'p-1',
    memberId: overrides.memberId ?? 'm-1',
    type: overrides.type ?? 'sick',
    startDate: overrides.startDate ?? TODAY,
    endDate: overrides.endDate ?? TODAY,
    reasonNote: overrides.reasonNote ?? null,
    status: overrides.status ?? 'active',
    sickNoteRequested: overrides.sickNoteRequested ?? false,
    sickNoteRequestedAt: overrides.sickNoteRequestedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    createdAt: overrides.createdAt ?? '2026-05-08T08:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-08T08:00:00.000Z',
  }
}

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  const base: TeamMember = {
    id: 'm-1',
    name: 'Anna',
    role: 'worker',
    isActive: true,
    userId: 'u-1',
    phone: null,
    email: null,
    avatarUrl: null,
    weeklyTargetHours: null,
    dailyTargetHours: null,
  } as TeamMember
  return { ...base, ...overrides } as TeamMember
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? 'j-1',
    projectId: 'p-1',
    title: overrides.title ?? 'Bad Müllerstr.',
    customer: 'Müller',
    location: 'Müllerstr. 14',
    dateLabel: 'heute',
    status: overrides.status ?? 'in_progress',
    amount: '0',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: overrides.assignedMemberIds ?? ['m-1'],
    notes: [],
    photoCount: 0,
    activities: [],
    proposalAcceptedAt: Date.now(),
  } as Job
}

describe('deriveActiveSickToday', () => {
  it('maps active sick rows to memberId on the start day', () => {
    const result = deriveActiveSickToday([makeAbsence()], TODAY)
    expect(result.size).toBe(1)
    const entry = result.get('m-1')
    expect(entry).toBeDefined()
    expect(entry!.dayCount).toBe(1)
    expect(entry!.absenceId).toBe('a-1')
  })

  it('shows day 3 on the third day of a 5-day absence', () => {
    const absence = makeAbsence({ startDate: '2026-05-06', endDate: '2026-05-10' })
    const result = deriveActiveSickToday([absence], '2026-05-08')
    expect(result.get('m-1')!.dayCount).toBe(3)
  })

  it('excludes cancelled absences', () => {
    const absence = makeAbsence({ status: 'cancelled', cancelledAt: '2026-05-08T09:00:00.000Z' })
    expect(deriveActiveSickToday([absence], TODAY).size).toBe(0)
  })

  it('excludes vacation/other types from the sick map', () => {
    expect(deriveActiveSickToday([makeAbsence({ type: 'vacation' })], TODAY).size).toBe(0)
    expect(deriveActiveSickToday([makeAbsence({ type: 'other' })], TODAY).size).toBe(0)
  })

  it('excludes absences before/after today', () => {
    const before = makeAbsence({ id: 'a-before', startDate: '2026-05-01', endDate: '2026-05-03' })
    const after = makeAbsence({ id: 'a-after', startDate: '2026-05-09', endDate: '2026-05-10' })
    expect(deriveActiveSickToday([before, after], TODAY).size).toBe(0)
  })

  it('keeps the latest startDate when a member has overlapping rows', () => {
    const older = makeAbsence({ id: 'a-old', startDate: '2026-05-05', endDate: '2026-05-09' })
    const newer = makeAbsence({ id: 'a-new', startDate: '2026-05-07', endDate: '2026-05-10' })
    const result = deriveActiveSickToday([older, newer], TODAY)
    expect(result.get('m-1')!.absenceId).toBe('a-new')
    expect(result.get('m-1')!.dayCount).toBe(2) // 08 - 07 + 1
  })
})

describe('deriveAbsenceDaysCount', () => {
  it('returns 1 on the start day', () => {
    expect(deriveAbsenceDaysCount(makeAbsence(), TODAY)).toBe(1)
  })

  it('returns 1 even if today < start (defensive lower bound)', () => {
    const future = makeAbsence({ startDate: '2026-05-20', endDate: '2026-05-22' })
    expect(deriveAbsenceDaysCount(future, TODAY)).toBe(1)
  })

  it('caps at end_date when today > end', () => {
    const past = makeAbsence({ startDate: '2026-05-01', endDate: '2026-05-03' })
    expect(deriveAbsenceDaysCount(past, TODAY)).toBe(3)
  })
})

describe('deriveAbsenceHistory', () => {
  it('returns absences for a member sorted by startDate desc', () => {
    const a = makeAbsence({ id: 'a-1', startDate: '2026-05-01' })
    const b = makeAbsence({ id: 'a-2', startDate: '2026-05-05' })
    const otherMember = makeAbsence({ id: 'a-3', memberId: 'm-2', startDate: '2026-05-04' })
    const result = deriveAbsenceHistory([a, b, otherMember], 'm-1')
    expect(result.map((x) => x.id)).toEqual(['a-2', 'a-1'])
  })
})

describe('deriveSpringerCandidates', () => {
  it('excludes the sick member and stubs', () => {
    const members = [
      makeMember({ id: 'm-1' }), // sick
      makeMember({ id: 'm-2', name: 'Bert' }),
      makeMember({ id: 'm-3', name: 'Carla', userId: undefined }), // stub
      makeMember({ id: 'm-4', name: 'Dora' }),
    ]
    const jobs = [makeJob({ id: 'j-1', assignedMemberIds: ['m-1'] })]
    const result = deriveSpringerCandidates(members, jobs, new Set(['m-1']))
    expect(result.map((c) => c.memberId)).toEqual(['m-2', 'm-4'])
  })

  it('excludes inactive and owners', () => {
    const members = [
      makeMember({ id: 'm-2', name: 'Bert', isActive: false }),
      makeMember({ id: 'm-3', name: 'Carla', role: 'owner' }),
      makeMember({ id: 'm-4', name: 'Dora' }),
    ]
    const result = deriveSpringerCandidates(members, [], new Set())
    expect(result.map((c) => c.memberId)).toEqual(['m-4'])
  })

  it('sorts by affectedJobCount desc, then name asc', () => {
    const members = [
      makeMember({ id: 'm-2', name: 'Zora' }),
      makeMember({ id: 'm-3', name: 'Anna' }),
    ]
    const jobs = [makeJob({ id: 'j-1' }), makeJob({ id: 'j-2' })]
    const result = deriveSpringerCandidates(members, jobs, new Set())
    // both have affectedJobCount=2 (jobs.length); tie-break alphabetical
    expect(result.map((c) => c.displayName)).toEqual(['Anna', 'Zora'])
  })
})

describe('deriveReassignmentPreview', () => {
  it('lists jobs assigned to the from-member', () => {
    const jobs = [
      makeJob({ id: 'j-1', title: 'Bad', assignedMemberIds: ['m-1'] }),
      makeJob({ id: 'j-2', title: 'Küche', assignedMemberIds: ['m-2'] }),
      makeJob({ id: 'j-3', title: 'Dach', assignedMemberIds: ['m-1', 'm-3'] }),
    ]
    const result = deriveReassignmentPreview(jobs, 'm-1', 'm-9')
    expect(result.jobIds).toEqual(['j-1', 'j-3'])
    expect(result.jobTitles).toEqual(['Bad', 'Dach'])
  })
})
