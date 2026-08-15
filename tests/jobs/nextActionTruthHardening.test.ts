/**
 * Block 7 / Sub-block 7.1 — Core Next-Action Truth Hardening
 *
 * Tests the three hardened truth areas:
 *   A. Funding-In-Progress States
 *   B. Schedule Readiness as real Action / Blocker
 *   C. Payout-Readiness for released jobs
 *   D. Conflict resolution — dispute still wins
 *   E. Regression — existing behaviour unaffected
 */

import { describe, it, expect } from 'vitest'
import { deriveNextAction } from '../../src/lib/jobs/nextActionSelectors'
import { deriveCustomerNextAction } from '../../src/lib/jobs/customerNextActionSelectors'
import { deriveProviderNextAction } from '../../src/lib/jobs/providerNextActionSelectors'
import {
  deriveJobOperationalSummary,
  type OperationalBlockerReason,
} from '../../src/lib/jobs/operationalSummarySelectors'
import type { Job } from '../../src/lib/jobs/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Job fixture. Tests override as needed. */
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Test',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    status: 'new',
    amount: '1.000 €',
    description: 'Test',
    paymentState: undefined,
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'craftsman-1',
    customerUserId: 'customer-1',
    ...overrides,
  } as Job
}

/** Minimal schedule fixture whose end is in the future. */
function makeSchedule(scheduledStart: number, scheduledEnd: number) {
  return {
    id: 'sched-1',
    jobId: 'job-1',
    scheduledStart,
    scheduledEnd,
    schedulingStatus: 'scheduled' as const,
  }
}

const NOW = Date.now()

// ── A. Funding-In-Progress States ─────────────────────────────────────────────

// For funding-in-progress tests use jobStatus='booked' so the proposal-lifecycle
// gate does not interfere. 'booked' has paymentReady=true (jobStatus !== 'new').
describe('A. Funding-In-Progress States — deriveNextAction (craftsman)', () => {
  it('funding_started → "Zahlung wird verarbeitet", not "Zahlung ausstehend"', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_started'
    )
    expect(action.label).toBe('Zahlung wird verarbeitet')
    expect(action.priority).toBe('active')
    expect(action.domain).toBe('payment')
  })

  it('funding_initiated → "Zahlung wird verarbeitet", not "Zahlung ausstehend"', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_initiated'
    )
    expect(action.label).toBe('Zahlung wird verarbeitet')
    expect(action.priority).toBe('active')
  })

  it('funding_created → still "Zahlung ausstehend" (customer has not started yet)', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'created'
    )
    expect(action.label).toBe('Zahlung ausstehend')
  })

  it('funding_sent → still "Zahlung ausstehend"', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'sent'
    )
    expect(action.label).toBe('Zahlung ausstehend')
  })

  it('funded dominance still works correctly after in-progress changes', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funded'
    )
    expect(action.label).toBe('Zahlung abgesichert')
  })

  it('funded dominance: undefined paymentState + funded → Zahlung abgesichert', () => {
    const action = deriveNextAction(
      'booked',
      undefined,
      undefined,
      undefined,
      undefined,
      'funded'
    )
    expect(action.label).toBe('Zahlung abgesichert')
  })
})

describe('A. Funding-In-Progress States — deriveCustomerNextAction', () => {
  it('funding_started → "Zahlung wird verarbeitet" from customer perspective', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_started'
    )
    expect(action.label).toBe('Zahlung wird verarbeitet')
    expect(action.priority).toBe('active')
    expect(action.domain).toBe('payment')
  })

  it('funding_initiated → "Zahlung wird verarbeitet" from customer perspective', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_initiated'
    )
    expect(action.label).toBe('Zahlung wird verarbeitet')
  })

  it('funding_created → still "Zahlung leisten" from customer perspective', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'created'
    )
    expect(action.label).toBe('Zahlung leisten')
  })

  it('funding_created → priority is urgent (Hero CTA must show)', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'created'
    )
    expect(action.priority).toBe('urgent')
    expect(action.domain).toBe('payment')
  })

  it('funding_sent → priority is urgent (Hero CTA must show)', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'sent'
    )
    expect(action.priority).toBe('urgent')
    expect(action.domain).toBe('payment')
  })

  it('funding_started → priority is active (Hero CTA must NOT show while processing)', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_started'
    )
    expect(action.priority).toBe('active')
  })

  it('funding_initiated → priority is active (Hero CTA must NOT show while processing)', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_initiated'
    )
    expect(action.priority).toBe('active')
  })

  it('customer funded dominance still works', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funded'
    )
    expect(action.label).toBe('Zahlung gesichert')
  })
})

// ── B. Schedule Readiness ─────────────────────────────────────────────────────

describe('B. Schedule Readiness — deriveNextAction', () => {
  it('scheduled + overdue → urgent "Termin überfällig"', () => {
    const action = deriveNextAction(
      'scheduled',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'overdue'
    )
    expect(action.label).toBe('Termin überfällig')
    expect(action.priority).toBe('urgent')
    expect(action.domain).toBe('job')
  })

  it('scheduled + starting_soon → active "Termin beginnt bald"', () => {
    const action = deriveNextAction(
      'scheduled',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'starting_soon'
    )
    expect(action.label).toBe('Termin beginnt bald')
    expect(action.priority).toBe('active')
  })

  it('scheduled + upcoming → default "Termin geplant"', () => {
    const action = deriveNextAction(
      'scheduled',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'upcoming'
    )
    expect(action.label).toBe('Termin geplant')
    expect(action.priority).toBe('active')
  })

  it('scheduled + no scheduleReadiness → default "Termin geplant"', () => {
    const action = deriveNextAction('scheduled', undefined, undefined)
    expect(action.label).toBe('Termin geplant')
  })
})

describe('B. Schedule Readiness — deriveJobOperationalSummary blocker', () => {
  it('scheduled + overdue schedule → blocker reason schedule_overdue', () => {
    // Schedule ended 1 hour ago
    const now = NOW
    const schedule = makeSchedule(now - 3 * 60 * 60 * 1000, now - 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: 'scheduled',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.blocker.reason).toBe<OperationalBlockerReason>('schedule_overdue')
    expect(summary.blocker.isBlocking).toBe(true)
    expect(summary.blocker.isDisplayed).toBe(true)
  })

  it('scheduled + overdue schedule → nextAction is urgent "Termin überfällig"', () => {
    const now = NOW
    const schedule = makeSchedule(now - 3 * 60 * 60 * 1000, now - 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: 'scheduled',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.nextAction.label).toBe('Termin überfällig')
    expect(summary.nextAction.priority).toBe('urgent')
  })

  it('scheduled + overdue → requiresCraftsmanAction true', () => {
    const now = NOW
    const schedule = makeSchedule(now - 3 * 60 * 60 * 1000, now - 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: 'scheduled',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.requiresCraftsmanAction).toBe(true)
    expect(summary.requiresCustomerAction).toBe(false)
    expect(summary.requiresAdminAction).toBe(false)
  })

  it('scheduled + upcoming schedule → no schedule_overdue blocker', () => {
    const now = NOW
    const schedule = makeSchedule(now + 2 * 24 * 60 * 60 * 1000, now + 3 * 24 * 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: 'scheduled',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.blocker.reason).not.toBe('schedule_overdue')
  })

  it('in_progress job with overdue schedule → no schedule_overdue blocker (wrong jobStatus)', () => {
    const now = NOW
    const schedule = makeSchedule(now - 3 * 60 * 60 * 1000, now - 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'in_progress',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: 'execution_started',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.blocker.reason).not.toBe('schedule_overdue')
  })
})

// ── C. Payout-Readiness ────────────────────────────────────────────────────────

describe('C. Payout-Readiness — deriveProviderNextAction', () => {
  const releasedJob = makeJob({
    status: 'completed',
    paymentReleasedAt: Date.now() - 1000,
  })

  it('payment_released + payout no_account → complete_payout_setup, enabled', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      'no_account'
    )
    expect(action.actionId).toBe('complete_payout_setup')
    expect(action.enabled).toBe(true)
  })

  it('payment_released + payout onboarding_required → complete_payout_setup', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      'onboarding_required'
    )
    expect(action.actionId).toBe('complete_payout_setup')
    expect(action.enabled).toBe(true)
  })

  it('payment_released + payout onboarding_in_progress → complete_payout_setup', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      'onboarding_in_progress'
    )
    expect(action.actionId).toBe('complete_payout_setup')
  })

  it('payment_released + payout payout_blocked → complete_payout_setup', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      'payout_blocked'
    )
    expect(action.actionId).toBe('complete_payout_setup')
  })

  it('payment_released + payout payout_ready → none (terminal, all good)', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      'payout_ready'
    )
    expect(action.actionId).toBe('none')
  })

  it('payment_released + no payoutReadinessStatus → none (backwards-compatible)', () => {
    const action = deriveProviderNextAction(
      releasedJob,
      'funded',
      'fully_released',
      undefined
    )
    expect(action.actionId).toBe('none')
  })
})

describe('C. Payout-Readiness — deriveNextAction craftsman', () => {
  it('released + payout not ready → active "Auszahlungs-Konto einrichten"', () => {
    const action = deriveNextAction(
      'completed',
      'released',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'onboarding_required'
    )
    expect(action.label).toBe('Auszahlungs-Konto einrichten')
    expect(action.priority).toBe('active')
    expect(action.domain).toBe('payment')
  })

  it('released + payout_blocked → active "Auszahlungs-Konto einrichten"', () => {
    const action = deriveNextAction(
      'completed',
      'released',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'payout_blocked'
    )
    expect(action.label).toBe('Auszahlungs-Konto einrichten')
    expect(action.priority).toBe('active')
  })

  it('released + payout_ready → idle "Zahlung ausgezahlt"', () => {
    const action = deriveNextAction(
      'completed',
      'released',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'payout_ready'
    )
    expect(action.label).toBe('Zahlung ausgezahlt')
    expect(action.priority).toBe('idle')
  })

  it('released + no payoutReadinessStatus → idle "Zahlung ausgezahlt" (backwards-compatible)', () => {
    const action = deriveNextAction('completed', 'released', undefined)
    expect(action.label).toBe('Zahlung ausgezahlt')
    expect(action.priority).toBe('idle')
  })
})

describe('C. Payout-Readiness — operationalSummarySelectors blocker', () => {
  it('released payment + payout blocked → payout_setup_required blocker', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'completed',
      paymentState: 'released',
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
      payoutReadinessStatus: 'payout_blocked',
    })

    expect(summary.blocker.reason).toBe<OperationalBlockerReason>('payout_setup_required')
    expect(summary.blocker.isBlocking).toBe(true)
    expect(summary.blocker.isDisplayed).toBe(true)
  })

  it('released payment + payout no_account → payout_setup_required blocker', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'completed',
      paymentState: 'released',
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
      payoutReadinessStatus: 'no_account',
    })

    expect(summary.blocker.reason).toBe('payout_setup_required')
  })

  it('released payment + payout ready → workflow_complete blocker (not payout_setup_required)', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'completed',
      paymentState: 'released',
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
      payoutReadinessStatus: 'payout_ready',
    })

    expect(summary.blocker.reason).toBe('workflow_complete')
  })

  it('released + payout blocked → requiresCraftsmanAction true', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'completed',
      paymentState: 'released',
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
      payoutReadinessStatus: 'payout_blocked',
    })

    expect(summary.requiresCraftsmanAction).toBe(true)
    expect(summary.requiresCustomerAction).toBe(false)
  })

  it('no payoutReadinessStatus → workflow_complete, no payout blocker (backwards-compatible)', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'completed',
      paymentState: 'released',
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
    })

    expect(summary.blocker.reason).toBe('workflow_complete')
  })
})

// ── D. Conflict Resolution ────────────────────────────────────────────────────

describe('D. Conflict Resolution — dispute overwrites all new cases', () => {
  it('dispute open + schedule overdue → dispute wins in nextAction', () => {
    const action = deriveNextAction(
      'scheduled',
      undefined,
      'open',
      undefined,
      undefined,
      undefined,
      'overdue'
    )
    expect(action.domain).toBe('dispute')
    expect(action.priority).toBe('urgent')
    expect(action.label).toBe('Konflikt offen')
  })

  it('dispute open + funding in progress → dispute wins', () => {
    const action = deriveNextAction(
      'booked',
      'deposit_required',
      'open',
      undefined,
      undefined,
      'funding_started'
    )
    expect(action.domain).toBe('dispute')
  })

  it('dispute open + payout blocked + released → dispute wins', () => {
    const action = deriveNextAction(
      'completed',
      'released',
      'open',
      undefined,
      undefined,
      undefined,
      undefined,
      'payout_blocked'
    )
    expect(action.domain).toBe('dispute')
    expect(action.priority).toBe('urgent')
  })

  it('dispute open + schedule overdue → dispute_open blocker, not schedule_overdue', () => {
    const now = NOW
    const schedule = makeSchedule(now - 3 * 60 * 60 * 1000, now - 60 * 60 * 1000)

    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: 'open',
      schedulingStatus: 'scheduled',
      schedule,
      artifactCount: 0,
      timelineSignals: [],
      nowMs: now,
    })

    expect(summary.blocker.reason).toBe<OperationalBlockerReason>('dispute_open')
    expect(summary.nextAction.domain).toBe('dispute')
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — existing next-action behaviour unaffected', () => {
  it('in_progress job → "In Durchführung"', () => {
    const action = deriveNextAction('in_progress', 'in_escrow', undefined)
    expect(action.label).toBe('In Durchführung')
  })

  it('release_pending → urgent "Freigabe ausstehend"', () => {
    const action = deriveNextAction('waiting_payment', 'release_pending', undefined)
    expect(action.priority).toBe('urgent')
    expect(action.label).toBe('Freigabe ausstehend')
  })

  it('new job without proposal → "Neue Anfrage"', () => {
    const action = deriveNextAction('new', undefined, undefined)
    expect(action.label).toBe('Neue Anfrage')
  })

  it('completed without payoutReadinessStatus → idle "Abgeschlossen"', () => {
    const action = deriveNextAction('completed', undefined, undefined)
    expect(action.label).toBe('Abgeschlossen')
    expect(action.priority).toBe('idle')
  })

  it('provider: work_started → complete_work, enabled', () => {
    const job = makeJob({ status: 'in_progress' })
    const action = deriveProviderNextAction(job, 'funded', 'funded_in_escrow')
    expect(action.actionId).toBe('complete_work')
    expect(action.enabled).toBe(true)
  })

  it('provider: funded_in_escrow → start_work, enabled', () => {
    const job = makeJob({ status: 'new', proposalAcceptedAt: Date.now() - 1000 })
    const action = deriveProviderNextAction(job, 'funded', 'funded_in_escrow')
    expect(action.actionId).toBe('start_work')
    expect(action.enabled).toBe(true)
  })

  it('operational summary without schedule → no schedule_overdue blocker', () => {
    const summary = deriveJobOperationalSummary({
      jobId: 'job-1',
      jobStatus: 'scheduled',
      paymentState: undefined,
      disputeStatus: undefined,
      schedulingStatus: undefined,
      schedule: undefined,
      artifactCount: 0,
      timelineSignals: [],
    })

    expect(summary.blocker.reason).toBe<OperationalBlockerReason>('none')
    expect(summary.needsScheduling).toBe(true)
  })

  it('customer: funding_started → "Zahlung wird verarbeitet" (not original CTA)', () => {
    const action = deriveCustomerNextAction(
      'booked',
      'deposit_required',
      undefined,
      undefined,
      undefined,
      'funding_started'
    )
    expect(action.label).not.toBe('Zahlung leisten')
    expect(action.label).toBe('Zahlung wird verarbeitet')
  })
})
