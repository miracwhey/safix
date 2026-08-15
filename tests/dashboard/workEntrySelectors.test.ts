import { describe, it, expect } from 'vitest'
import {
  deriveWorkEntrySummary,
  deriveSetupReminder,
} from '../../src/lib/dashboard/workEntrySelectors'
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('deriveWorkEntrySummary', () => {
  // ── Clean slate ────────────────────────────────────────────────────────

  it('returns clean slate when no jobs, disputes, or setup needed', () => {
    const result = deriveWorkEntrySummary([], [], [])

    expect(result.headline).toBe('Gerade ist nichts offen')
    expect(result.eyebrow).toBe('Überblick')
    expect(result.urgency).toBe('none')
    expect(result.totalActionable).toBe(0)
  })

  it('returns clean slate when onboarding is complete and no items', () => {
    // Work entry no longer depends on onboarding — it always shows work context
    const result = deriveWorkEntrySummary([], [], [])

    expect(result.headline).toBe('Gerade ist nichts offen')
    expect(result.urgency).toBe('none')
  })

  // ── Setup reminder (separate concern) ─────────────────────────────────

  it('setup reminder shows next step when onboarding incomplete', () => {
    const onboarding = makeOnboarding({
      nextStep: {
        id: 'profile_trust',
        title: 'Profilbild & Bio',
        description: 'Profilfoto und kurze Vorstellung hochladen',
        status: 'next',
        navigationPath: '/craftsman/profile',
      },
    })

    const reminder = deriveSetupReminder(onboarding)

    expect(reminder.visible).toBe(true)
    expect(reminder.headline).toBe('Profilbild & Bio')
    expect(reminder.linkTo).toBe('/craftsman/profile')
  })

  it('setup reminder shows payout step with non-blocking messaging', () => {
    const onboarding = makeOnboarding()
    const reminder = deriveSetupReminder(onboarding)

    expect(reminder.visible).toBe(true)
    expect(reminder.icon).toBe('💳')
    expect(reminder.subtitle).toContain('du kannst weiter arbeiten')
  })

  it('setup reminder hidden when onboarding complete', () => {
    const onboarding = makeOnboarding({ isComplete: true, nextStep: null })
    const reminder = deriveSetupReminder(onboarding)

    expect(reminder.visible).toBe(false)
  })

  it('setup reminder hidden when onboarding is null', () => {
    const reminder = deriveSetupReminder(null)

    expect(reminder.visible).toBe(false)
  })

  // ── B. waiting_payment is NOT actionable (craftsman cannot act) ─────────

  it('waiting_payment is NOT counted as actionable — craftsman waits', () => {
    const job = makeJob({ id: 'j1', status: 'waiting_payment', title: 'Badumbau' })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.totalActionable).toBe(0) // NOT actionable
    expect(result.paymentWaitingCount).toBe(1) // still tracked
    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.subtitle).toContain('Zahlung ausstehend')
    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.urgency).toBe('normal') // informational, not high
  })

  it('shows attention headline for single unassigned job', () => {
    const job = makeJob({ id: 'j1', status: 'booked', title: 'Dachsanierung', assignedMemberIds: [] })
    const result = deriveWorkEntrySummary([job], [], [job])

    expect(result.headline).toBe('1 Auftrag braucht Zuteilung')
    expect(result.subtitle).toContain('niemandem zugewiesen')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.urgency).toBe('high')
  })

  it('shows attention headline for single new request', () => {
    const job = makeJob({ status: 'new', title: 'Küche renovieren' })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.headline).toBe('1 Anfrage braucht Prüfung')
    expect(result.subtitle).toContain('Anfrage wartet auf dein Angebot')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.urgency).toBe('normal')
  })

  // ── Multiple actionable items ──────────────────────────────────────────

  it('shows aggregated attention headline for multiple items', () => {
    const j1 = makeJob({ id: 'j1', status: 'waiting_payment' })
    const j2 = makeJob({ id: 'j2', status: 'new' })
    const unassigned = makeJob({ id: 'j3', status: 'booked', assignedMemberIds: [] })

    const result = deriveWorkEntrySummary([j1, j2, unassigned], [], [unassigned])

    // totalActionable excludes waiting_payment (craftsman cannot act)
    expect(result.totalActionable).toBe(2) // new + unassigned only
    expect(result.headline).toBe('2 Aufgaben brauchen dich')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.urgency).toBe('high')
    expect(result.subtitle).toContain('Zuteilung')
    expect(result.subtitle).toContain('Anfrage')
  })

  // ── Dispute urgency ────────────────────────────────────────────────────

  it('shows dispute as critical urgency with attention framing', () => {
    const dispute = makeDispute({ status: 'open' })
    const job = makeJob({ status: 'new' })

    const result = deriveWorkEntrySummary([job], [dispute], [])

    expect(result.urgency).toBe('critical')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.headline).toContain('Aufgaben brauchen dich')
    expect(result.disputeCount).toBe(1)
  })

  it('counts additional tasks alongside dispute in aggregated headline', () => {
    const dispute = makeDispute({ status: 'open' })
    const j1 = makeJob({ id: 'j1', status: 'new' })
    const j2 = makeJob({ id: 'j2', status: 'waiting_payment' })

    const result = deriveWorkEntrySummary([j1, j2], [dispute], [])

    expect(result.urgency).toBe('critical')
    // totalActionable = dispute(1) + new(1), NOT including waiting_payment
    expect(result.totalActionable).toBe(2)
    expect(result.headline).toBe('2 Aufgaben brauchen dich')
    expect(result.subtitle).toContain('Streitfall')
    expect(result.subtitle).toContain('Anfrage')
  })

  it('ignores resolved disputes', () => {
    const resolved = makeDispute({
      status: 'resolved',
      decision: 'release',
      resolutionType: 'release_full',
    })
    const result = deriveWorkEntrySummary([], [resolved], [])

    expect(result.disputeCount).toBe(0)
    expect(result.urgency).toBe('none')
  })

  it('counts customer_waiting and provider_waiting as active disputes (γ active set)', () => {
    const customerWaiting = makeDispute({ id: 'd-cw', jobId: 'j-cw', status: 'customer_waiting' })
    const providerWaiting = makeDispute({ id: 'd-pw', jobId: 'j-pw', status: 'provider_waiting' })
    const job1 = makeJob({ id: 'j-cw' })
    const job2 = makeJob({ id: 'j-pw' })

    const result = deriveWorkEntrySummary([job1, job2], [customerWaiting, providerWaiting], [])

    expect(result.disputeCount).toBe(2)
    expect(result.urgency).toBe('critical')
  })

  // ── In-progress only (no actionable) ───────────────────────────────────

  it('shows passive framing for in-progress when no actionable items', () => {
    const job = makeJob({ status: 'in_progress' })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.urgency).toBe('normal')
    expect(result.totalActionable).toBe(0)
    expect(result.inProgressCount).toBe(1)
  })

  // ── In-progress + payment waiting: mentions both ───────────────────────

  it('shows passive aggregation with in-progress and payment waiting', () => {
    const ip = makeJob({ id: 'ip1', status: 'in_progress' })
    const wp = makeJob({ id: 'wp1', status: 'waiting_payment' })
    const result = deriveWorkEntrySummary([ip, wp], [], [])

    expect(result.headline).toBe('2 Aufträge im Blick')
    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.subtitle).toContain('Arbeit')
    expect(result.subtitle).toContain('Zahlung ausstehend')
    expect(result.totalActionable).toBe(0) // neither is actionable
  })

  // ── Work entry is independent of setup ─────────────────────────────────

  it('work entry shows operational work with attention framing regardless of setup state', () => {
    const job = makeJob({ status: 'new' })

    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.totalActionable).toBe(1)
    expect(result.headline).toBe('1 Anfrage braucht Prüfung')
    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
  })

  // ── Payment-waiting keeps work entry as work context ──────────────────

  it('payment waiting shows passive attention, not status label', () => {
    const job = makeJob({ status: 'waiting_payment', title: 'Badumbau' })

    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.headline).toBe('1 Auftrag im Blick')
    expect(result.eyebrow).toBe('Im Blick behalten')
  })

  // ── Work entry + setup coexistence ─────────────────────────────────────

  it('work entry and setup reminder coexist when both relevant', () => {
    const job = makeJob({ status: 'new' })
    const onboarding = makeOnboarding()

    const workResult = deriveWorkEntrySummary([job], [], [])
    const setupResult = deriveSetupReminder(onboarding)

    // Work entry shows work context with attention framing
    expect(workResult.totalActionable).toBe(1)
    expect(workResult.headline).toBe('1 Anfrage braucht Prüfung')

    // Setup reminder shows independently
    expect(setupResult.visible).toBe(true)
    expect(setupResult.headline).toBe('Zahlungseinrichtung')
  })

  it('no work + setup incomplete: both show correctly', () => {
    const onboarding = makeOnboarding()

    const workResult = deriveWorkEntrySummary([], [], [])
    const setupResult = deriveSetupReminder(onboarding)

    // Work entry shows clean slate
    expect(workResult.headline).toBe('Gerade ist nichts offen')
    expect(workResult.urgency).toBe('none')

    // Setup reminder is visible
    expect(setupResult.visible).toBe(true)
  })

  it('no work + setup complete: work entry visible, setup hidden', () => {
    const onboarding = makeOnboarding({ isComplete: true, nextStep: null })

    const workResult = deriveWorkEntrySummary([], [], [])
    const setupResult = deriveSetupReminder(onboarding)

    expect(workResult.headline).toBe('Gerade ist nichts offen')
    expect(setupResult.visible).toBe(false)
  })

  it('work exists + setup complete: work entry visible, setup hidden', () => {
    const job = makeJob({ status: 'in_progress' })
    const onboarding = makeOnboarding({ isComplete: true, nextStep: null })

    const workResult = deriveWorkEntrySummary([job], [], [])
    const setupResult = deriveSetupReminder(onboarding)

    expect(workResult.headline).toBe('1 Auftrag im Blick')
    expect(setupResult.visible).toBe(false)
  })
})

// ── ATTENTION MATRIX TESTS ─────────────────────────────────────────────────
// These tests prove the entry card consistently behaves as an attention
// summary, not a status summary.

describe('Attention Matrix — H. Required test coverage', () => {
  // H1. Assignment-needed state maps to attention summary, not raw status
  it('H1: assignment-needed uses attention framing, not status label', () => {
    const job = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] })
    const result = deriveWorkEntrySummary([job], [], [job])

    expect(result.eyebrow).toBe('Aufmerksamkeit nötig')
    expect(result.headline).toBe('1 Auftrag braucht Zuteilung')
    expect(result.subtitle).toContain('niemandem zugewiesen')
    // Must NOT use status-like phrasing
    expect(result.headline).not.toBe('Zuteilung nötig')
    expect(result.headline).not.toContain('Anstehender')
  })

  // H2. Appointment-needed (coming-up) maps to attention summary, not status language
  it('H2: coming-up/appointment-needed uses passive attention framing', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.headline).toBe('1 Auftrag im Blick')
    // Headline must NOT use old status phrasing
    expect(result.headline).not.toContain('Anstehender Auftrag')
    // Subtitle describes the attention TYPE, which is fine
    expect(result.subtitle).toBeTruthy()
  })

  // H3. Mixed states aggregate correctly into one title/subline
  it('H3: mixed actionable states aggregate into single attention headline', () => {
    const dispute = makeDispute({ status: 'open' })
    const unassigned = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] })
    const newReq = makeJob({ id: 'j2', status: 'new' })

    const result = deriveWorkEntrySummary([unassigned, newReq], [dispute], [unassigned])

    expect(result.totalActionable).toBe(3)
    expect(result.headline).toBe('3 Aufgaben brauchen dich')
    expect(result.subtitle).toContain('Streitfall')
    expect(result.subtitle).toContain('Zuteilung')
    expect(result.subtitle).toContain('Anfrage')
  })

  // H4. Waiting-only states use softer attention framing
  it('H4: waiting-only states use soft attention, not false urgency', () => {
    const paymentJob = makeJob({ id: 'j1', status: 'waiting_payment' })
    const proposalJob = makeJob({ id: 'j2', status: 'new', proposalSentAt: Date.now() })

    const result = deriveWorkEntrySummary([paymentJob, proposalJob], [], [])

    expect(result.eyebrow).toBe('Im Blick behalten')
    expect(result.headline).toBe('2 Aufträge im Blick')
    // Must NOT use urgent framing for passive states
    expect(result.eyebrow).not.toBe('Aufmerksamkeit nötig')
    expect(result.headline).not.toContain('brauchen dich')
  })

  // H5. Coming-up-only states do NOT claim "Gerade ist nichts offen"
  it('H5: coming-up work does not produce false clean slate', () => {
    const job = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([job], [], [])

    expect(result.headline).not.toBe('Gerade ist nichts offen')
    expect(result.totalRemaining).toBeGreaterThan(0)
    expect(result.comingUpCount).toBe(1)
  })

  // H6. Clean slate only when ALL queue groups are truly empty
  it('H6: clean slate requires all queue groups empty', () => {
    // Completely empty
    const empty = deriveWorkEntrySummary([], [], [])
    expect(empty.headline).toBe('Gerade ist nichts offen')
    expect(empty.eyebrow).toBe('Überblick')
    expect(empty.totalRemaining).toBe(0)

    // Any remaining item prevents clean slate
    const withProposal = deriveWorkEntrySummary(
      [makeJob({ status: 'new', proposalSentAt: Date.now() })], [], [],
    )
    expect(withProposal.headline).not.toBe('Gerade ist nichts offen')
    expect(withProposal.totalRemaining).toBeGreaterThan(0)
  })

  // H7. CTA label and route are data-driven from WorkEntrySummary
  it('H7: CTA label is "Aufgaben öffnen →" and route is the unified Aufträge surface (focus=handlungsbedarf) for normal work states', () => {
    const scenarios = [
      // Single unassigned
      () => { const j = makeJob({ status: 'booked', assignedMemberIds: [] }); return deriveWorkEntrySummary([j], [], [j]) },
      // Single new request
      () => deriveWorkEntrySummary([makeJob({ status: 'new' })], [], []),
      // In progress
      () => deriveWorkEntrySummary([makeJob({ status: 'in_progress' })], [], []),
      // Coming up (today — not future)
      () => deriveWorkEntrySummary([makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], []),
      // Payment waiting
      () => deriveWorkEntrySummary([makeJob({ status: 'waiting_payment' })], [], []),
      // Proposal sent
      () => deriveWorkEntrySummary([makeJob({ status: 'new', proposalSentAt: Date.now() })], [], []),
      // Single dispute
      () => deriveWorkEntrySummary([], [makeDispute()], []),
    ]

    for (const scenario of scenarios) {
      const result = scenario()
      expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
      expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    }
  })

  it('H7b: WorkEntryCard uses summary.ctaRoute (data-driven routing)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    // Component must use the data-driven ctaRoute and ctaLabel from summary
    expect(source).toContain('summary.ctaRoute')
    expect(source).toContain('summary.ctaLabel')
    // Must NOT have conditionals for different CTA labels inside the component
    expect(source).not.toContain('Aufgaben prüfen')
    expect(source).not.toContain('Arbeit ansehen')
    expect(source).not.toContain('Status ansehen')
    // Must NOT hardcode any route (routing is delegated to selectors via summary.ctaRoute).
    // Both the legacy work-queue path and the consolidated jobs path must not be inlined.
    expect(source).not.toContain('"/craftsman/work-queue"')
    expect(source).not.toContain('"/craftsman/jobs?focus=handlungsbedarf"')
  })

  // ── Future scheduled job routing ──────────────────────────────────────

  it('F1: future scheduled jobs are excluded from comingUpCount', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const futureJobIds = new Set(['j1'])

    const result = deriveWorkEntrySummary([futureJob], [], [], undefined, futureJobIds)

    expect(result.comingUpCount).toBe(0)
    expect(result.totalRemaining).toBe(0)
    expect(result.totalActionable).toBe(0)
  })

  it('F2: routes to planner when only future scheduled work remains', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const futureJobIds = new Set(['j1'])

    const result = deriveWorkEntrySummary([futureJob], [], [], undefined, futureJobIds)

    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toBe('Planung öffnen →')
  })

  it('F3: shows "Alles geplant" headline when only future scheduled work remains', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const futureJobIds = new Set(['j1'])

    const result = deriveWorkEntrySummary([futureJob], [], [], undefined, futureJobIds)

    expect(result.headline).toBe('Alles geplant')
    expect(result.subtitle).toContain('Kalender')
    expect(result.urgency).toBe('none')
    expect(result.icon).toBe('📅')
  })

  it('F4: routes to work queue when real work exists alongside future scheduled', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const activeJob = makeJob({ id: 'j2', status: 'new' })
    const futureJobIds = new Set(['j1'])

    const result = deriveWorkEntrySummary([futureJob, activeJob], [], [], undefined, futureJobIds)

    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.newRequestCount).toBe(1)
    expect(result.comingUpCount).toBe(0)
  })

  it('F5: empty queue with no jobs routes to work queue (not planner)', () => {
    const result = deriveWorkEntrySummary([], [], [])

    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.headline).toBe('Gerade ist nichts offen')
  })

  it('F6: future scheduled booked+schedule excluded from comingUp', () => {
    const futureJob = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const scheduledIds = new Set(['j1'])
    const futureJobIds = new Set(['j1'])

    const result = deriveWorkEntrySummary([futureJob], [], [], scheduledIds, futureJobIds)

    expect(result.comingUpCount).toBe(0)
    expect(result.totalRemaining).toBe(0)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  // H7b. CTA domain: future-scheduled-only uses planning CTA
  it('H7b: future-scheduled-only state uses planning CTA label and route', () => {
    const scheduledJob = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([scheduledJob], [], [])

    expect(result.ctaLabel).toBe('Planung öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  // H7c. CTA domain: real open work uses work-queue CTA
  it('H7c: real open work (new request) uses work-queue CTA label and route', () => {
    const newJob = makeJob({ status: 'new' })
    const result = deriveWorkEntrySummary([newJob], [], [])

    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
  })

  // H7d. CTA domain: in-progress work uses work-queue CTA
  it('H7d: in-progress work uses work-queue CTA (action queue is relevant)', () => {
    const inProg = makeJob({ status: 'in_progress' })
    const result = deriveWorkEntrySummary([inProg], [], [])

    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
  })

  // H7e. CTA domain: mixed (scheduled + in-progress) stays work-queue
  it('H7e: mixed future-scheduled + in-progress stays on work-queue CTA', () => {
    const inProg = makeJob({ id: 'ip1', status: 'in_progress' })
    const scheduled = makeJob({ id: 's1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const result = deriveWorkEntrySummary([inProg, scheduled], [], [])

    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
  })

  // H7f. CTA domain: clean slate also uses work-queue (neutral, no items)
  it('H7f: clean slate uses neutral work-queue CTA', () => {
    const result = deriveWorkEntrySummary([], [], [])

    expect(result.ctaLabel).toBe('Aufgaben öffnen →')
    expect(result.ctaRoute).toBe('/craftsman/jobs?focus=handlungsbedarf')
  })

  // H8. No forbidden system language leaks into card
  it('H8: no forbidden status/system language in entry card output', () => {
    // Test across all major state families
    const scenarios = [
      // Single unassigned
      () => { const j = makeJob({ status: 'booked', assignedMemberIds: [] }); return deriveWorkEntrySummary([j], [], [j]) },
      // Single new request
      () => deriveWorkEntrySummary([makeJob({ status: 'new' })], [], []),
      // In progress
      () => deriveWorkEntrySummary([makeJob({ status: 'in_progress' })], [], []),
      // Coming up
      () => deriveWorkEntrySummary([makeJob({ status: 'booked', assignedMemberIds: ['w1'] })], [], []),
      // Payment waiting
      () => deriveWorkEntrySummary([makeJob({ status: 'waiting_payment' })], [], []),
      // Proposal sent
      () => deriveWorkEntrySummary([makeJob({ status: 'new', proposalSentAt: Date.now() })], [], []),
      // Single dispute
      () => deriveWorkEntrySummary([], [makeDispute()], []),
      // Clean slate
      () => deriveWorkEntrySummary([], [], []),
    ]

    const forbidden = [
      'Anstehender Auftrag',
      'Laufender Auftrag',
      'Auftrag aus Angebot',
      'Alles erledigt',
      'Offener Streitfall',
      'Neue Anfrage',
      'Angebot versendet',
      'Warte auf Freigabe',
    ]

    for (const scenario of scenarios) {
      const result = scenario()
      for (const phrase of forbidden) {
        expect(result.headline).not.toBe(phrase)
      }
    }
  })
})
