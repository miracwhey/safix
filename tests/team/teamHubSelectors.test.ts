import { describe, expect, it } from 'vitest'

import {
  deriveFilteredMembers,
  deriveInitials,
  deriveTeamHubActionItems,
  deriveTeamHubCounts,
  deriveTeamHubSubtitle,
  deriveTodayRoster,
  deriveWeeklyHoursSoll,
} from '../../src/lib/team/teamHubSelectors'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { CorrectionRequest } from '../../src/lib/corrections/types'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

const TODAY = '2026-05-06'

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  const base: TeamMember = {
    id: 'm-1',
    name: 'Anna Schmidt',
    role: 'worker',
    isActive: true,
    userId: 'u-1',
    phone: null,
    email: null,
    avatarUrl: null,
    weeklyTargetHours: null,
    dailyTargetHours: null,
  }
  return { ...base, ...overrides } as TeamMember
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? 'j-1',
    projectId: overrides.projectId ?? 'p-1',
    title: overrides.title ?? 'Bad-Renovierung',
    customer: overrides.customer ?? 'Müller',
    location: overrides.location ?? 'Müllerstr. 14',
    dateLabel: overrides.dateLabel ?? 'heute',
    status: overrides.status ?? 'in_progress',
    amount: overrides.amount ?? '0',
    description: overrides.description ?? '',
    paymentState: overrides.paymentState ?? 'in_escrow',
    documentationStatus: overrides.documentationStatus ?? '',
    assignedMemberIds: overrides.assignedMemberIds ?? ['m-1'],
    notes: overrides.notes ?? [],
    photoCount: overrides.photoCount ?? 0,
    activities: overrides.activities ?? [],
    proposalAcceptedAt: overrides.proposalAcceptedAt ?? Date.now(),
  } as Job
}

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: overrides.id ?? 'e-1',
    kind: overrides.kind ?? 'job',
    jobId: overrides.jobId ?? 'j-1',
    title: overrides.title ?? 'Bad Müllerstr.',
    description: overrides.description ?? '',
    customerName: overrides.customerName ?? 'Müller',
    location: overrides.location ?? 'Müllerstr. 14',
    dateLabel: overrides.dateLabel ?? 'heute',
    dateKey: overrides.dateKey ?? TODAY,
    startsAtLabel: overrides.startsAtLabel ?? '07:00',
    endsAtLabel: overrides.endsAtLabel ?? '15:00',
    assignedMemberIds: overrides.assignedMemberIds ?? ['m-1'],
    status: overrides.status ?? 'in_progress',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  }
}

function makeCorrection(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: overrides.id ?? 'c-1',
    providerId: overrides.providerId ?? 'pv-1',
    workerTeamMemberId: overrides.workerTeamMemberId ?? 'm-1',
    workerProfileId: overrides.workerProfileId ?? 'u-1',
    kind: overrides.kind ?? 'wrong_time',
    description: overrides.description ?? '',
    status: overrides.status ?? 'open',
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('deriveInitials', () => {
  it('uses first letters of first and last name', () => {
    expect(deriveInitials('Anna Schmidt')).toBe('AS')
  })
  it('uses first two letters when only one word', () => {
    expect(deriveInitials('leonkarim007')).toBe('LE')
  })
  it('returns ? for empty input', () => {
    expect(deriveInitials('')).toBe('?')
  })
})

describe('deriveTeamHubCounts', () => {
  it('counts active linked members, stubs, and inactive separately', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1' }),
      makeMember({ id: 'b', userId: undefined }),
      makeMember({ id: 'c', userId: 'u3', isActive: false }),
      makeMember({ id: 'd', role: 'owner' }),
    ]
    expect(deriveTeamHubCounts(members)).toEqual({
      activeCount: 1,
      stubCount: 1,
      inactiveCount: 1,
    })
  })
  it('handles empty list', () => {
    expect(deriveTeamHubCounts([])).toEqual({
      activeCount: 0, stubCount: 0, inactiveCount: 0,
    })
  })
})

describe('deriveTodayRoster', () => {
  it('includes only active linked members (excludes stubs and owner)', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1', name: 'Anna' }),
      makeMember({ id: 'b', userId: undefined, name: 'Stub' }),
      makeMember({ id: 'c', role: 'owner', name: 'Owner' }),
    ]
    const roster = deriveTodayRoster(members, [], [], TODAY)
    expect(roster.map((r) => r.memberId)).toEqual(['a'])
  })

  it('marks status on_site when calendar entry is in_progress', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const entries = [makeEntry({ assignedMemberIds: ['a'], status: 'in_progress' })]
    const roster = deriveTodayRoster(members, entries, [], TODAY)
    expect(roster[0]!.status).toBe('on_site')
  })

  it('marks status scheduled_today when calendar entry exists but not in_progress', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const entries = [makeEntry({ assignedMemberIds: ['a'], status: 'scheduled' })]
    const roster = deriveTodayRoster(members, entries, [], TODAY)
    expect(roster[0]!.status).toBe('scheduled_today')
  })

  it('marks status free_today when no entries today', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const roster = deriveTodayRoster(members, [], [], TODAY)
    expect(roster[0]!.status).toBe('free_today')
  })

  it('marks status overloaded when 3+ active jobs assigned', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const jobs = [
      makeJob({ id: 'j1', assignedMemberIds: ['a'], status: 'in_progress' }),
      makeJob({ id: 'j2', assignedMemberIds: ['a'], status: 'scheduled', proposalAcceptedAt: Date.now() }),
      makeJob({ id: 'j3', assignedMemberIds: ['a'], status: 'in_progress' }),
    ]
    const roster = deriveTodayRoster(members, [], jobs, TODAY)
    expect(roster[0]!.status).toBe('overloaded')
    expect(roster[0]!.totalActiveJobs).toBe(3)
  })

  it('skips cancelled and completed entries', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const entries = [
      makeEntry({ id: 'e1', assignedMemberIds: ['a'], status: 'cancelled' }),
      makeEntry({ id: 'e2', assignedMemberIds: ['a'], status: 'completed' }),
    ]
    const roster = deriveTodayRoster(members, entries, [], TODAY)
    expect(roster[0]!.status).toBe('free_today')
  })
})

describe('deriveTeamHubActionItems', () => {
  it('counts open and in_review corrections', () => {
    const items = deriveTeamHubActionItems(
      [],
      [
        makeCorrection({ status: 'open' }),
        makeCorrection({ status: 'in_review' }),
        makeCorrection({ status: 'resolved' }),
      ],
      [],
    )
    expect(items.openCorrectionsCount).toBe(2)
  })

  it('returns pending stubs (active, no userId)', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1' }),
      makeMember({ id: 'b', userId: undefined }),
      makeMember({ id: 'c', userId: undefined, isActive: false }),
      makeMember({ id: 'd', role: 'owner', userId: undefined }),
    ]
    const items = deriveTeamHubActionItems(members, [], [])
    expect(items.pendingStubs.map((s) => s.id)).toEqual(['b'])
  })

  it('flags members with 3+ active jobs as high load, sorted by count', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1', name: 'Anna' }),
      makeMember({ id: 'b', userId: 'u2', name: 'Bob' }),
    ]
    const jobs = [
      // a: 4 jobs
      makeJob({ id: 'j1', assignedMemberIds: ['a'] }),
      makeJob({ id: 'j2', assignedMemberIds: ['a'], status: 'scheduled', proposalAcceptedAt: Date.now() }),
      makeJob({ id: 'j3', assignedMemberIds: ['a'] }),
      makeJob({ id: 'j4', assignedMemberIds: ['a'] }),
      // b: 3 jobs
      makeJob({ id: 'j5', assignedMemberIds: ['b'] }),
      makeJob({ id: 'j6', assignedMemberIds: ['b'] }),
      makeJob({ id: 'j7', assignedMemberIds: ['b'] }),
    ]
    const items = deriveTeamHubActionItems(members, [], jobs)
    expect(items.highLoadMembers).toEqual([
      { memberId: 'a', displayName: 'Anna', activeJobCount: 4 },
      { memberId: 'b', displayName: 'Bob', activeJobCount: 3 },
    ])
  })

  it('does not flag members with fewer than 3 jobs', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    const jobs = [
      makeJob({ id: 'j1', assignedMemberIds: ['a'] }),
      makeJob({ id: 'j2', assignedMemberIds: ['a'] }),
    ]
    expect(deriveTeamHubActionItems(members, [], jobs).highLoadMembers).toEqual([])
  })
})

describe('deriveTeamHubSubtitle', () => {
  it('returns onboarding hint when team is empty', () => {
    expect(deriveTeamHubSubtitle([], [])).toBe('Noch keine Mitarbeiter')
  })

  it('shows active count alone', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    expect(deriveTeamHubSubtitle(members, [])).toBe('1 aktiv')
  })

  it('appends stub count when stubs wait', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1' }),
      makeMember({ id: 'b', userId: undefined }),
    ]
    expect(deriveTeamHubSubtitle(members, [])).toBe('1 aktiv · 1 wartet')
  })

  it('appends correction count when open', () => {
    const members = [makeMember({ id: 'a', userId: 'u1' })]
    expect(
      deriveTeamHubSubtitle(members, [makeCorrection({ status: 'open' })]),
    ).toBe('1 aktiv · 1 Korrektur offen')
  })
})

describe('deriveWeeklyHoursSoll', () => {
  it('returns target hours per active linked member', () => {
    const members = [
      makeMember({ id: 'a', userId: 'u1', name: 'Anna', weeklyTargetHours: 40 }),
      makeMember({ id: 'b', userId: 'u2', name: 'Bob', weeklyTargetHours: null }),
      makeMember({ id: 'c', userId: undefined }),
    ]
    expect(deriveWeeklyHoursSoll(members)).toEqual([
      { memberId: 'a', displayName: 'Anna', initials: 'AN', targetHours: 40 },
      { memberId: 'b', displayName: 'Bob', initials: 'BO', targetHours: null },
    ])
  })
})

describe('deriveFilteredMembers', () => {
  it('returns empty for empty input', () => {
    expect(deriveFilteredMembers([], '', false)).toEqual([])
  })

  it('always excludes owner role', () => {
    const members = [
      makeMember({ id: 'o', name: 'Owner', role: 'owner' }),
      makeMember({ id: 'w', name: 'Worker', role: 'worker' }),
    ]
    const result = deriveFilteredMembers(members, '', false)
    expect(result.map((m) => m.id)).toEqual(['w'])
  })

  it('hides inactive members by default', () => {
    const members = [
      makeMember({ id: 'a', name: 'Active', isActive: true }),
      makeMember({ id: 'i', name: 'Inactive', isActive: false }),
    ]
    expect(deriveFilteredMembers(members, '', false).map((m) => m.id)).toEqual(['a'])
  })

  it('includes inactive members when showInactive is true', () => {
    const members = [
      makeMember({ id: 'a', name: 'Active', isActive: true }),
      makeMember({ id: 'i', name: 'Inactive', isActive: false }),
    ]
    expect(deriveFilteredMembers(members, '', true).map((m) => m.id).sort()).toEqual(['a', 'i'])
  })

  it('matches query against name (case insensitive)', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna Schmidt' }),
      makeMember({ id: 'b', name: 'Bob Hoffmann' }),
    ]
    expect(deriveFilteredMembers(members, 'ANNA', false).map((m) => m.id)).toEqual(['a'])
    expect(deriveFilteredMembers(members, 'hoff', false).map((m) => m.id)).toEqual(['b'])
  })

  it('matches query against email', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna', email: 'anna@ex.de' }),
      makeMember({ id: 'b', name: 'Bob', email: 'bob@x.de' }),
    ]
    expect(deriveFilteredMembers(members, 'anna@', false).map((m) => m.id)).toEqual(['a'])
  })

  it('matches query against role', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna', role: 'maler' }),
      makeMember({ id: 'b', name: 'Bob', role: 'sanitaer' }),
    ]
    expect(deriveFilteredMembers(members, 'maler', false).map((m) => m.id)).toEqual(['a'])
  })

  it('treats whitespace-only query as empty', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna' }),
      makeMember({ id: 'b', name: 'Bob' }),
    ]
    expect(deriveFilteredMembers(members, '   ', false).map((m) => m.id).sort()).toEqual(['a', 'b'])
  })

  it('combines query + inactive toggle correctly', () => {
    const members = [
      makeMember({ id: 'a', name: 'Anna', isActive: true }),
      makeMember({ id: 'a-i', name: 'Anna Inactive', isActive: false }),
      makeMember({ id: 'b', name: 'Bob', isActive: false }),
    ]
    // showInactive=false, query='anna' → only active Anna
    expect(deriveFilteredMembers(members, 'anna', false).map((m) => m.id)).toEqual(['a'])
    // showInactive=true, query='anna' → both Annas
    expect(deriveFilteredMembers(members, 'anna', true).map((m) => m.id).sort()).toEqual(['a', 'a-i'])
  })
})
