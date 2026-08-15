import { describe, it, expect } from 'vitest'
import {
  formatAgeHours,
  deriveStuckJobSignals,
  derivePaymentRiskSignals,
  deriveDisputeSignals,
  deriveProviderGapSignals,
  deriveOwnershipGapSignals,
  derivePilotDiagnosticsSummary,
} from '../../src/lib/pilot/pilotDiagnosticsSelectors'
import type { Job } from '../../src/lib/jobs/types'
import type { Payment } from '../../src/lib/payments/types'
import type { Dispute } from '../../src/lib/disputes/types'
import type { ProviderProfile } from '../../src/lib/providers/providerProfileService'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed historical timestamp used for selectors that accept an explicit nowMs.
const NOW = 1_700_000_000_000
const HOUR_MS = 1000 * 60 * 60
const DAY_MS = 24 * HOUR_MS

// Real current time used for selectors that call Date.now() internally
// (derivePaymentRiskSignals, deriveDisputeSignals).
const REAL_NOW = Date.now()

const INTAKE_CONTEXT: Job['intakeContext'] = {
  origin: 'inquiry_reel',
  originLabel: 'Explore-Reel',
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Fliesen verlegen',
    customer: 'Erika Muster',
    location: 'Hamburg',
    dateLabel: 'Heute',
    status: 'new',
    amount: '1.500 €',
    description: 'Bad renovieren',
    paymentState: 'deposit_required',
    documentationStatus: '0 Fotos',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'user-cust-1',
    intakeContext: INTAKE_CONTEXT,
    ...overrides,
  }
}

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'payment-1',
    jobId: 'job-1',
    state: 'in_escrow',
    amounts: { totalAmount: 1500, depositAmount: 300, finalAmount: 1200 },
    createdAt: NOW - 30 * HOUR_MS,
    updatedAt: NOW - 30 * HOUR_MS,
    ...overrides,
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-1',
    jobId: 'job-1',
    status: 'open',
    reason: 'work_quality',
    title: 'Schlechte Arbeit',
    description: 'Das Ergebnis entspricht nicht den Vereinbarungen.',
    createdAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
    ...overrides,
  }
}

function makeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider-1',
    profileId: 'profile-1',
    companyName: 'Muster GmbH',
    handle: 'muster',
    description: null,
    city: 'Berlin',
    businessAddress: null,
    tradeCategories: ['Sanitär'],
    avatarUrl: null,
    isPublic: true,
    taxProfile: {
      taxNumber: null,
      vatId: null,
      legalForm: null,
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: null,
      bic: null,
    },
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - 1 * DAY_MS,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// formatAgeHours
// ---------------------------------------------------------------------------

describe('formatAgeHours', () => {
  it('formats sub-24h ages as "seit Xh"', () => {
    expect(formatAgeHours(0)).toBe('seit 0h')
    expect(formatAgeHours(5)).toBe('seit 5h')
    expect(formatAgeHours(23)).toBe('seit 23h')
    expect(formatAgeHours(23.9)).toBe('seit 23h')
  })

  it('formats 24-47h as "seit 1 Tag"', () => {
    expect(formatAgeHours(24)).toBe('seit 1 Tag')
    expect(formatAgeHours(47)).toBe('seit 1 Tag')
  })

  it('formats 48h+ as "seit X Tagen"', () => {
    expect(formatAgeHours(48)).toBe('seit 2 Tagen')
    expect(formatAgeHours(72)).toBe('seit 3 Tagen')
    expect(formatAgeHours(168)).toBe('seit 7 Tagen')
  })
})

// ---------------------------------------------------------------------------
// deriveStuckJobSignals
// ---------------------------------------------------------------------------

describe('deriveStuckJobSignals', () => {
  it('returns empty array when there are no jobs', () => {
    expect(deriveStuckJobSignals([], [])).toEqual([])
  })

  it('emits a stuck_proposal signal for a new job with intakeContext and no proposal', () => {
    const job = makeJob({ status: 'new', proposalSentAt: undefined })
    const signals = deriveStuckJobSignals([job], [])
    const signal = signals.find((s) => s.id === 'stuck_proposal_job-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('warning')
    expect(signal!.category).toBe('stuck_job')
    expect(signal!.jobId).toBe('job-1')
  })

  it('does not emit a stuck_proposal signal when proposal is already sent', () => {
    const job = makeJob({ status: 'new', proposalSentAt: NOW - 10 * HOUR_MS })
    const signals = deriveStuckJobSignals([job], [])
    expect(signals.find((s) => s.id === 'stuck_proposal_job-1')).toBeUndefined()
  })

  it('emits a stuck_scheduling signal for an accepted proposal not yet in_progress after 72h', () => {
    const job = makeJob({
      status: 'scheduled',
      proposalSentAt: NOW - 80 * HOUR_MS,
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const signals = deriveStuckJobSignals([job], [])
    const signal = signals.find((s) => s.id === 'stuck_scheduling_job-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('warning')
    expect(signal!.category).toBe('stuck_job')
  })

  it('emits a stuck_execution signal for an in_progress job with no activity for 72h', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const signals = deriveStuckJobSignals([job], [])
    const signal = signals.find((s) => s.id === 'stuck_execution_job-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('warning')
    expect(signal!.category).toBe('stuck_job')
  })

  it('emits a payment_release signal when the job has a release_pending payment', () => {
    const job = makeJob({ status: 'waiting_payment' })
    const payment = makePayment({ state: 'release_pending' })
    const signals = deriveStuckJobSignals([job], [payment])
    const signal = signals.find((s) => s.id === 'stuck_payment_release_job-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('info')
    expect(signal!.paymentId).toBe('payment-1')
  })

  it('can emit multiple signals for the same job', () => {
    const job = makeJob({
      status: 'in_progress',
      proposalAcceptedAt: NOW - 80 * HOUR_MS,
    })
    const payment = makePayment({ state: 'release_pending' })
    const signals = deriveStuckJobSignals([job], [payment])
    // execution silent + payment pending can both fire
    expect(signals.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// derivePaymentRiskSignals
// ---------------------------------------------------------------------------

describe('derivePaymentRiskSignals', () => {
  it('returns empty array when there are no payments', () => {
    expect(derivePaymentRiskSignals([], [])).toEqual([])
  })

  it('emits a critical payment_disputed signal for a disputed payment', () => {
    const payment = makePayment({ state: 'disputed' })
    const signals = derivePaymentRiskSignals([payment], [makeJob()])
    const signal = signals.find((s) => s.id === 'payment_disputed_payment-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('critical')
    expect(signal!.category).toBe('stuck_payment')
  })

  it('does not emit a release_aging signal for a release_pending payment within 7 days', () => {
    // Use REAL_NOW-relative timestamps because derivePaymentRiskSignals uses Date.now() internally.
    const payment = makePayment({
      state: 'release_pending',
      updatedAt: REAL_NOW - 5 * DAY_MS,
    })
    const signals = derivePaymentRiskSignals([payment], [makeJob()])
    expect(signals.find((s) => s.id === 'payment_release_aging_payment-1')).toBeUndefined()
  })

  it('emits a warning payment_release_aging signal after 7 days in release_pending', () => {
    // Use REAL_NOW-relative timestamps because derivePaymentRiskSignals uses Date.now() internally.
    const payment = makePayment({
      state: 'release_pending',
      updatedAt: REAL_NOW - 8 * DAY_MS,
    })
    const signals = derivePaymentRiskSignals([payment], [makeJob()])
    const signal = signals.find((s) => s.id === 'payment_release_aging_payment-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('warning')
    expect(signal!.ageLabel).toBeDefined()
  })

  it('emits an info deposit_required signal for a deposit_required payment', () => {
    const payment = makePayment({ state: 'deposit_required' })
    const signals = derivePaymentRiskSignals([payment], [makeJob()])
    const signal = signals.find((s) => s.id === 'payment_deposit_required_payment-1')
    expect(signal).toBeDefined()
    expect(signal!.severity).toBe('info')
  })

  it('falls back to paymentId as title when job is not found', () => {
    const payment = makePayment({ jobId: 'unknown-job' })
    payment.state = 'deposit_required'
    const signals = derivePaymentRiskSignals([payment], [])
    expect(signals[0].title).toContain('unknown-job')
  })
})

// ---------------------------------------------------------------------------
// deriveDisputeSignals
// ---------------------------------------------------------------------------

describe('deriveDisputeSignals', () => {
  it('returns empty array when there are no disputes', () => {
    expect(deriveDisputeSignals([], [])).toEqual([])
  })

  it('emits a warning for an open dispute < 7 days old', () => {
    // Use REAL_NOW-relative timestamps because getDisputeAgeDays uses Date.now() internally.
    const dispute = makeDispute({ status: 'open', createdAt: new Date(REAL_NOW - 3 * DAY_MS).toISOString() })
    const signals = deriveDisputeSignals([dispute], [makeJob()])
    expect(signals).toHaveLength(1)
    expect(signals[0].severity).toBe('warning')
    expect(signals[0].category).toBe('open_dispute')
  })

  it('escalates to critical for a dispute > 7 days old', () => {
    // Use REAL_NOW-relative timestamps because getDisputeAgeDays uses Date.now() internally.
    const dispute = makeDispute({ status: 'open', createdAt: new Date(REAL_NOW - 10 * DAY_MS).toISOString() })
    const signals = deriveDisputeSignals([dispute], [makeJob()])
    expect(signals[0].severity).toBe('critical')
  })

  it('emits a signal for under_review disputes', () => {
    const dispute = makeDispute({ status: 'under_review', createdAt: new Date(REAL_NOW - 2 * DAY_MS).toISOString() })
    const signals = deriveDisputeSignals([dispute], [makeJob()])
    expect(signals).toHaveLength(1)
  })

  it('skips resolved disputes', () => {
    const dispute = makeDispute({ status: 'resolved' as Dispute['status'], createdAt: new Date(NOW - 5 * DAY_MS).toISOString() })
    expect(deriveDisputeSignals([dispute], [makeJob()])).toHaveLength(0)
  })

  it('skips rejected disputes', () => {
    const dispute = makeDispute({ status: 'cancelled' as Dispute['status'], createdAt: new Date(NOW - 5 * DAY_MS).toISOString() })
    expect(deriveDisputeSignals([dispute], [makeJob()])).toHaveLength(0)
  })

  it('includes ageLabel and jobId in the signal', () => {
    const dispute = makeDispute({ status: 'open', createdAt: new Date(REAL_NOW - 3 * DAY_MS).toISOString() })
    const signal = deriveDisputeSignals([dispute], [makeJob()])[0]
    expect(signal.jobId).toBe('job-1')
    expect(signal.disputeId).toBe('dispute-1')
    expect(signal.ageLabel).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// deriveProviderGapSignals
// ---------------------------------------------------------------------------

describe('deriveProviderGapSignals', () => {
  it('returns empty array when all providers are complete', () => {
    expect(deriveProviderGapSignals([makeProvider()])).toHaveLength(0)
  })

  it('emits a signal for a provider with empty companyName', () => {
    const provider = makeProvider({ companyName: '' })
    const signals = deriveProviderGapSignals([provider])
    expect(signals).toHaveLength(1)
    expect(signals[0].category).toBe('incomplete_provider')
    expect(signals[0].detail).toContain('Firmenname')
  })

  it('emits a signal for a provider with no city', () => {
    const provider = makeProvider({ city: '' })
    const signals = deriveProviderGapSignals([provider])
    expect(signals[0].detail).toContain('Stadt')
  })

  it('emits a signal for a provider with empty tradeCategories', () => {
    const provider = makeProvider({ tradeCategories: [] })
    const signals = deriveProviderGapSignals([provider])
    expect(signals[0].detail).toContain('Gewerke')
  })

  it('emits a signal for a provider that is not public', () => {
    const provider = makeProvider({ isPublic: false })
    const signals = deriveProviderGapSignals([provider])
    expect(signals[0].detail).toContain('Sichtbarkeit')
  })

  it('lists all missing fields when provider is completely blank', () => {
    const provider = makeProvider({
      companyName: '',
      city: '',
      tradeCategories: [],
      isPublic: false,
    })
    const signals = deriveProviderGapSignals([provider])
    const detail = signals[0].detail
    expect(detail).toContain('Firmenname')
    expect(detail).toContain('Stadt')
    expect(detail).toContain('Gewerke')
    expect(detail).toContain('Sichtbarkeit')
  })

  it('returns empty array for empty provider list', () => {
    expect(deriveProviderGapSignals([])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// deriveOwnershipGapSignals
// ---------------------------------------------------------------------------

describe('deriveOwnershipGapSignals', () => {
  it('returns empty array for jobs with customerUserId set', () => {
    expect(deriveOwnershipGapSignals([makeJob({ customerUserId: 'user-1' })])).toHaveLength(0)
  })

  it('emits a critical signal for a job missing customerUserId', () => {
    const job = makeJob({ customerUserId: undefined })
    const signals = deriveOwnershipGapSignals([job])
    expect(signals).toHaveLength(1)
    expect(signals[0].severity).toBe('critical')
    expect(signals[0].category).toBe('ownership_gap')
    expect(signals[0].jobId).toBe('job-1')
  })

  it('emits a signal per missing-ownership job', () => {
    const job1 = makeJob({ id: 'job-1', customerUserId: undefined })
    const job2 = makeJob({ id: 'job-2', customerUserId: undefined })
    const job3 = makeJob({ id: 'job-3', customerUserId: 'user-3' })
    const signals = deriveOwnershipGapSignals([job1, job2, job3])
    expect(signals).toHaveLength(2)
  })

  it('returns empty array for empty job list', () => {
    expect(deriveOwnershipGapSignals([])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// derivePilotDiagnosticsSummary – master aggregator
// ---------------------------------------------------------------------------

describe('derivePilotDiagnosticsSummary', () => {
  it('returns a summary with no signals for clean inputs', () => {
    const summary = derivePilotDiagnosticsSummary(
      [makeJob({ status: 'completed' })],
      [makePayment({ state: 'released' })],
      [],
      [makeProvider()]
    )
    expect(summary.hasIssues).toBe(false)
    expect(summary.totalCount).toBe(0)
    expect(summary.criticalCount).toBe(0)
    expect(summary.warningCount).toBe(0)
    expect(summary.infoCount).toBe(0)
    expect(summary.signals).toHaveLength(0)
  })

  it('hasIssues is true when any signal is present', () => {
    const job = makeJob({ customerUserId: undefined })
    const summary = derivePilotDiagnosticsSummary([job], [], [], [])
    expect(summary.hasIssues).toBe(true)
  })

  it('counts critical signals correctly', () => {
    const job = makeJob({ customerUserId: undefined })
    const payment = makePayment({ state: 'disputed' })
    const summary = derivePilotDiagnosticsSummary([job], [payment], [], [])
    expect(summary.criticalCount).toBeGreaterThanOrEqual(2)
  })

  it('counts warning signals correctly', () => {
    // Provider with missing field → warning
    const provider = makeProvider({ city: '' })
    const summary = derivePilotDiagnosticsSummary([], [], [], [provider])
    expect(summary.warningCount).toBeGreaterThanOrEqual(1)
  })

  it('totalCount equals the sum of all severity counts', () => {
    const job = makeJob({ customerUserId: undefined })
    const provider = makeProvider({ city: '' })
    const dispute = makeDispute({ status: 'open', createdAt: new Date(REAL_NOW - 3 * DAY_MS).toISOString() })
    const summary = derivePilotDiagnosticsSummary([job], [], [dispute], [provider])
    expect(summary.totalCount).toBe(
      summary.criticalCount + summary.warningCount + summary.infoCount
    )
  })

  it('returns empty summary for completely empty inputs', () => {
    const summary = derivePilotDiagnosticsSummary([], [], [], [])
    expect(summary.hasIssues).toBe(false)
    expect(summary.totalCount).toBe(0)
  })
})
