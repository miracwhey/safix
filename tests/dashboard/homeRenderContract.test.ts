/**
 * Home Render Contract Hardening Tests
 *
 * Proves the final Home screen contract is stable and explicit.
 * Each test validates a specific render contract guarantee:
 *
 *   1.  Pending work does not appear as true scheduled today content
 *   2.  Scheduled today work appears in TodayBlock
 *   3.  Upcoming-only behavior matches the final contract (visible, today_empty_but_upcoming mode)
 *   4.  No-work behavior matches the final contract (visible, no_relevant_work mode)
 *   5.  WorkEntry wording remains truthful across pending/scheduled/in_progress states
 *   6.  Setup stays separate and secondary
 *   7.  Home render order stays correct (Work > Setup > Stats > Today > Spatial > Backoffice)
 *   8.  Loading / hydration does not create contradictory states
 *   9.  Pending → scheduled transition updates Home surfaces coherently
 *   10. Queue / Home / Planning speak one consistent truth
 *   11. No fake times or fake planned wording regress
 *   12. TodayBlock mode is always explicit (never emergent hidden)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { deriveTodayBlock, type TodayBlockMode } from '../../src/lib/dashboard/todayBlockSelectors'
import { deriveWorkEntrySummary, deriveSetupReminder } from '../../src/lib/dashboard/workEntrySelectors'
import { deriveActionQueue } from '../../src/lib/dashboard/actionQueueSelectors'
import {
  createCalendarEntryFromJob,
  formatDateKey,
} from '../../src/lib/calendar/calendarEngine'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { OnboardingProgress } from '../../src/lib/onboarding/selectors'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// ── Factories ────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Testauftrag',
    customer: 'Max Mustermann',
    location: 'Berlin',
    amount: '1.200 €',
    status: 'booked',
    dateLabel: 'Heute',
    assignedMemberIds: [],
    activities: [],
    proposalSentAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Testauftrag',
    customerName: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: TODAY,
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeOnboarding(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    steps: [],
    completedCount: 3,
    totalCount: 5,
    completionPercent: 60,
    isComplete: false,
    nextStep: {
      id: 'payout_setup',
      title: 'Zahlungseinrichtung',
      description: 'Stripe Connect für Auszahlungen aktivieren',
      status: 'next',
      navigationPath: '/craftsman/finance',
    },
    isDiscoveryBlocked: false,
    isProfileReady: true,
    isPayoutReady: false,
    ...overrides,
  }
}

const TODAY = formatDateKey(new Date())
const TOMORROW = formatDateKey(new Date(Date.now() + 86400000))

beforeEach(() => {
  setupCleanRepositories()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pending work NEVER appears as true scheduled today content
// ═══════════════════════════════════════════════════════════════════════════

describe('RC1: Pending work excluded from TodayBlock items', () => {
  it('booked job → pending CalendarEntry → not in TodayBlock items', () => {
    const job = makeJob({ status: 'booked', dateLabel: 'Heute', assignedMemberIds: ['w1'] })
    const entry = createCalendarEntryFromJob(job)
    expect(entry.status).toBe('pending')

    const block = deriveTodayBlock([entry], TODAY)
    expect(block.items).toHaveLength(0)
  })

  it('pending entries mixed with scheduled → only scheduled in items', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY }),
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Real Scheduled' }),
    ]
    const block = deriveTodayBlock(entries, TODAY)
    expect(block.items).toHaveLength(1)
    expect(block.items[0].title).toBe('Real Scheduled')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Scheduled today work appears in TodayBlock
// ═══════════════════════════════════════════════════════════════════════════

describe('RC2: Scheduled today work visible in TodayBlock', () => {
  it('scheduled entry for today → visible in items', () => {
    const entry = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const block = deriveTodayBlock([entry], TODAY)
    expect(block.visible).toBe(true)
    expect(block.todayCount).toBe(1)
    expect(block.items).toHaveLength(1)
  })

  it('in_progress entry for today → visible in items', () => {
    const entry = makeEntry({ status: 'in_progress', dateKey: TODAY, startsAtLabel: 'Jetzt' })
    const block = deriveTodayBlock([entry], TODAY)
    expect(block.visible).toBe(true)
    expect(block.items[0].statusLabel).toBe('In Arbeit')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Upcoming-only behavior matches final contract
// ═══════════════════════════════════════════════════════════════════════════

describe('RC3: Upcoming-only contract', () => {
  it('no today items, future scheduled → today_empty_but_upcoming mode', () => {
    const entry = makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })
    const block = deriveTodayBlock([entry], TODAY)
    expect(block.visible).toBe(true)
    expect(block.mode).toBe('today_empty_but_upcoming')
    expect(block.headline).toBe('Heute')
    expect(block.upcomingItem).not.toBeNull()
    expect(block.items).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. No-work behavior: planner shell (not hidden)
// ═══════════════════════════════════════════════════════════════════════════

describe('RC4: No-work behavior — planner shell', () => {
  it('no entries at all → visible, no_relevant_work mode', () => {
    const block = deriveTodayBlock([], TODAY)
    expect(block.visible).toBe(true)
    expect(block.mode).toBe('no_relevant_work')
    expect(block.headline).toBe('Heute')
    expect(block.subtitle).toBe('Keine Einsätze geplant')
    expect(block.items).toHaveLength(0)
    expect(block.ctaRoute).toBe('/craftsman/operations')
  })

  it('only completed/cancelled entries → visible, no_relevant_work mode', () => {
    const entries = [
      makeEntry({ status: 'completed', dateKey: TODAY }),
      makeEntry({ status: 'cancelled', dateKey: TODAY }),
    ]
    const block = deriveTodayBlock(entries, TODAY)
    expect(block.visible).toBe(true)
    expect(block.mode).toBe('no_relevant_work')
    expect(block.items).toHaveLength(0)
  })

  it('only pending entries → visible, only_pending_exists mode', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY }),
    ]
    const block = deriveTodayBlock(entries, TODAY)
    expect(block.visible).toBe(true)
    expect(block.mode).toBe('only_pending_exists')
    expect(block.items).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. WorkEntry wording truthful across states
// ═══════════════════════════════════════════════════════════════════════════

describe('RC5: WorkEntry wording truthful', () => {
  it('pending/booked → "wartet auf Terminplanung" (not "geplanter Einsatz")', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const entry = deriveWorkEntrySummary([job], [], [])
    expect(entry.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(entry.subtitle).not.toContain('geplanter Einsatz')
  })

  it('scheduled → "Einsatz terminiert"', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    const entry = deriveWorkEntrySummary([job], [], [])
    expect(entry.subtitle).toContain('Einsatz terminiert')
  })

  it('in_progress → "Auftrag in Arbeit"', () => {
    const job = makeJob({ status: 'in_progress', assignedMemberIds: ['w1'] })
    const entry = deriveWorkEntrySummary([job], [], [])
    expect(entry.subtitle).toContain('Auftrag in Arbeit')
  })

  it('clean slate when no relevant work', () => {
    const entry = deriveWorkEntrySummary([], [], [])
    expect(entry.headline).toBe('Gerade ist nichts offen')
    expect(entry.urgency).toBe('none')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Setup stays separate and secondary
// ═══════════════════════════════════════════════════════════════════════════

describe('RC6: Setup separate from WorkEntry', () => {
  it('setup reminder derives independently from work entry', () => {
    const onboarding = makeOnboarding()
    const setup = deriveSetupReminder(onboarding, true)
    expect(setup.visible).toBe(true)
    expect(setup.headline).toBe('Zahlungseinrichtung')
  })

  it('setup hidden when complete', () => {
    const onboarding = makeOnboarding({ isComplete: true, nextStep: null })
    const setup = deriveSetupReminder(onboarding, true)
    expect(setup.visible).toBe(false)
  })

  it('setup loading state prevents pop-in', () => {
    const setup = deriveSetupReminder(null, false)
    expect(setup.loading).toBe(true)
    expect(setup.visible).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Home render order: Work > Setup > Stats > Today > Spatial > Backoffice
// ═══════════════════════════════════════════════════════════════════════════

describe('RC7: Home render order is correct', () => {
  it('CraftsmanDashboardScreen renders OwnerHomeHero and other cards in correct order', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanDashboardScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Match JSX render usage, not imports
    const renderSection = source.slice(source.indexOf('return ('))
    const heroPos = renderSection.indexOf('<OwnerHomeHero')
    const statsPos = renderSection.indexOf('<CompactDashboardStats')
    const todayPos = renderSection.indexOf('<TodayBlock')
    const spatialPos = renderSection.indexOf('<SpatialEntryCard')
    const backofficePos = renderSection.indexOf('<BackofficeEntryCard')

    // Block 7.1F — Hero must actually be present in JSX. The earlier assertion
    // shape (heroPos < statsPos) silently passed when heroPos was -1, masking
    // an unwired hero. Pin presence explicitly first.
    expect(heroPos).toBeGreaterThanOrEqual(0)
    expect(statsPos).toBeGreaterThanOrEqual(0)
    expect(todayPos).toBeGreaterThanOrEqual(0)
    expect(spatialPos).toBeGreaterThanOrEqual(0)
    expect(backofficePos).toBeGreaterThanOrEqual(0)

    expect(heroPos).toBeLessThan(statsPos)
    expect(statsPos).toBeLessThan(todayPos)
    // Spatial quick-access sits between Today and Backoffice (3D 1 tap from home).
    expect(todayPos).toBeLessThan(spatialPos)
    expect(spatialPos).toBeLessThan(backofficePos)

    // Wire-up sanity: Hero must be fed by the Owner home VM hook, not by a
    // local mirror-state. Without this, a future refactor could re-introduce
    // a parallel source-of-truth without test coverage flagging it.
    expect(source).toContain('useOwnerHomeState')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Loading / hydration does not create contradictory states
// ═══════════════════════════════════════════════════════════════════════════

describe('RC8: Hydration safety', () => {
  it('empty calendar on initial load → no_relevant_work (not hidden)', () => {
    const block = deriveTodayBlock([], TODAY)
    expect(block.visible).toBe(true)
    expect(block.mode).toBe('no_relevant_work')
  })

  it('setup loading state is explicit, not null', () => {
    const setup = deriveSetupReminder(null, false)
    expect(setup.loading).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Pending → scheduled transition updates coherently
// ═══════════════════════════════════════════════════════════════════════════

describe('RC9: Pending → scheduled transition', () => {
  it('pending entry becomes scheduled → TodayBlock updates from only_pending_exists to today_has_items', () => {
    const pendingEntry = makeEntry({ status: 'pending', dateKey: TODAY, id: 'entry-1' })
    const blockBefore = deriveTodayBlock([pendingEntry], TODAY)
    expect(blockBefore.mode).toBe('only_pending_exists')
    expect(blockBefore.items).toHaveLength(0)

    const scheduledEntry = { ...pendingEntry, status: 'scheduled' as const }
    const blockAfter = deriveTodayBlock([scheduledEntry], TODAY)
    expect(blockAfter.mode).toBe('today_has_items')
    expect(blockAfter.items).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Queue / Home / Planning speak one consistent truth
// ═══════════════════════════════════════════════════════════════════════════

describe('RC10: Queue, Home, Planning consistent truth', () => {
  it('booked unassigned job → needs_action in queue, attention in WorkEntry, empty TodayBlock', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: [] })
    const entry = createCalendarEntryFromJob(job)

    const queue = deriveActionQueue([job], [], [job])
    expect(queue.needsAction).toHaveLength(1)

    const workEntry = deriveWorkEntrySummary([job], [], [job])
    expect(workEntry.unassignedCount).toBe(1)
    expect(workEntry.urgency).toBe('high')

    const block = deriveTodayBlock([entry], TODAY)
    expect(block.mode).toBe('only_pending_exists')
    expect(block.items).toHaveLength(0)
  })

  it('scheduled assigned job → coming_up in queue, passive in WorkEntry, visible in TodayBlock', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'], dateLabel: 'Heute' })
    const entry = createCalendarEntryFromJob(job)

    const queue = deriveActionQueue([job], [], [])
    expect(queue.comingUp).toHaveLength(1)

    const workEntry = deriveWorkEntrySummary([job], [], [])
    expect(workEntry.comingUpCount).toBe(1)
    expect(workEntry.subtitle).toContain('Einsatz terminiert')

    const block = deriveTodayBlock([entry], TODAY)
    expect(block.items).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. No fake times or fake planned wording
// ═══════════════════════════════════════════════════════════════════════════

describe('RC11: No fake times or wording', () => {
  it('entry without real time has hasRealTime=false and empty timeLabel', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const block = deriveTodayBlock([entry], TODAY)
    expect(block.items[0].hasRealTime).toBe(false)
    expect(block.items[0].timeLabel).toBe('')
  })

  it('"Jetzt" is a valid real-time label', () => {
    const entry = makeEntry({ startsAtLabel: 'Jetzt', status: 'in_progress', dateKey: TODAY })
    const block = deriveTodayBlock([entry], TODAY)
    expect(block.items[0].hasRealTime).toBe(true)
    expect(block.items[0].timeLabel).toBe('Jetzt')
  })

  it('forbidden wording never appears in WorkEntry subtitle', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const entry = deriveWorkEntrySummary([job], [], [])
    expect(entry.subtitle).not.toContain('geplanter Einsatz')
    expect(entry.subtitle).not.toContain('geplante Einsätze')
    expect(entry.subtitle).not.toContain('steht an')
    expect(entry.subtitle).not.toContain('stehen an')
    expect(entry.subtitle).not.toContain('Termin steht bevor')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. TodayBlock mode is always one of the explicit contract modes
// ═══════════════════════════════════════════════════════════════════════════

describe('RC12: TodayBlock mode always explicit', () => {
  const VALID_MODES: TodayBlockMode[] = [
    'today_has_items',
    'today_empty_but_upcoming',
    'only_pending_exists',
    'no_relevant_work',
  ]

  it('every state returns a valid mode', () => {
    const scenarios = [
      deriveTodayBlock([], TODAY),
      deriveTodayBlock([makeEntry({ status: 'completed' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'pending' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'scheduled', dateKey: TODAY })], TODAY),
      deriveTodayBlock([
        makeEntry({ status: 'scheduled', dateKey: TODAY }),
        makeEntry({ status: 'scheduled', dateKey: TODAY }),
      ], TODAY),
      deriveTodayBlock([makeEntry({ status: 'scheduled', dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY),
    ]

    for (const block of scenarios) {
      expect(VALID_MODES).toContain(block.mode)
    }
  })

  it('no_relevant_work always has CTA to planning screen', () => {
    const block = deriveTodayBlock([], TODAY)
    expect(block.mode).toBe('no_relevant_work')
    expect(block.ctaRoute).toBe('/craftsman/operations')
    expect(block.ctaLabel).toBe('Planung öffnen →')
  })

  it('no accidental mode gap for non-empty calendar', () => {
    // Any calendar entry (even pending/completed) should result in a valid mode,
    // never hidden — the planner shell stays present
    const entries = [
      makeEntry({ status: 'pending' }),
      makeEntry({ status: 'completed' }),
      makeEntry({ status: 'cancelled' }),
    ]
    const block = deriveTodayBlock(entries, TODAY)
    expect(block.mode).toBe('only_pending_exists')
    expect(block.visible).toBe(true)
  })
})
