/**
 * useHomeState — Pure helper unit tests
 *
 * Only tests filterTodayEntriesForWorker, the exported pure function.
 * The three hooks require subscription infrastructure and are covered by
 * integration tests.  No @testing-library/react is used here.
 *
 * Source-inspection tests for useOwnerHomeState verify that the profileLoaded
 * guard preventing a false onboarding_incomplete flash is structurally present.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filterTodayEntriesForWorker } from '../../src/hooks/useHomeState'
import type { CalendarEntry } from '../../src/lib/calendar'
import type { TeamMember } from '../../src/lib/jobs'

// ── Factories ─────────────────────────────────────────────────────────────────

function makeEntry(
  id: string,
  dateKey: string,
  assignedMemberIds: string[],
  overrides: Partial<CalendarEntry> = {}
): CalendarEntry {
  return {
    id,
    kind: 'job',
    title: 'Test Einsatz',
    description: '',
    customerName: 'Kunde',
    location: 'Musterstraße 1',
    dateLabel: 'Heute',
    dateKey,
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds,
    status: 'scheduled',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function makeMember(id: string, userId?: string, providerId?: string): TeamMember {
  return { id, userId, providerId, name: 'Test Member', role: 'worker' }
}

const TODAY = '2026-04-27'
const TOMORROW = '2026-04-28'
const USER_ID = 'user-abc'
const MEMBER_ID = 'tm-99'

// ── filterTodayEntriesForWorker ───────────────────────────────────────────────

describe('filterTodayEntriesForWorker', () => {
  it('returns today entries linked via userId→member bridge', () => {
    const member = makeMember(MEMBER_ID, USER_ID)
    const entries = [
      makeEntry('e1', TODAY, [MEMBER_ID]),
      makeEntry('e2', TOMORROW, [MEMBER_ID]),
    ]
    const result = filterTodayEntriesForWorker(entries, [member], USER_ID, TODAY, false)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e1')
  })

  it('excludes non-today entries even when member is linked', () => {
    const member = makeMember(MEMBER_ID, USER_ID)
    const entries = [
      makeEntry('tomorrow', TOMORROW, [MEMBER_ID]),
      makeEntry('yesterday', '2026-04-26', [MEMBER_ID]),
    ]
    const result = filterTodayEntriesForWorker(entries, [member], USER_ID, TODAY, false)
    expect(result).toHaveLength(0)
  })

  it('returns empty array when user has no entries and isInMemory is false', () => {
    const entries = [makeEntry('e1', TODAY, ['tm-1'])]
    const result = filterTodayEntriesForWorker(entries, [], USER_ID, TODAY, false)
    expect(result).toHaveLength(0)
  })

  it('falls back to tm-1 when user has no entries and isInMemory is true', () => {
    const entries = [
      makeEntry('e-tm1', TODAY, ['tm-1']),
      makeEntry('e-other', TODAY, ['tm-2']),
    ]
    const result = filterTodayEntriesForWorker(entries, [], USER_ID, TODAY, true)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e-tm1')
  })

  it('does NOT fall back to tm-1 when user has real entries and isInMemory is true', () => {
    const member = makeMember(MEMBER_ID, USER_ID)
    const entries = [
      makeEntry('e-user', TODAY, [MEMBER_ID]),
      makeEntry('e-tm1', TODAY, ['tm-1']),
    ]
    const result = filterTodayEntriesForWorker(entries, [member], USER_ID, TODAY, true)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e-user')
  })

  it('returns empty array when all data is empty', () => {
    const result = filterTodayEntriesForWorker([], [], USER_ID, TODAY, false)
    expect(result).toHaveLength(0)
  })

  it('applies company scope when member has a providerId', () => {
    const member = makeMember(MEMBER_ID, USER_ID, 'provider-a')
    const entries = [
      makeEntry('e-a', TODAY, [MEMBER_ID], { providerId: 'provider-a' }),
      makeEntry('e-b', TODAY, [MEMBER_ID], { providerId: 'provider-b' }),
      makeEntry('e-legacy', TODAY, [MEMBER_ID]),  // no providerId — legacy, passes through
    ]
    const result = filterTodayEntriesForWorker(entries, [member], USER_ID, TODAY, false)
    expect(result.map((e) => e.id).sort()).toEqual(['e-a', 'e-legacy'].sort())
  })

  it('falls back to direct member-id match when userId is not found in teamMembers', () => {
    // Legacy/demo: userId happens to equal the member id (no userId field set)
    const entries = [makeEntry('e1', TODAY, [USER_ID])]
    const result = filterTodayEntriesForWorker(entries, [], USER_ID, TODAY, false)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e1')
  })

  it('returns multiple today entries when member has several assignments', () => {
    const member = makeMember(MEMBER_ID, USER_ID)
    const entries = [
      makeEntry('e1', TODAY, [MEMBER_ID]),
      makeEntry('e2', TODAY, [MEMBER_ID]),
      makeEntry('e3', TODAY, [MEMBER_ID], { status: 'in_progress' }),
    ]
    const result = filterTodayEntriesForWorker(entries, [member], USER_ID, TODAY, false)
    expect(result).toHaveLength(3)
  })
})

// ── R1 regression: false onboarding_incomplete flash ─────────────────────────
//
// Before the fix, jobs hydrating before the async profile fetch settled would
// cause useOwnerHomeState to derive kind:'onboarding_incomplete' because
// OWNER_LOADING_PROGRESS.isProfileReady === false.  The fix adds profileLoaded
// state so the memo returns kind:'loading' until the fetch settles.

const hookSource = readFileSync(
  resolve(__dirname, '../../src/hooks/useHomeState.ts'),
  'utf8'
)

describe('useOwnerHomeState — R1 profileLoaded guard', () => {
  it('declares profileLoaded state with false initial value', () => {
    expect(hookSource).toContain("useState(false)")
    expect(hookSource).toContain('profileLoaded')
  })

  it('sets profileLoaded true in the async success path', () => {
    // Both setOnboardingProgress and setProfileLoaded(true) must appear inside
    // the try block of the async load function.
    const tryBlock = hookSource.slice(
      hookSource.indexOf('async function load()'),
      hookSource.indexOf('} catch')
    )
    expect(tryBlock).toContain('setProfileLoaded(true)')
  })

  it('sets profileLoaded true in the async error path', () => {
    // Even on failure the guard must be lifted so the UI exits the loading state.
    const catchBlock = hookSource.slice(
      hookSource.indexOf('} catch'),
      hookSource.indexOf('void load()')
    )
    expect(catchBlock).toContain('setProfileLoaded(true)')
  })

  it('memo returns loading early when profileLoaded is false', () => {
    expect(hookSource).toContain('if (!profileLoaded)')
    expect(hookSource).toContain("kind: 'loading'")
  })

  it('profileLoaded is in the useMemo dependency array', () => {
    // The deps comment line contains the dep list for the owner memo.
    // Verify profileLoaded appears alongside paymentsTick in the deps.
    const ownerMemoSection = hookSource.slice(
      hookSource.indexOf('useOwnerHomeState'),
      hookSource.indexOf('useEmployeeHomeState')
    )
    expect(ownerMemoSection).toContain('profileLoaded')
    // Confirm it appears in the deps array (after the eslint-disable comment)
    const depsLine = ownerMemoSection.slice(ownerMemoSection.lastIndexOf('}, ['))
    expect(depsLine).toContain('profileLoaded')
  })
})
