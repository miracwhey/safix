import { describe, it, expect } from 'vitest'
import { deriveWorkEntrySummary, deriveSetupReminder } from '../../src/lib/dashboard/workEntrySelectors'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import { createCalendarEntryFromJob } from '../../src/lib/calendar/calendarEngine'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { Dispute } from '../../src/lib/disputes/types'
import type { OnboardingProgress } from '../../src/lib/onboarding/selectors'

// ── Factories ──────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    status: 'new',
    amount: '1.000 €',
    description: 'Test description',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Dachsanierung',
    customerName: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '2026-03-30',
    startsAtLabel: '10:00',
    endsAtLabel: '12:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: `dispute-${Math.random().toString(36).slice(2, 8)}`,
    jobId: 'job-1',
    status: 'open',
    reason: 'work_quality',
    title: 'Streitfall',
    description: 'Test dispute',
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

const TODAY = '2026-03-30'

// ──────────────────────────────────────────────────────────────────────────────
// J1. Passive Entry Card states use attention framing, not timing/status narration
// ──────────────────────────────────────────────────────────────────────────────

describe('J1: Passive Entry Card uses attention framing', () => {
  it('single in-progress job uses "im Blick" not "steht an"', () => {
    const result = deriveWorkEntrySummary([makeJob({ status: 'in_progress' })], [], [])
    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.headline).not.toContain('steht an')
    expect(result.eyebrow).toBe('Im Blick behalten')
  })

  it('single coming-up job uses "im Blick" not "steht an"', () => {
    const result = deriveWorkEntrySummary(
      [makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], [],
    )
    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.headline).not.toContain('steht an')
  })

  it('multiple passive jobs use "im Blick" not "stehen an"', () => {
    const result = deriveWorkEntrySummary(
      [
        makeJob({ id: 'j1', status: 'in_progress' }),
        makeJob({ id: 'j2', status: 'waiting_payment' }),
      ],
      [], [],
    )
    expect(result.headline).toBe('2 Aufträge im Blick')
    expect(result.headline).not.toContain('stehen an')
  })

  it('payment waiting uses "im Blick" not "steht an"', () => {
    const result = deriveWorkEntrySummary([makeJob({ status: 'waiting_payment' })], [], [])
    expect(result.headline).toBe('1 Auftrag im Blick')
  })

  it('proposal sent uses "im Blick" not "steht an"', () => {
    const result = deriveWorkEntrySummary(
      [makeJob({ status: 'new', proposalSentAt: Date.now() })], [], [],
    )
    expect(result.headline).toBe('1 Auftrag im Blick')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J2. Entry Card no longer uses "Termin steht bevor" for passive attention cases
// ──────────────────────────────────────────────────────────────────────────────

describe('J2: Entry Card forbids timing/calendar wording', () => {
  const forbidden = [
    'Termin steht bevor',
    'Termine stehen bevor',
    'Anstehender Auftrag',
    'Auftrag steht an',
    'Aufträge stehen an',
  ]

  it('coming-up subtitle uses truthful scheduling wording, not "Termin steht bevor"', () => {
    const result = deriveWorkEntrySummary(
      [makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], [],
    )
    expect(result.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(result.subtitle).not.toContain('geplanter Einsatz')
    for (const phrase of forbidden) {
      expect(result.subtitle).not.toContain(phrase)
      expect(result.headline).not.toContain(phrase)
    }
  })

  it('multiple coming-up uses split scheduling truth, not "Termine stehen bevor"', () => {
    const result = deriveWorkEntrySummary(
      [
        makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] }),
        makeJob({ id: 'j2', status: 'booked', assignedMemberIds: ['w2'] }),
      ],
      [], [],
    )
    expect(result.subtitle).toContain('Einsatz terminiert')
    expect(result.subtitle).toContain('Auftrag wartet auf Terminplanung')
    expect(result.subtitle).not.toContain('geplante Einsätze')
    expect(result.subtitle).not.toContain('Termine stehen bevor')
  })

  it('no passive scenario uses forbidden wording', () => {
    const scenarios = [
      () => deriveWorkEntrySummary([makeJob({ status: 'in_progress' })], [], []),
      () => deriveWorkEntrySummary([makeJob({ status: 'waiting_payment' })], [], []),
      () => deriveWorkEntrySummary([makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], []),
      () => deriveWorkEntrySummary([makeJob({ status: 'new', proposalSentAt: Date.now() })], [], []),
    ]

    for (const scenario of scenarios) {
      const result = scenario()
      for (const phrase of forbidden) {
        expect(result.headline).not.toContain(phrase)
      }
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J3. Today Block shows only real time truth
// ──────────────────────────────────────────────────────────────────────────────

describe('J3: Today Block real time truth', () => {
  it('entry with real HH:MM time shows time and marks hasRealTime true', () => {
    const entry = makeEntry({ startsAtLabel: '14:30', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].timeLabel).toBe('14:30')
    expect(result.items[0].hasRealTime).toBe(true)
  })

  it('in_progress entry with "Jetzt" is treated as real time', () => {
    const entry = makeEntry({
      startsAtLabel: 'Jetzt',
      status: 'in_progress',
      dateKey: TODAY,
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].timeLabel).toBe('Jetzt')
    expect(result.items[0].hasRealTime).toBe(true)
  })

  it('entry with empty startsAtLabel has hasRealTime false and empty timeLabel', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].timeLabel).toBe('')
    expect(result.items[0].hasRealTime).toBe(false)
  })

  it('calendarEngine does not fabricate "09:00" for jobs without real time', () => {
    const job = makeJob({
      status: 'scheduled',
      dateLabel: 'Heute',
      assignedMemberIds: ['w1'],
    })
    const entry = createCalendarEntryFromJob(job)

    // dateLabel "Heute" has no time component → startsAtLabel must be empty
    expect(entry.startsAtLabel).toBe('')
    expect(entry.startsAtLabel).not.toBe('09:00')
  })

  it('calendarEngine extracts real time from dateLabel "Heute, 14:00 Uhr"', () => {
    const job = makeJob({
      status: 'scheduled',
      dateLabel: 'Heute, 14:00 Uhr',
      assignedMemberIds: ['w1'],
    })
    const entry = createCalendarEntryFromJob(job)

    expect(entry.startsAtLabel).toBe('14:00')
  })

  it('calendarEngine extracts real time from dateLabel "Morgen, 09:30 Uhr"', () => {
    const job = makeJob({
      status: 'booked',
      dateLabel: 'Morgen, 09:30 Uhr',
      assignedMemberIds: ['w1'],
    })
    const entry = createCalendarEntryFromJob(job)

    expect(entry.startsAtLabel).toBe('09:30')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J4. If no real time exists, no fake clock value is rendered
// ──────────────────────────────────────────────────────────────────────────────

describe('J4: No fake clock values rendered', () => {
  it('item has no time when no real time exists (single today)', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY, title: 'Montage' })
    const result = deriveTodayBlock([entry], TODAY)

    // Item should have the title but no time
    expect(result.items[0].title).toBe('Montage')
    expect(result.items[0].hasRealTime).toBe(false)
    expect(result.items[0].timeLabel).toBe('')
  })

  it('upcoming item has no time when no real time exists', () => {
    const entry = makeEntry({
      startsAtLabel: '',
      dateKey: '2026-04-02',
      dateLabel: 'Donnerstag',
      title: 'Fenster',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Fenster')
    expect(result.upcomingItem!.hasRealTime).toBe(false)
    expect(result.upcomingItem!.timeLabel).toBe('')
  })

  it('item includes time only when real (single today)', () => {
    const entry = makeEntry({ startsAtLabel: '10:00', dateKey: TODAY, title: 'Montage' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].timeLabel).toBe('10:00')
    expect(result.items[0].title).toBe('Montage')
    expect(result.items[0].hasRealTime).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J5. Today Block rows use human planning language, not workflow/internal language
// ──────────────────────────────────────────────────────────────────────────────

describe('J5: Today Block uses human planning language', () => {
  const workflowForbidden = [
    'Anfrage läuft',
    'Auftrag aus Angebot',
    'Angebot versendet',
    'Warte auf Freigabe',
    'Neue Anfrage',
    'Anstehender Auftrag',
  ]

  it('statusLabel uses "In Arbeit" for in_progress (not workflow language)', () => {
    const entry = makeEntry({ status: 'in_progress', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].statusLabel).toBe('In Arbeit')
  })

  it('statusLabel uses "Geplant" for scheduled (not workflow language)', () => {
    const entry = makeEntry({ status: 'scheduled', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].statusLabel).toBe('Geplant')
  })

  it('no workflow/internal language appears in any today block field', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, status: 'scheduled' }),
      makeEntry({ dateKey: TODAY, status: 'in_progress' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    for (const phrase of workflowForbidden) {
      expect(result.headline).not.toContain(phrase)
      expect(result.subtitle).not.toContain(phrase)
      for (const item of result.items) {
        expect(item.statusLabel).not.toContain(phrase)
        expect(item.title).not.toContain(phrase)
      }
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J6. Today Block supports all three states
// ──────────────────────────────────────────────────────────────────────────────

describe('J6: Today Block supports all four explicit modes', () => {
  it('today items → mode today_has_items', () => {
    const single = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)
    expect(single.mode).toBe('today_has_items')
    expect(single.visible).toBe(true)

    const multi = deriveTodayBlock(
      [makeEntry({ dateKey: TODAY }), makeEntry({ dateKey: TODAY })],
      TODAY,
    )
    expect(multi.mode).toBe('today_has_items')
    expect(multi.visible).toBe(true)
  })

  it('no today items but future → today_empty_but_upcoming', () => {
    const entry = makeEntry({ dateKey: '2026-04-01', dateLabel: 'Mittwoch' })
    const result = deriveTodayBlock([entry], TODAY)
    expect(result.mode).toBe('today_empty_but_upcoming')
    expect(result.headline).toBe('Heute')
    expect(result.upcomingHint).toContain('Nächster Einsatz')
    expect(result.visible).toBe(true)
  })

  it('only pending work → only_pending_exists shell', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.headline).toBe('Heute')
  })

  it('nothing at all → no_relevant_work shell', () => {
    const result = deriveTodayBlock([], TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.headline).toBe('Heute')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J7. Today Block is internally bounded/scroll-friendly when many items exist
// ──────────────────────────────────────────────────────────────────────────────

describe('J7: Today Block returns all items (component handles scroll)', () => {
  it('returns all today items without truncation', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ dateKey: TODAY, startsAtLabel: `${8 + i}:00`, title: `Job ${i + 1}` }),
    )
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items).toHaveLength(5)
    expect(result.todayCount).toBe(5)
  })

  it('component source has max-h and overflow-y-auto for scroll bounding', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('max-h-')
    expect(source).toContain('overflow-y-auto')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J8. Planning CTA routes to the simplified planning surface
// ──────────────────────────────────────────────────────────────────────────────

describe('J8: Planning CTA routes correctly', () => {
  it('Today Block CTA routes to /craftsman/operations', () => {
    const result = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)
    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toContain('Planung')
  })

  it('CTA label does not contain job-action language', () => {
    const result = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)
    expect(result.ctaLabel).not.toContain('Auftrag')
    expect(result.ctaLabel).not.toContain('Status')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J9. Planning screen hierarchy is calendar-first, not dashboard-first
// ──────────────────────────────────────────────────────────────────────────────

describe('J9: Planning screen is calendar-first', () => {
  // Repointed from CraftsmanScheduleScreen (deleted) to CraftsmanOperationsScreen,
  // the runtime planning surface. Liste/Kalender toggle and list-section-* ids
  // were ScheduleScreen-only — Operations uses DayStrip + DayTimeGrid throughout
  // so the equivalent invariant is "DayTimeGrid is the primary planning surface".
  it('does not import or render ScheduleOverviewCard (removed dashboard card)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('ScheduleOverviewCard')
  })

  it('does not import or render OperationsOverviewCard (removed dashboard card)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('OperationsOverviewCard')
  })

  it('does not import or render SchedulingLifecycleSection (removed dashboard section)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).not.toContain('SchedulingLifecycleSection')
  })

  it('team load sections appear only conditionally after planning content', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    const planningPos = source.indexOf('<DayTimeGrid')
    const teamLoadPos = source.indexOf('Auslastung heute')

    expect(planningPos).toBeGreaterThan(-1)
    expect(teamLoadPos).toBeGreaterThan(-1)
    expect(teamLoadPos).toBeGreaterThan(planningPos)

    // Team load is conditionally rendered (not always showing empty cards)
    expect(source).toContain('todayTeamLoads.length > 0')
  })

  it('no large empty-state cards when sections are empty', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanOperationsScreen.tsx', import.meta.url),
      'utf-8',
    )
    // Old oversized empty state card pattern with shadow — should not exist
    expect(source).not.toContain('shadow-[0_16px_36px_-28px')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// J11. No prior truth contracts regress
// ──────────────────────────────────────────────────────────────────────────────

describe('J11: No truth regressions', () => {
  it('Work Entry and Setup are still separate concerns', () => {
    const job = makeJob({ status: 'new' })
    const onboarding = makeOnboarding()

    const workResult = deriveWorkEntrySummary([job], [], [])
    const setupResult = deriveSetupReminder(onboarding)

    // Work entry shows work context
    expect(workResult.totalActionable).toBe(1)
    // Setup shows independently
    expect(setupResult.visible).toBe(true)
  })

  it('clean slate requires ALL queue groups truly empty', () => {
    const empty = deriveWorkEntrySummary([], [], [])
    expect(empty.headline).toBe('Gerade ist nichts offen')
    expect(empty.totalRemaining).toBe(0)

    // Any passive item prevents clean slate
    const withJob = deriveWorkEntrySummary([makeJob({ status: 'in_progress' })], [], [])
    expect(withJob.headline).not.toBe('Gerade ist nichts offen')
    expect(withJob.totalRemaining).toBeGreaterThan(0)
  })

  it('TodayBlock and schedule screen share CalendarEntry source', () => {
    const entry = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.items[0].id).toBe(entry.id)
    // Same CalendarEntry type is used for both
  })

  it('CTA "Aufgaben öffnen →" returned by selector for normal work states', () => {
    // CTA label is now data-driven from WorkEntrySummary.ctaLabel
    const result = deriveWorkEntrySummary([makeJob({ status: 'new' })], [], [])
    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
  })

  it('queue direct-action model: WorkEntryCard uses data-driven ctaRoute', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    // Routing is data-driven from summary.ctaRoute — no hardcoded route
    expect(source).toContain('summary.ctaRoute')
    expect(source).toContain('summary.ctaLabel')
  })

  it('BackofficeEntryCard still rendered on home screen', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/screens/CraftsmanDashboardScreen.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('BackofficeEntryCard')
  })

  it('dispute urgency still critical', () => {
    const result = deriveWorkEntrySummary([], [makeDispute()], [])
    expect(result.urgency).toBe('critical')
    expect(result.disputeCount).toBe(1)
  })
})
