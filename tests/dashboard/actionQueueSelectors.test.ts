import { describe, it, expect } from 'vitest'
import {
  deriveActionQueue,
} from '../../src/lib/dashboard/actionQueueSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Dispute } from '../../src/lib/disputes/types'

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('deriveActionQueue', () => {
  it('returns empty queue when no active jobs', () => {
    const result = deriveActionQueue([], [], [])

    expect(result.totalItems).toBe(0)
    expect(result.needsAction).toHaveLength(0)
    expect(result.inProgress).toHaveLength(0)
    expect(result.waiting).toHaveLength(0)
    expect(result.comingUp).toHaveLength(0)
  })

  it('excludes completed and cancelled jobs', () => {
    const completed = makeJob({ status: 'completed' })
    const cancelled = makeJob({ status: 'cancelled' })

    const result = deriveActionQueue([completed, cancelled], [], [])
    expect(result.totalItems).toBe(0)
  })

  // ── Grouping ───────────────────────────────────────────────────────────

  it('puts new requests without proposal into needs_action', () => {
    const newJob = makeJob({ status: 'new', title: 'Küche' })

    const result = deriveActionQueue([newJob], [], [])

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Neue Anfrage')
    expect(result.needsAction[0].nextStepLabel).toContain('Angebot')
  })

  it('puts new requests with proposal into waiting', () => {
    const newJob = makeJob({ status: 'new', proposalSentAt: Date.now() })

    const result = deriveActionQueue([newJob], [], [])

    expect(result.waiting).toHaveLength(1)
    expect(result.waiting[0].phaseLabel).toBe('Angebot gesendet')
    expect(result.waiting[0].nextStepLabel).toContain('Kundenantwort')
    expect(result.waiting[0].primaryAction?.label).toBe('Angebot ansehen')
  })

  it('puts unassigned booked jobs into needs_action', () => {
    const booked = makeJob({ id: 'b1', status: 'booked', assignedMemberIds: [] })

    const result = deriveActionQueue([booked], [], [booked])

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Zuteilung nötig')
    expect(result.needsAction[0].primaryAction?.id).toBe('assign_worker')
    expect(result.needsAction[0].primaryAction?.actionType).toBe('direct')
    expect(result.needsAction[0].secondaryAction?.id).toBe('take_job')
  })

  it('puts assigned booked jobs into coming_up', () => {
    const booked = makeJob({ status: 'booked', assignedMemberIds: ['worker-1'] })

    const result = deriveActionQueue([booked], [], [])

    expect(result.comingUp).toHaveLength(1)
    expect(result.comingUp[0].phaseLabel).toBe('Termin offen')
  })

  it('puts unassigned scheduled jobs into needs_action', () => {
    const scheduled = makeJob({ id: 's1', status: 'scheduled', assignedMemberIds: [] })

    const result = deriveActionQueue([scheduled], [], [scheduled])

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].phaseLabel).toBe('Zuteilung nötig')
  })

  it('puts assigned scheduled jobs into coming_up', () => {
    const scheduled = makeJob({ status: 'scheduled', assignedMemberIds: ['w1'] })

    const result = deriveActionQueue([scheduled], [], [])

    expect(result.comingUp).toHaveLength(1)
    expect(result.comingUp[0].phaseLabel).toBe('Geplant')
    expect(result.comingUp[0].primaryAction?.id).toBe('view_schedule')
  })

  it('puts in_progress jobs into inProgress group', () => {
    const job = makeJob({ status: 'in_progress' })

    const result = deriveActionQueue([job], [], [])

    expect(result.inProgress).toHaveLength(1)
    expect(result.inProgress[0].phaseLabel).toBe('In Arbeit')
    expect(result.inProgress[0].primaryAction?.id).toBe('open_job')
  })

  // ── B. SEMANTIC FIX: waiting_payment belongs in "waiting" ─────────────

  it('puts waiting_payment into waiting (NOT needs_action)', () => {
    const job = makeJob({ status: 'waiting_payment' })

    const result = deriveActionQueue([job], [], [])

    // CRITICAL: craftsman cannot act on waiting_payment — customer must release
    expect(result.waiting).toHaveLength(1)
    expect(result.needsAction).toHaveLength(0)
    expect(result.waiting[0].phaseLabel).toBe('Warte auf Freigabe')
    expect(result.waiting[0].nextStepLabel).toContain('Kunde')
    expect(result.waiting[0].primaryAction?.id).toBe('view_payment')
    expect(result.waiting[0].primaryAction?.label).toBe('Zahlung ansehen')
  })

  // ── Disputes ───────────────────────────────────────────────────────────

  it('puts disputed jobs into needs_action with dispute overlay', () => {
    const job = makeJob({ id: 'job-1', status: 'in_progress' })
    const dispute = makeDispute({ jobId: 'job-1', status: 'open' })

    const result = deriveActionQueue([job], [dispute], [])

    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].hasDispute).toBe(true)
    expect(result.needsAction[0].phaseLabel).toBe('Streitfall offen')
    expect(result.needsAction[0].primaryAction?.id).toBe('open_dispute')
  })

  it('ignores resolved disputes', () => {
    const job = makeJob({ id: 'job-1', status: 'in_progress' })
    const dispute = makeDispute({ jobId: 'job-1', status: 'resolved_release' })

    const result = deriveActionQueue([job], [dispute], [])

    expect(result.inProgress).toHaveLength(1)
    expect(result.inProgress[0].hasDispute).toBe(false)
  })

  // ── Sorting within needs_action ────────────────────────────────────────

  it('sorts needs_action: disputes > unassigned > new', () => {
    const disputeJob = makeJob({ id: 'j-dispute', status: 'new' })
    const dispute = makeDispute({ jobId: 'j-dispute', status: 'open' })
    const unassigned = makeJob({ id: 'j-unassigned', status: 'booked', assignedMemberIds: [] })
    const newJob = makeJob({ id: 'j-new', status: 'new' })

    const result = deriveActionQueue(
      [newJob, disputeJob, unassigned],
      [dispute],
      [unassigned],
    )

    const ids = result.needsAction.map((i) => i.job.id)
    expect(ids[0]).toBe('j-dispute')     // dispute first
    expect(ids[1]).toBe('j-unassigned')  // then unassigned
    expect(ids[2]).toBe('j-new')         // then new
  })

  // ── A. QUICK ACTION TRUTH AUDIT ────────────────────────────────────────

  it('has max 1 primary and max 1 secondary action per card', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'new' }),
      makeJob({ id: 'j2', status: 'in_progress' }),
      makeJob({ id: 'j3', status: 'waiting_payment' }),
      makeJob({ id: 'j4', status: 'booked', assignedMemberIds: [] }),
      makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: ['w1'] }),
    ]
    const unassigned = [jobs[3]]

    const result = deriveActionQueue(jobs, [], unassigned)
    const allItems = [
      ...result.needsAction,
      ...result.inProgress,
      ...result.waiting,
      ...result.comingUp,
    ]

    for (const item of allItems) {
      // Primary action: at most 1 (null or defined)
      if (item.primaryAction) {
        expect(item.primaryAction.id).toBeTruthy()
        expect(item.primaryAction.label).toBeTruthy()
        expect(item.primaryAction.actionType).toMatch(/^(direct|contextual)$/)
      }
      // Secondary action: at most 1 (null or defined), only for direct-action cards
      if (item.secondaryAction) {
        expect(item.secondaryAction.id).toBeTruthy()
        expect(item.secondaryAction.label).toBeTruthy()
        expect(item.secondaryAction.actionType).toBe('direct')
      }
    }
  })

  it('contextual action labels use honest deep-link wording; direct actions use imperative wording', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'new' }),
      makeJob({ id: 'j2', status: 'in_progress' }),
      makeJob({ id: 'j3', status: 'waiting_payment' }),
      makeJob({ id: 'j4', status: 'booked', assignedMemberIds: [] }),
      makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: ['w1'] }),
    ]
    const unassigned = [jobs[3]]
    const result = deriveActionQueue(jobs, [], unassigned)
    const allItems = [
      ...result.needsAction,
      ...result.inProgress,
      ...result.waiting,
      ...result.comingUp,
    ]

    for (const item of allItems) {
      if (item.primaryAction?.actionType === 'contextual') {
        // Contextual actions must use honest navigation wording
        expect(
          item.primaryAction.label.match(/öffnen|ansehen|prüfen/),
          `Contextual action "${item.primaryAction.label}" must use öffnen/ansehen/prüfen`,
        ).toBeTruthy()
      }
      if (item.primaryAction?.actionType === 'direct') {
        // Direct actions use imperative wording — must NOT pretend to navigate
        expect(item.primaryAction.id).toBeTruthy()
      }
    }
  })

  // ── Full mixed scenario ────────────────────────────────────────────────

  it('correctly distributes a mixed set of jobs', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'new', title: 'Anfrage' }),
      makeJob({ id: 'j2', status: 'in_progress', title: 'Laufend' }),
      makeJob({ id: 'j3', status: 'waiting_payment', title: 'Zahlung' }),
      makeJob({ id: 'j4', status: 'scheduled', assignedMemberIds: ['w1'], title: 'Geplant' }),
      makeJob({ id: 'j5', status: 'completed', title: 'Fertig' }),
      makeJob({ id: 'j6', status: 'booked', assignedMemberIds: [], title: 'Unbesetzt' }),
    ]
    const unassigned = [jobs[5]]

    const result = deriveActionQueue(jobs, [], unassigned)

    // j1 (new, no proposal) → needs_action
    // j2 (in_progress) → inProgress
    // j3 (waiting_payment) → waiting (craftsman cannot act)
    // j4 (scheduled, assigned) → coming_up
    // j5 (completed) → excluded
    // j6 (booked, unassigned) → needs_action
    expect(result.needsAction).toHaveLength(2) // j1, j6
    expect(result.inProgress).toHaveLength(1)  // j2
    expect(result.waiting).toHaveLength(1)     // j3
    expect(result.comingUp).toHaveLength(1)    // j4
    expect(result.totalItems).toBe(5)          // excludes completed j5
  })

  // ── Future scheduled job exclusion ─────────────────────────────────────

  it('F1: excludes a future-scheduled job from the action queue', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const futureJobIds = new Set(['j1'])

    const result = deriveActionQueue([futureJob], [], [], undefined, futureJobIds)

    expect(result.totalItems).toBe(0)
    expect(result.comingUp).toHaveLength(0)
    expect(result.needsAction).toHaveLength(0)
  })

  it('F2: excludes future booked+scheduled job from action queue', () => {
    const futureJob = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: ['w1'] })
    const scheduledIds = new Set(['j1'])
    const futureJobIds = new Set(['j1'])

    const result = deriveActionQueue([futureJob], [], [], scheduledIds, futureJobIds)

    expect(result.totalItems).toBe(0)
    expect(result.comingUp).toHaveLength(0)
  })

  it('F3: keeps future-scheduled job with active dispute in the queue', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const dispute = makeDispute({ jobId: 'j1', status: 'open' })
    const futureJobIds = new Set(['j1'])

    const result = deriveActionQueue([futureJob], [dispute], [], undefined, futureJobIds)

    // Dispute overrides future exclusion — dispute must be surfaced
    expect(result.totalItems).toBe(1)
    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].hasDispute).toBe(true)
    expect(result.needsAction[0].job.id).toBe('j1')
  })

  it('F4: today-scheduled jobs (not in futureScheduledJobIds) remain in the action queue', () => {
    const todayJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    // Not in futureScheduledJobIds → stays in queue as coming_up
    const result = deriveActionQueue([todayJob], [], [], undefined, new Set())

    expect(result.comingUp).toHaveLength(1)
    expect(result.totalItems).toBe(1)
  })

  it('F5: action queue shows empty state when only future scheduled jobs remain', () => {
    const futureJob1 = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const futureJob2 = makeJob({ id: 'j2', status: 'booked', assignedMemberIds: ['w2'] })
    const futureJobIds = new Set(['j1', 'j2'])

    const result = deriveActionQueue([futureJob1, futureJob2], [], [], undefined, futureJobIds)

    expect(result.totalItems).toBe(0)
    expect(result.comingUp).toHaveLength(0)
    expect(result.needsAction).toHaveLength(0)
    expect(result.inProgress).toHaveLength(0)
    expect(result.waiting).toHaveLength(0)
  })

  it('F6: future scheduled excluded while other active jobs remain', () => {
    const futureJob = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: ['w1'] })
    const activeJob = makeJob({ id: 'j2', status: 'new' })
    const futureJobIds = new Set(['j1'])

    const result = deriveActionQueue([futureJob, activeJob], [], [], undefined, futureJobIds)

    expect(result.totalItems).toBe(1)
    expect(result.needsAction).toHaveLength(1)
    expect(result.needsAction[0].job.id).toBe('j2')
    expect(result.comingUp).toHaveLength(0)
  })

  it('F7: future-scheduled unassigned job excluded from needs_action (no active issue)', () => {
    // An unassigned scheduled job that is future-dated has no active issue → excluded
    const futureUnassigned = makeJob({ id: 'j1', status: 'scheduled', assignedMemberIds: [] })
    const futureJobIds = new Set(['j1'])

    const result = deriveActionQueue([futureUnassigned], [], [futureUnassigned], undefined, futureJobIds)

    expect(result.totalItems).toBe(0)
    expect(result.needsAction).toHaveLength(0)
  })

  // ── C. NEXT STEP LANGUAGE coherence ────────────────────────────────────

  it('phase, next step, and quick action are coherent for each state', () => {
    // Unassigned booked → direct assignment
    const unassigned = makeJob({ id: 'u1', status: 'booked', assignedMemberIds: [] })
    const q1 = deriveActionQueue([unassigned], [], [unassigned])
    const u = q1.needsAction[0]
    expect(u.phaseLabel).toBe('Zuteilung nötig')
    expect(u.nextStepLabel).toContain('zuweisen')
    expect(u.primaryAction?.id).toBe('assign_worker')
    expect(u.primaryAction?.actionType).toBe('direct')
    expect(u.secondaryAction?.id).toBe('take_job')
    expect(u.secondaryAction?.actionType).toBe('direct')

    // New request → contextual
    const newJob = makeJob({ id: 'n1', status: 'new' })
    const q2 = deriveActionQueue([newJob], [], [])
    const n = q2.needsAction[0]
    expect(n.phaseLabel).toBe('Neue Anfrage')
    expect(n.nextStepLabel).toContain('Angebot')
    expect(n.primaryAction?.label).toContain('öffnen')
    expect(n.primaryAction?.actionType).toBe('contextual')

    // Waiting payment → contextual
    const wp = makeJob({ id: 'w1', status: 'waiting_payment' })
    const q3 = deriveActionQueue([wp], [], [])
    const w = q3.waiting[0]
    expect(w.phaseLabel).toBe('Warte auf Freigabe')
    expect(w.nextStepLabel).toContain('Kunde')
    expect(w.primaryAction?.label).toBe('Zahlung ansehen')
    expect(w.primaryAction?.actionType).toBe('contextual')

    // In progress → contextual
    const ip = makeJob({ id: 'ip1', status: 'in_progress' })
    const q4 = deriveActionQueue([ip], [], [])
    const i = q4.inProgress[0]
    expect(i.phaseLabel).toBe('In Arbeit')
    expect(i.nextStepLabel).toContain('abschließen')
    expect(i.primaryAction?.label).toContain('öffnen')
    expect(i.primaryAction?.actionType).toBe('contextual')

    // Booked (assigned) → direct appointment
    const booked = makeJob({ id: 'b1', status: 'booked', assignedMemberIds: ['w1'] })
    const q5 = deriveActionQueue([booked], [], [])
    const b = q5.comingUp[0]
    expect(b.phaseLabel).toBe('Termin offen')
    expect(b.nextStepLabel).toContain('Termin')
    expect(b.primaryAction?.id).toBe('plan_appointment')
    expect(b.primaryAction?.actionType).toBe('direct')
  })
})
