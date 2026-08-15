import { describe, it, expect } from 'vitest'
import {
  deriveActionQueue,
  type QuickActionType,
  type QuickActionId,
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

describe('Queue Direct Actions', () => {
  // ── J.1. Assignment direct flow ────────────────────────────────────────

  describe('J.1 — assignment direct flow', () => {
    it('unassigned booked job has direct assign_worker primary action', () => {
      const job = makeJob({ id: 'j-unassigned', status: 'booked', assignedMemberIds: [] })
      const result = deriveActionQueue([job], [], [job])
      const item = result.needsAction[0]

      expect(item.primaryAction).not.toBeNull()
      expect(item.primaryAction!.id).toBe('assign_worker')
      expect(item.primaryAction!.label).toBe('Mitarbeiter zuweisen')
      expect(item.primaryAction!.actionType).toBe('direct')
    })

    it('unassigned scheduled job has direct assign_worker primary action', () => {
      const job = makeJob({ id: 'j-sched-unassigned', status: 'scheduled', assignedMemberIds: [] })
      const result = deriveActionQueue([job], [], [job])
      const item = result.needsAction[0]

      expect(item.primaryAction!.id).toBe('assign_worker')
      expect(item.primaryAction!.actionType).toBe('direct')
    })

    it('assignment-needed cards are NOT using generic "open job" as primary', () => {
      const booked = makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] })
      const scheduled = makeJob({ id: 'j2', status: 'scheduled', assignedMemberIds: [] })
      const result = deriveActionQueue([booked, scheduled], [], [booked, scheduled])

      for (const item of result.needsAction) {
        expect(item.primaryAction!.id).not.toBe('open_job')
        expect(item.primaryAction!.label).not.toContain('Auftrag öffnen')
      }
    })
  })

  // ── J.2. Self-take flow ────────────────────────────────────────────────

  describe('J.2 — self-take flow', () => {
    it('unassigned booked job has direct take_job secondary action', () => {
      const job = makeJob({ id: 'j-unassigned', status: 'booked', assignedMemberIds: [] })
      const result = deriveActionQueue([job], [], [job])
      const item = result.needsAction[0]

      expect(item.secondaryAction).not.toBeNull()
      expect(item.secondaryAction!.id).toBe('take_job')
      expect(item.secondaryAction!.label).toBe('Selbst übernehmen')
      expect(item.secondaryAction!.actionType).toBe('direct')
    })

    it('unassigned scheduled job also has take_job secondary', () => {
      const job = makeJob({ id: 'j-s', status: 'scheduled', assignedMemberIds: [] })
      const result = deriveActionQueue([job], [], [job])
      expect(result.needsAction[0].secondaryAction!.id).toBe('take_job')
    })
  })

  // ── J.3. No-team-member empty state ────────────────────────────────────

  describe('J.3 — no-team-member empty state', () => {
    it('unassigned job still has assign_worker and take_job even with no team context', () => {
      // The selector does not know about team members — it always offers both actions.
      // The QueueAssignmentPanel handles empty team state.
      const job = makeJob({ id: 'j-no-team', status: 'booked', assignedMemberIds: [] })
      const result = deriveActionQueue([job], [], [job])
      const item = result.needsAction[0]

      expect(item.primaryAction!.id).toBe('assign_worker')
      expect(item.secondaryAction!.id).toBe('take_job')
    })
  })

  // ── J.4. Appointment direct flow ───────────────────────────────────────

  describe('J.4 — appointment direct flow', () => {
    it('assigned booked job has direct plan_appointment primary action', () => {
      const job = makeJob({ id: 'j-assigned', status: 'booked', assignedMemberIds: ['w1'] })
      const result = deriveActionQueue([job], [], [])
      const item = result.comingUp[0]

      expect(item.primaryAction).not.toBeNull()
      expect(item.primaryAction!.id).toBe('plan_appointment')
      expect(item.primaryAction!.label).toBe('Termin planen')
      expect(item.primaryAction!.actionType).toBe('direct')
    })

    it('appointment action uses imperative wording, not navigation wording', () => {
      const job = makeJob({ id: 'j-booked', status: 'booked', assignedMemberIds: ['w1'] })
      const result = deriveActionQueue([job], [], [])
      const item = result.comingUp[0]

      expect(item.primaryAction!.label).not.toContain('öffnen')
      expect(item.primaryAction!.label).not.toContain('ansehen')
    })

    it('appointment-needed card has no secondary action (compact)', () => {
      const job = makeJob({ id: 'j-b', status: 'booked', assignedMemberIds: ['w1'] })
      const result = deriveActionQueue([job], [], [])
      expect(result.comingUp[0].secondaryAction).toBeNull()
    })
  })

  // ── J.5. Payment waiting remains non-direct ────────────────────────────

  describe('J.5 — payment waiting remains non-direct', () => {
    it('waiting_payment uses contextual view_payment, not direct action', () => {
      const job = makeJob({ id: 'j-wp', status: 'waiting_payment' })
      const result = deriveActionQueue([job], [], [])
      const item = result.waiting[0]

      expect(item.primaryAction!.id).toBe('view_payment')
      expect(item.primaryAction!.actionType).toBe('contextual')
      expect(item.primaryAction!.label).toBe('Zahlung ansehen')
    })

    it('waiting_payment is in waiting group, not needs_action', () => {
      const job = makeJob({ id: 'j-wp2', status: 'waiting_payment' })
      const result = deriveActionQueue([job], [], [])

      expect(result.waiting).toHaveLength(1)
      expect(result.needsAction).toHaveLength(0)
    })

    it('waiting_payment next step indicates customer responsibility', () => {
      const job = makeJob({ id: 'j-wp3', status: 'waiting_payment' })
      const result = deriveActionQueue([job], [], [])
      expect(result.waiting[0].nextStepLabel).toContain('Kunde')
    })
  })

  // ── J.6. Dispute remains contextual ────────────────────────────────────

  describe('J.6 — dispute remains contextual', () => {
    it('dispute uses contextual open_dispute, not direct action', () => {
      const job = makeJob({ id: 'j-dispute', status: 'in_progress' })
      const dispute = makeDispute({ jobId: 'j-dispute', status: 'open' })
      const result = deriveActionQueue([job], [dispute], [])
      const item = result.needsAction[0]

      expect(item.primaryAction!.id).toBe('open_dispute')
      expect(item.primaryAction!.actionType).toBe('contextual')
      expect(item.primaryAction!.label).toBe('Streitfall ansehen')
    })

    it('under_review dispute also triggers contextual handling', () => {
      const job = makeJob({ id: 'j-ur', status: 'booked', assignedMemberIds: ['w1'] })
      const dispute = makeDispute({ jobId: 'j-ur', status: 'under_review' })
      const result = deriveActionQueue([job], [dispute], [])

      expect(result.needsAction).toHaveLength(1)
      expect(result.needsAction[0].primaryAction!.id).toBe('open_dispute')
    })

    it('dispute overlay overrides normal status-based action', () => {
      // Even a job that would normally be direct (assignment needed)
      // gets contextual dispute handling when a dispute exists
      const job = makeJob({ id: 'j-d', status: 'booked', assignedMemberIds: [] })
      const dispute = makeDispute({ jobId: 'j-d', status: 'open' })
      const result = deriveActionQueue([job], [dispute], [job])

      expect(result.needsAction[0].primaryAction!.id).toBe('open_dispute')
      expect(result.needsAction[0].primaryAction!.actionType).toBe('contextual')
      expect(result.needsAction[0].hasDispute).toBe(true)
    })
  })

  // ── J.7. New request / offer sent semantics ────────────────────────────

  describe('J.7 — new request / offer sent truthfulness', () => {
    it('new request uses contextual open_request', () => {
      const job = makeJob({ id: 'j-new', status: 'new' })
      const result = deriveActionQueue([job], [], [])
      const item = result.needsAction[0]

      expect(item.primaryAction!.id).toBe('open_request')
      expect(item.primaryAction!.actionType).toBe('contextual')
      expect(item.primaryAction!.label).toBe('Anfrage öffnen')
    })

    it('offer sent uses contextual view_proposal', () => {
      const job = makeJob({ id: 'j-prop', status: 'new', proposalSentAt: Date.now() })
      const result = deriveActionQueue([job], [], [])
      const item = result.waiting[0]

      expect(item.primaryAction!.id).toBe('view_proposal')
      expect(item.primaryAction!.actionType).toBe('contextual')
      expect(item.primaryAction!.label).toBe('Angebot ansehen')
    })

    it('offer sent is in waiting group (passive)', () => {
      const job = makeJob({ id: 'j-p2', status: 'new', proposalSentAt: Date.now() })
      const result = deriveActionQueue([job], [], [])
      expect(result.waiting).toHaveLength(1)
      expect(result.needsAction).toHaveLength(0)
    })

    it('new request without proposal is in needs_action', () => {
      const job = makeJob({ id: 'j-nr', status: 'new' })
      const result = deriveActionQueue([job], [], [])
      expect(result.needsAction).toHaveLength(1)
      expect(result.waiting).toHaveLength(0)
    })
  })

  // ── J.8. Direct-action success updates queue state ─────────────────────

  describe('J.8 — direct-action success updates queue state', () => {
    it('assignment removes job from needs_action and moves to coming_up', () => {
      const job = makeJob({ id: 'j-assign', status: 'booked', assignedMemberIds: [] })

      const before = deriveActionQueue([job], [], [job])
      expect(before.needsAction).toHaveLength(1)
      expect(before.needsAction[0].primaryAction!.id).toBe('assign_worker')

      // Simulate successful assignment
      const updatedJob: Job = { ...job, assignedMemberIds: ['tm-1'] }
      const after = deriveActionQueue([updatedJob], [], [])

      expect(after.needsAction).toHaveLength(0)
      expect(after.comingUp).toHaveLength(1)
      expect(after.comingUp[0].primaryAction!.id).toBe('plan_appointment')
    })

    it('scheduling advances booked→scheduled with updated action', () => {
      const job = makeJob({ id: 'j-sched', status: 'booked', assignedMemberIds: ['w1'] })

      const before = deriveActionQueue([job], [], [])
      expect(before.comingUp[0].primaryAction!.id).toBe('plan_appointment')

      // Simulate status change to scheduled
      const scheduledJob: Job = { ...job, status: 'scheduled' }
      const after = deriveActionQueue([scheduledJob], [], [])

      expect(after.comingUp).toHaveLength(1)
      expect(after.comingUp[0].primaryAction!.id).toBe('view_schedule')
      expect(after.comingUp[0].primaryAction!.actionType).toBe('contextual')
    })
  })

  // ── J.9. Direct-action failure does not leave false completed state ────

  describe('J.9 — failure does not leave false completed state', () => {
    it('failed assignment does not change queue state', () => {
      const job = makeJob({ id: 'j-fail', status: 'booked', assignedMemberIds: [] })

      const before = deriveActionQueue([job], [], [job])
      expect(before.needsAction).toHaveLength(1)

      // Simulate failure: job state unchanged
      const after = deriveActionQueue([job], [], [job])
      expect(after.needsAction).toHaveLength(1)
      expect(after.needsAction[0].primaryAction!.id).toBe('assign_worker')
    })

    it('failed scheduling keeps plan_appointment action available', () => {
      const job = makeJob({ id: 'j-fail-sched', status: 'booked', assignedMemberIds: ['w1'] })

      const before = deriveActionQueue([job], [], [])
      expect(before.comingUp[0].primaryAction!.id).toBe('plan_appointment')

      // Simulate failure: job state unchanged
      const after = deriveActionQueue([job], [], [])
      expect(after.comingUp[0].primaryAction!.id).toBe('plan_appointment')
      expect(after.comingUp[0].primaryAction!.actionType).toBe('direct')
    })

    it('pure function produces identical output for identical input', () => {
      const job = makeJob({ id: 'j-pure', status: 'booked', assignedMemberIds: [] })
      const a = deriveActionQueue([job], [], [job])
      const b = deriveActionQueue([job], [], [job])

      expect(a.needsAction[0].primaryAction!.id).toBe(b.needsAction[0].primaryAction!.id)
      expect(a.needsAction[0].group).toBe(b.needsAction[0].group)
    })
  })

  // ── J.10. Only one action panel can be active at a time ────────────────

  describe('J.10 — single active panel constraint', () => {
    it('at most one card has a direct action panel open at a time', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] }),
        makeJob({ id: 'j2', status: 'booked', assignedMemberIds: [] }),
        makeJob({ id: 'j3', status: 'booked', assignedMemberIds: ['w1'] }),
      ]
      const result = deriveActionQueue(jobs, [], [jobs[0], jobs[1]])

      // All three cards have direct actions available
      expect(result.needsAction[0].primaryAction!.actionType).toBe('direct')
      expect(result.needsAction[1].primaryAction!.actionType).toBe('direct')
      expect(result.comingUp[0].primaryAction!.actionType).toBe('direct')

      // Simulate single-expand state (same logic as CraftsmanActionQueueScreen)
      let expandedCardId: string | null = null
      const toggle = (jobId: string) => {
        expandedCardId = expandedCardId === jobId ? null : jobId
      }

      // Expand first
      toggle(result.needsAction[0].job.id)
      expect(expandedCardId).toBe(result.needsAction[0].job.id)

      // Expand second replaces first
      toggle(result.needsAction[1].job.id)
      expect(expandedCardId).toBe(result.needsAction[1].job.id)
      expect(expandedCardId).not.toBe(result.needsAction[0].job.id)

      // Toggle same card closes it
      toggle(result.needsAction[1].job.id)
      expect(expandedCardId).toBeNull()
    })
  })

  // ── J.11. Every queue action type is truthfully classified ─────────────

  describe('J.11 — exhaustive action type classification', () => {
    it('classifies all action IDs correctly across all state families', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'new' }),                                     // open_request: contextual
        makeJob({ id: 'j2', status: 'new', proposalSentAt: Date.now() }),          // view_proposal: contextual
        makeJob({ id: 'j3', status: 'booked', assignedMemberIds: [] }),            // assign_worker: direct
        makeJob({ id: 'j4', status: 'booked', assignedMemberIds: ['w1'] }),        // plan_appointment: direct
        makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: [] }),         // assign_worker: direct
        makeJob({ id: 'j6', status: 'scheduled', assignedMemberIds: ['w1'] }),     // view_schedule: contextual
        makeJob({ id: 'j7', status: 'in_progress' }),                              // open_job: contextual
        makeJob({ id: 'j8', status: 'waiting_payment' }),                          // view_payment: contextual
      ]
      const dispute = makeDispute({ jobId: 'j7', status: 'open' })
      const unassigned = [jobs[2], jobs[4]]

      const result = deriveActionQueue(jobs, [dispute], unassigned)
      const allItems = [
        ...result.needsAction,
        ...result.inProgress,
        ...result.waiting,
        ...result.comingUp,
      ]

      // Complete map of all valid action IDs → their expected classification
      const expectedClassification: Record<QuickActionId, QuickActionType> = {
        assign_worker: 'direct',
        take_job: 'direct',
        plan_appointment: 'direct',
        open_dispute: 'contextual',
        open_request: 'contextual',
        open_job: 'contextual',
        view_proposal: 'contextual',
        view_payment: 'contextual',
        view_schedule: 'contextual',
      }

      for (const item of allItems) {
        if (item.primaryAction) {
          expect(item.primaryAction.actionType).toBe(expectedClassification[item.primaryAction.id])
        }
        if (item.secondaryAction) {
          expect(item.secondaryAction.actionType).toBe(expectedClassification[item.secondaryAction.id])
        }
      }
    })

    it('contextual actions always use honest navigation wording', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'new' }),
        makeJob({ id: 'j2', status: 'new', proposalSentAt: Date.now() }),
        makeJob({ id: 'j3', status: 'in_progress' }),
        makeJob({ id: 'j4', status: 'waiting_payment' }),
        makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: ['w1'] }),
      ]
      const result = deriveActionQueue(jobs, [], [])
      const allItems = [
        ...result.needsAction,
        ...result.inProgress,
        ...result.waiting,
        ...result.comingUp,
      ]

      for (const item of allItems) {
        if (item.primaryAction?.actionType === 'contextual') {
          expect(
            item.primaryAction.label.match(/öffnen|ansehen|prüfen/),
            `Contextual action "${item.primaryAction.label}" must use öffnen/ansehen/prüfen`,
          ).toBeTruthy()
        }
      }
    })

    it('direct actions never use navigation wording', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'booked', assignedMemberIds: [] }),
        makeJob({ id: 'j2', status: 'booked', assignedMemberIds: ['w1'] }),
        makeJob({ id: 'j3', status: 'scheduled', assignedMemberIds: [] }),
      ]
      const unassigned = [jobs[0], jobs[2]]
      const result = deriveActionQueue(jobs, [], unassigned)
      const allItems = [...result.needsAction, ...result.comingUp]

      for (const item of allItems) {
        if (item.primaryAction?.actionType === 'direct') {
          expect(item.primaryAction.label).not.toContain('öffnen')
          expect(item.primaryAction.label).not.toContain('ansehen')
          expect(item.primaryAction.label).not.toMatch(/^Details/)
        }
      }
    })

    it('every known state produces a non-null primaryAction', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'new' }),
        makeJob({ id: 'j2', status: 'new', proposalSentAt: Date.now() }),
        makeJob({ id: 'j3', status: 'booked', assignedMemberIds: [] }),
        makeJob({ id: 'j4', status: 'booked', assignedMemberIds: ['w1'] }),
        makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: [] }),
        makeJob({ id: 'j6', status: 'scheduled', assignedMemberIds: ['w1'] }),
        makeJob({ id: 'j7', status: 'in_progress' }),
        makeJob({ id: 'j8', status: 'waiting_payment' }),
      ]
      const unassigned = [jobs[2], jobs[4]]
      const result = deriveActionQueue(jobs, [], unassigned)
      const allItems = [
        ...result.needsAction,
        ...result.inProgress,
        ...result.waiting,
        ...result.comingUp,
      ]

      for (const item of allItems) {
        expect(item.primaryAction).not.toBeNull()
        expect(item.primaryAction!.id).toBeTruthy()
        expect(item.primaryAction!.label).toBeTruthy()
      }
    })
  })

  // ── J.12. Unknown/fallback states still behave safely ──────────────────

  describe('J.12 — unknown/fallback states behave safely', () => {
    it('fallback state gets contextual open_job with honest label', () => {
      // Simulate an unknown status by casting (e.g. future status values)
      const job = makeJob({ id: 'j-unknown', status: 'some_future_status' as Job['status'] })
      const result = deriveActionQueue([job], [], [])

      expect(result.waiting).toHaveLength(1)
      const item = result.waiting[0]

      expect(item.primaryAction).not.toBeNull()
      expect(item.primaryAction!.id).toBe('open_job')
      expect(item.primaryAction!.label).toBe('Auftrag öffnen')
      expect(item.primaryAction!.actionType).toBe('contextual')
    })

    it('fallback state has honest next step label', () => {
      const job = makeJob({ id: 'j-fb', status: 'unknown_state' as Job['status'] })
      const result = deriveActionQueue([job], [], [])
      const item = result.waiting[0]

      expect(item.nextStepLabel).toBe('Auftrag prüfen')
    })

    it('fallback state lands in waiting group (safe, non-urgent)', () => {
      const job = makeJob({ id: 'j-fb2', status: 'mystery' as Job['status'] })
      const result = deriveActionQueue([job], [], [])

      expect(result.waiting).toHaveLength(1)
      expect(result.needsAction).toHaveLength(0)
    })
  })

  // ── Card UX contract ───────────────────────────────────────────────────

  describe('card UX contract', () => {
    it('every card answers: job, phase, next step, action', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'new', title: 'Kitchen' }),
        makeJob({ id: 'j2', status: 'in_progress', title: 'Bath' }),
        makeJob({ id: 'j3', status: 'booked', assignedMemberIds: [], title: 'Wiring' }),
        makeJob({ id: 'j4', status: 'waiting_payment', title: 'Heating' }),
        makeJob({ id: 'j5', status: 'scheduled', assignedMemberIds: ['w1'], title: 'Painting' }),
      ]
      const result = deriveActionQueue(jobs, [], [jobs[2]])
      const allItems = [
        ...result.needsAction,
        ...result.inProgress,
        ...result.waiting,
        ...result.comingUp,
      ]

      for (const item of allItems) {
        // 1. What job is this?
        expect(item.job.title).toBeTruthy()
        // 2. Why is it in this queue?
        expect(item.phaseLabel).toBeTruthy()
        // 3. What should happen next?
        expect(item.nextStepLabel).toBeTruthy()
        // 4. What can I do right now?
        expect(item.primaryAction).not.toBeNull()
        // Structure integrity
        expect(typeof item.hasDispute).toBe('boolean')
        expect(item.group).toMatch(/^(needs_action|in_progress|waiting|coming_up)$/)
      }
    })

    it('max 1 primary + 1 secondary action per card', () => {
      const jobs = [
        makeJob({ id: 'j1', status: 'new' }),
        makeJob({ id: 'j2', status: 'booked', assignedMemberIds: [] }),
        makeJob({ id: 'j3', status: 'in_progress' }),
        makeJob({ id: 'j4', status: 'waiting_payment' }),
      ]
      const result = deriveActionQueue(jobs, [], [jobs[1]])
      const allItems = [
        ...result.needsAction,
        ...result.inProgress,
        ...result.waiting,
      ]

      for (const item of allItems) {
        // Each item has exactly 0 or 1 primary and 0 or 1 secondary
        if (item.primaryAction) {
          expect(item.primaryAction.id).toBeTruthy()
          expect(item.primaryAction.label).toBeTruthy()
          expect(item.primaryAction.actionType).toMatch(/^(direct|contextual)$/)
        }
        if (item.secondaryAction) {
          expect(item.secondaryAction.id).toBeTruthy()
          expect(item.secondaryAction.actionType).toBe('direct')
        }
      }
    })
  })
})
