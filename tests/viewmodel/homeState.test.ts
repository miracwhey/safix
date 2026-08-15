/**
 * Home State ViewModel — Unit Tests
 *
 * Tests the three pure derivation functions:
 *   deriveCustomerHomeState
 *   deriveOwnerHomeState
 *   deriveEmployeeHomeState
 *
 * Priority invariants under test (from the audit):
 *
 * Customer:
 *   dispute_open > release_required > funding_required > active > waiting > discovery
 *
 * Owner:
 *   dispute > payout_blocked > release_overdue > funding_awaited
 *   > requests_pending > onboarding_incomplete > busy > calm
 *
 * Employee:
 *   onsite > between > dayOff
 */

import { describe, it, expect } from 'vitest'
import {
  deriveCustomerHomeState,
  deriveOwnerHomeState,
  deriveEmployeeHomeState,
} from '../../src/lib/viewmodel/homeState'
import type {
  CustomerHomeStateParams,
  OwnerHomeStateParams,
} from '../../src/lib/viewmodel/homeState'
import type { Job } from '../../src/lib/jobs/types'
import type { Dispute } from '../../src/lib/disputes/types'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { OnboardingProgress } from '../../src/lib/onboarding/selectors'
import { getEmptyPayoutFailureAlert } from '../../src/lib/payments/payoutFailureAlert'

// ── Builders ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    title: 'Testauftrag',
    customer: 'Test Kunde',
    location: 'Hamburg',
    dateLabel: 'Mo 27.04',
    status: 'in_progress',
    amount: '1000',
    description: 'Test',
    paymentState: 'in_escrow',
    documentationStatus: 'ok',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-1',
    jobId: 'job-1',
    status: 'open',
    reason: 'work_quality',
    title: 'Qualitätsproblem',
    description: 'Test dispute',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeCalendarEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: 'entry-1',
    kind: 'job',
    title: 'Bad Schmidt',
    description: '',
    customerName: 'Schmidt',
    location: 'Hamburg',
    dateLabel: 'Heute',
    dateKey: '2026-04-27',
    startsAtLabel: '09:00',
    endsAtLabel: '17:00',
    assignedMemberIds: ['member-1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeOnboardingProgress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    steps: [],
    completedCount: 5,
    totalCount: 5,
    completionPercent: 100,
    isComplete: true,
    nextStep: null,
    isDiscoveryBlocked: false,
    isProfileReady: true,
    isPayoutReady: true,
    ...overrides,
  }
}

const HYDRATED_CUSTOMER: Pick<CustomerHomeStateParams, 'jobsHydrated' | 'paymentHydrated'> = {
  jobsHydrated: true,
  paymentHydrated: true,
}

const HYDRATED_OWNER: Pick<
  OwnerHomeStateParams,
  'jobsHydrated' | 'paymentHydrated' | 'payoutFailureAlert'
> = {
  jobsHydrated: true,
  paymentHydrated: true,
  payoutFailureAlert: getEmptyPayoutFailureAlert(),
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer — loading
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — loading', () => {
  it('returns loading when jobsHydrated is false', () => {
    const result = deriveCustomerHomeState({
      jobs: [],
      disputes: [],
      jobsHydrated: false,
      paymentHydrated: true,
    })
    expect(result.kind).toBe('loading')
  })

  it('returns loading when both repos are not hydrated', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob()],
      disputes: [],
      jobsHydrated: false,
      paymentHydrated: false,
    })
    expect(result.kind).toBe('loading')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — discovery
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — discovery', () => {
  it('returns discovery when there are no jobs', () => {
    const result = deriveCustomerHomeState({ jobs: [], disputes: [], ...HYDRATED_CUSTOMER })
    expect(result.kind).toBe('discovery')
    expect(result.priorityReason).toBeNull()
    expect(result.notificationDot).toBe(false)
  })

  it('returns discovery when all jobs are completed', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'completed' }), makeJob({ id: 'job-2', status: 'cancelled' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('discovery')
  })

  it('discovery primary action routes to /explore', () => {
    const result = deriveCustomerHomeState({ jobs: [], disputes: [], ...HYDRATED_CUSTOMER })
    expect(result.primaryAction?.route).toBe('/explore')
    expect(result.primaryAction?.actionId).toBe('browse_craftsmen')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — waiting
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — waiting', () => {
  it('returns waiting when active jobs are all new (no accepted offer)', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'new', paymentState: 'none' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('waiting')
    expect(result.priorityReason).toBeNull()
    expect(result.notificationDot).toBe(false)
  })

  it('returns waiting + funding_required when only new job has deposit_required', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'new', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('waiting')
    expect(result.priorityReason).toBe('funding_required')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — active (normal)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — active (no priority)', () => {
  it('returns active when a job is in_progress with no payment urgency', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'in_progress', paymentState: 'in_escrow' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('active')
    expect(result.priorityReason).toBeNull()
    expect(result.severity).toBeNull()
  })

  it('returns active when a job is booked', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'booked', paymentState: 'in_escrow' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('active')
    expect(result.priorityReason).toBeNull()
  })

  it('primary action routes to the running job', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-xyz', projectId: 'proj-xyz', status: 'in_progress', paymentState: 'in_escrow' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.primaryAction?.route).toBe('/projects/proj-xyz')
    expect(result.primaryAction?.actionId).toBe('view_project')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — priority: funding_required
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — funding_required', () => {
  it('returns waiting + funding_required when booked job has deposit_required', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('waiting')
    expect(result.priorityReason).toBe('funding_required')
    expect(result.severity).toBe('action')
    expect(result.notificationDot).toBe(true)
  })

  it('funding_required primary action falls back to the project when no lookup is provided', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-abc', projectId: 'proj-abc', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.primaryAction?.actionId).toBe('fund_escrow')
    expect(result.primaryAction?.route).toBe('/projects/proj-abc')
  })

  it('funding_required deep-links to FundingEntry when fundingRequestLookup resolves', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-abc', projectId: 'proj-abc', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
      fundingRequestLookup: (jobId) => (jobId === 'job-abc' ? 'fr-xyz' : undefined),
    })
    expect(result.primaryAction?.actionId).toBe('fund_escrow')
    expect(result.primaryAction?.route).toBe('/funding/fr-xyz')
  })

  it('funding_required falls back to project route when lookup returns undefined', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-abc', projectId: 'proj-abc', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
      // Simulates the cold-start window where the funding repo is hydrated
      // but the FundingRequest for this job has not yet propagated.
      fundingRequestLookup: () => undefined,
    })
    expect(result.primaryAction?.route).toBe('/projects/proj-abc')
  })

  it('funding_required is suppressed when paymentHydrated is false', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      jobsHydrated: true,
      paymentHydrated: false,
    })
    // payment truth not ready — must not show funding_required
    expect(result.priorityReason).not.toBe('funding_required')
  })

  it('returns active when funded running job exists alongside deposit_required job', () => {
    const result = deriveCustomerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'in_progress', paymentState: 'in_escrow' }),
        makeJob({ id: 'j2', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('active')
    expect(result.priorityReason).toBeNull()
    expect(result.primaryAction?.actionId).toBe('view_project')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — terminal-dead funding (expired / cancelled) is not payable
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — terminal-dead funding', () => {
  it('does NOT surface funding_required / fund_escrow for an expired funding request', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-dead', projectId: 'proj-dead', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
      fundingStatusLookup: () => 'expired',
    })
    expect(result.priorityReason).not.toBe('funding_required')
    expect(result.primaryAction?.actionId).not.toBe('fund_escrow')
  })

  it('does NOT surface fund_escrow for a cancelled funding request', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-dead', projectId: 'proj-dead', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
      fundingStatusLookup: () => 'cancelled',
    })
    expect(result.primaryAction?.actionId).not.toBe('fund_escrow')
  })

  it('still surfaces funding_required when the funding request is live (sent)', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-live', projectId: 'proj-live', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
      fundingStatusLookup: () => 'sent',
    })
    expect(result.priorityReason).toBe('funding_required')
    expect(result.primaryAction?.actionId).toBe('fund_escrow')
  })

  it('excludes an expired deposit job from follow-ups (no "Einzahlung ausstehend")', () => {
    // Primary = dispute on job-dispute; the secondary expired deposit job must
    // NOT appear as a pending funding follow-up.
    const result = deriveCustomerHomeState({
      jobs: [
        makeJob({ id: 'job-dispute', status: 'in_progress' }),
        makeJob({ id: 'job-dead', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [makeDispute({ jobId: 'job-dispute', status: 'open' })],
      ...HYDRATED_CUSTOMER,
      fundingStatusLookup: (jobId) => (jobId === 'job-dead' ? 'expired' : undefined),
    })
    expect(result.followUps.find((f) => f.id.includes('job-dead'))).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — priority: release_required
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — release_required', () => {
  it('returns active + release_required when job is waiting_payment + release_pending', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('active')
    expect(result.priorityReason).toBe('release_required')
    expect(result.severity).toBe('urgent')
    expect(result.notificationDot).toBe(true)
  })

  it('release_required primary action has actionId release_payment', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-r', projectId: 'proj-r', status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.primaryAction?.actionId).toBe('release_payment')
    expect(result.primaryAction?.route).toBe('/projects/proj-r')
  })

  it('release_required outranks funding_required', () => {
    const result = deriveCustomerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'waiting_payment', paymentState: 'release_pending' }),
        makeJob({ id: 'j2', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('release_required')
  })

  it('release_required is suppressed when paymentHydrated is false', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [],
      jobsHydrated: true,
      paymentHydrated: false,
    })
    expect(result.priorityReason).not.toBe('release_required')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — priority: dispute_open
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — dispute_open', () => {
  it('returns active + dispute_open for an open dispute', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1', status: 'in_progress', paymentState: 'disputed' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.kind).toBe('active')
    expect(result.priorityReason).toBe('dispute_open')
    expect(result.severity).toBe('urgent')
    expect(result.notificationDot).toBe(true)
  })

  it('dispute_open fires for customer_waiting status', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'customer_waiting' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute_open fires for provider_waiting status', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'provider_waiting' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute_open fires for under_review status', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'under_review' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute_open does NOT fire for resolved (decision=release)', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1', status: 'in_progress', paymentState: 'in_escrow' })],
      disputes: [
        makeDispute({
          jobId: 'job-1',
          status: 'resolved',
          decision: 'release',
          resolutionType: 'release_full',
        }),
      ],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).not.toBe('dispute_open')
  })

  it('dispute_open outranks release_required', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1', status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute_open outranks funding_required', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-1', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute on resolved job does not trigger — dispute jobId must match active job', () => {
    const result = deriveCustomerHomeState({
      jobs: [
        makeJob({ id: 'job-completed', status: 'completed' }),
        makeJob({ id: 'job-active', status: 'in_progress', paymentState: 'in_escrow' }),
      ],
      disputes: [makeDispute({ jobId: 'job-completed', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    // dispute is on a completed job — not an active job
    expect(result.priorityReason).not.toBe('dispute_open')
  })

  it('dispute primary action has actionId open_dispute', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-d', projectId: 'proj-d' })],
      disputes: [makeDispute({ jobId: 'job-d', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.primaryAction?.actionId).toBe('open_dispute')
    expect(result.primaryAction?.route).toBe('/projects/proj-d')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — follow-up list
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — followUps', () => {
  it('followUps includes other release-pending jobs when primary is dispute', () => {
    const result = deriveCustomerHomeState({
      jobs: [
        makeJob({ id: 'job-dispute', status: 'in_progress' }),
        makeJob({ id: 'job-release', status: 'waiting_payment', paymentState: 'release_pending' }),
      ],
      disputes: [makeDispute({ jobId: 'job-dispute', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    const releaseFollowUp = result.followUps.find((f) => f.id.includes('job-release'))
    expect(releaseFollowUp).toBeDefined()
    expect(releaseFollowUp?.severity).toBe('urgent')
  })

  it('followUps are empty when paymentHydrated is false', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ id: 'job-dispute' })],
      disputes: [makeDispute({ jobId: 'job-dispute', status: 'open' })],
      jobsHydrated: true,
      paymentHydrated: false,
    })
    // dispute detection bypasses paymentHydrated — but follow-ups need it
    expect(result.followUps).toHaveLength(0)
  })

  it('followUps capped at 3 items', () => {
    const jobs = [
      makeJob({ id: 'j1', status: 'in_progress' }),
      makeJob({ id: 'j2', status: 'waiting_payment', paymentState: 'release_pending' }),
      makeJob({ id: 'j3', status: 'waiting_payment', paymentState: 'release_pending' }),
      makeJob({ id: 'j4', status: 'booked', paymentState: 'deposit_required' }),
      makeJob({ id: 'j5', status: 'booked', paymentState: 'deposit_required' }),
    ]
    const result = deriveCustomerHomeState({
      jobs,
      disputes: [makeDispute({ jobId: 'j1', status: 'open' })],
      ...HYDRATED_CUSTOMER,
    })
    expect(result.followUps.length).toBeLessThanOrEqual(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Customer — route contract invariant
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveCustomerHomeState — route contract', () => {
  const isCraftsmanRoute = (route: string) => route.startsWith('/craftsman/')

  function collectRoutes(jobs: ReturnType<typeof makeJob>[], disputeList: ReturnType<typeof makeDispute>[] = []) {
    const result = deriveCustomerHomeState({ jobs, disputes: disputeList, ...HYDRATED_CUSTOMER })
    const routes: string[] = []
    if (result.primaryAction) routes.push(result.primaryAction.route)
    result.followUps.forEach((f) => routes.push(f.route))
    return routes
  }

  it('no customer primaryAction or followUp route starts with /craftsman/', () => {
    const scenarios: string[][] = [
      // waiting — no running jobs
      collectRoutes([makeJob({ status: 'new', paymentState: 'none' })]),
      // waiting + funding_required
      collectRoutes([makeJob({ status: 'booked', paymentState: 'deposit_required' })]),
      // active — in_progress
      collectRoutes([makeJob({ status: 'in_progress', paymentState: 'in_escrow' })]),
      // release_required
      collectRoutes([makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })]),
      // dispute_open
      collectRoutes(
        [makeJob({ id: 'j1', status: 'in_progress' })],
        [makeDispute({ jobId: 'j1', status: 'open' })]
      ),
      // funded + unfunded coexistence
      collectRoutes([
        makeJob({ id: 'j1', projectId: 'p1', status: 'in_progress', paymentState: 'in_escrow' }),
        makeJob({ id: 'j2', projectId: 'p2', status: 'booked', paymentState: 'deposit_required' }),
      ]),
    ]

    for (const routes of scenarios) {
      for (const route of routes) {
        expect(isCraftsmanRoute(route)).toBe(false)
      }
    }
  })

  it('customer primaryAction route starts with /projects/ or /explore when there are active jobs', () => {
    const allowedPrefixes = ['/projects/', '/explore', '/projects']
    const scenarios = [
      collectRoutes([makeJob({ status: 'new' })]),
      collectRoutes([makeJob({ status: 'booked', paymentState: 'deposit_required' })]),
      collectRoutes([makeJob({ status: 'in_progress', paymentState: 'in_escrow' })]),
    ]
    for (const routes of scenarios) {
      const primary = routes[0]
      expect(allowedPrefixes.some((prefix) => primary.startsWith(prefix))).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — loading
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — loading', () => {
  it('returns loading when jobsHydrated is false', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: getEmptyPayoutFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: false,
      paymentHydrated: true,
    })
    expect(result.kind).toBe('loading')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — onboarding_incomplete
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — onboarding_incomplete', () => {
  it('returns onboarding_incomplete when isProfileReady is false', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress({ isProfileReady: false }),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('onboarding_incomplete')
    expect(result.primaryAction?.actionId).toBe('complete_profile')
    expect(result.primaryAction?.route).toBe('/onboarding/craftsman-profile')
  })

  it('dispute overrides onboarding_incomplete', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress({ isProfileReady: false }),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
  })

  it('onboarding_incomplete takes priority over busy and calm', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'in_progress', paymentState: 'in_escrow' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress({ isProfileReady: false }),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('onboarding_incomplete')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — dispute
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — dispute', () => {
  it('returns dispute when there is an open dispute', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
    expect(result.priorityReason).toBe('dispute_open')
    expect(result.severity).toBe('urgent')
    expect(result.notificationDot).toBe(true)
  })

  it('dispute state fires for customer_waiting', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'customer_waiting' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
  })

  it('dispute state fires for provider_waiting', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'provider_waiting' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
  })

  it('dispute state does NOT fire for resolved (decision=release)', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [
        makeDispute({
          jobId: 'job-1',
          status: 'resolved',
          decision: 'release',
          resolutionType: 'release_full',
        }),
      ],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).not.toBe('dispute')
  })

  it('dispute overrides payout_blocked', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      payoutReadiness: 'payout_blocked',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('dispute primary action routes to the job', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-xyz' })],
      disputes: [makeDispute({ jobId: 'job-xyz', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.primaryAction?.actionId).toBe('open_dispute')
    expect(result.primaryAction?.route).toBe('/craftsman/jobs/job-xyz')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — payout_blocked
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — payout_blocked', () => {
  it('returns busy + payout_blocked when payoutReadiness is payout_blocked', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob()],
      disputes: [],
      payoutReadiness: 'payout_blocked',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBe('payout_blocked')
    expect(result.severity).toBe('urgent')
    expect(result.notificationDot).toBe(true)
  })

  it('calm is never returned when payout is blocked', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_blocked',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).not.toBe('calm')
    expect(result.priorityReason).toBe('payout_blocked')
  })

  it('payout_blocked is suppressed when paymentHydrated is false', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_blocked',
      payoutFailureAlert: getEmptyPayoutFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: false,
    })
    // without payment truth we can't confirm payout_blocked priority
    expect(result.priorityReason).not.toBe('payout_blocked')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — payout_failed (Block 7.1D)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — payout_failed', () => {
  function makeFailureAlert() {
    return {
      hasPayoutFailure: true,
      count: 1,
      latestFailureAt: 1_700_000_000_000,
      actionRoute: '/craftsman/profile/tax-bank',
      ctaLabel: 'Bankdaten prüfen',
      title: 'Auszahlung fehlgeschlagen',
      description:
        'Stripe konnte deine Auszahlung nicht abschließen. Prüfe deine Bankdaten, damit zukünftige Auszahlungen funktionieren.',
    }
  }

  it('returns busy + payout_failed when an alert is present', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob()],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBe('payout_failed')
    expect(result.severity).toBe('urgent')
    expect(result.notificationDot).toBe(true)
    expect(result.primaryAction?.actionId).toBe('fix_payout_bank_data')
    expect(result.primaryAction?.route).toBe('/craftsman/profile/tax-bank')
    expect(result.primaryAction?.label).toBe('Bankdaten prüfen')
  })

  it('does not duplicate the alert as a follow-up when it is the hero state', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob()],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.followUps.find((f) => f.id === 'followup-payout-failed')).toBeUndefined()
  })

  it('payout_blocked still wins over payout_failed', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob()],
      disputes: [],
      payoutReadiness: 'payout_blocked',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.priorityReason).toBe('payout_blocked')
    // The failed payout is surfaced as a follow-up under the blocked hero.
    expect(result.followUps.some((f) => f.id === 'followup-payout-failed')).toBe(true)
  })

  it('dispute still wins over payout_failed', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-disp' })],
      disputes: [makeDispute({ jobId: 'job-disp', status: 'open' })],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.priorityReason).toBe('dispute_open')
  })

  it('payout_failed wins over release_overdue and funding_awaited', () => {
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'job-rel', status: 'waiting_payment', paymentState: 'release_pending' }),
      ],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.priorityReason).toBe('payout_failed')
  })

  it('payout_failed is suppressed when paymentHydrated is false', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: makeFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: false,
    })
    expect(result.priorityReason).not.toBe('payout_failed')
  })

  it('empty alert keeps reason null when no other urgency exists', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_ready',
      payoutFailureAlert: getEmptyPayoutFailureAlert(),
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: true,
    })
    expect(result.priorityReason).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — release_overdue
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — release_overdue', () => {
  it('returns busy + release_overdue when a job awaits customer release', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBe('release_overdue')
    expect(result.severity).toBe('action')
    expect(result.notificationDot).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — funding_awaited
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — funding_awaited', () => {
  it('returns busy + funding_awaited when a job has deposit_required', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBe('funding_awaited')
    expect(result.severity).toBe('action')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — terminal-dead funding (expired / cancelled) is not "customer must pay"
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — terminal-dead funding', () => {
  it('does NOT surface funding_awaited for an expired funding request', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-dead', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
      fundingStatusLookup: () => 'expired',
    })
    expect(result.priorityReason).not.toBe('funding_awaited')
  })

  it('still surfaces funding_awaited when the funding request is live (sent)', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-live', status: 'booked', paymentState: 'deposit_required' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
      fundingStatusLookup: () => 'sent',
    })
    expect(result.priorityReason).toBe('funding_awaited')
  })

  it('excludes a cancelled deposit job from follow-ups', () => {
    // Primary = dispute; the secondary cancelled deposit job must not appear as
    // a pending funding follow-up implying the customer still must pay.
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'job-dispute' }),
        makeJob({ id: 'job-dead', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [makeDispute({ jobId: 'job-dispute', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
      fundingStatusLookup: (jobId) => (jobId === 'job-dead' ? 'cancelled' : undefined),
    })
    expect(result.kind).toBe('dispute')
    expect(result.followUps.find((f) => f.id.includes('job-dead'))).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — requests_pending
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — requests_pending', () => {
  it('returns busy + requests_pending for new incoming jobs', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'new', paymentState: 'none' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBe('requests_pending')
    expect(result.primaryAction?.actionId).toBe('view_requests')
    expect(result.notificationDot).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — busy (active work, no urgent items)
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — busy (active work)', () => {
  it('returns busy when jobs are running but no urgent payment issues', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'in_progress', paymentState: 'in_escrow' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('busy')
    expect(result.priorityReason).toBeNull()
    expect(result.severity).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — calm
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — calm', () => {
  it('returns calm when there are no active jobs and no issues', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('calm')
    expect(result.priorityReason).toBeNull()
    expect(result.notificationDot).toBe(false)
  })

  it('calm is returned when all jobs are completed', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'completed' }), makeJob({ id: 'j2', status: 'cancelled' })],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('calm')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — priority ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — priority ordering', () => {
  it('dispute > payout_blocked', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'job-1' })],
      disputes: [makeDispute({ jobId: 'job-1', status: 'open' })],
      payoutReadiness: 'payout_blocked',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
  })

  it('dispute > release_overdue', () => {
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'job-dispute' }),
        makeJob({ id: 'job-release', status: 'waiting_payment', paymentState: 'release_pending' }),
      ],
      disputes: [makeDispute({ jobId: 'job-dispute', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
  })

  it('payout_blocked > release_overdue', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [],
      payoutReadiness: 'payout_blocked',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.priorityReason).toBe('payout_blocked')
  })

  it('release_overdue > funding_awaited', () => {
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'waiting_payment', paymentState: 'release_pending' }),
        makeJob({ id: 'j2', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.priorityReason).toBe('release_overdue')
  })

  it('requests_pending > busy (no urgency)', () => {
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'in_progress' }),
        makeJob({ id: 'j2', status: 'new', paymentState: 'none' }),
      ],
      disputes: [],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.priorityReason).toBe('requests_pending')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Owner — followUps
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOwnerHomeState — followUps', () => {
  it('followUps includes payout_setup when onboarding_required', () => {
    const result = deriveOwnerHomeState({
      jobs: [],
      disputes: [],
      payoutReadiness: 'onboarding_required',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    const payoutFollowUp = result.followUps.find((f) => f.id === 'followup-payout-setup')
    expect(payoutFollowUp).toBeDefined()
    expect(payoutFollowUp?.severity).toBe('action')
  })

  it('followUps includes release items when primary is dispute (not the release job)', () => {
    // Primary = dispute on j1; j2 (release_pending) must appear in followUps.
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'in_progress' }),
        makeJob({ id: 'j2', status: 'waiting_payment', paymentState: 'release_pending' }),
      ],
      disputes: [makeDispute({ jobId: 'j1', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.kind).toBe('dispute')
    const releaseFollowUp = result.followUps.find((f) => f.id.includes('j2'))
    expect(releaseFollowUp).toBeDefined()
    expect(releaseFollowUp?.severity).toBe('action')
  })

  it('followUps are empty when paymentHydrated is false', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'j1', status: 'in_progress' })],
      disputes: [],
      payoutReadiness: 'onboarding_required',
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: true,
      paymentHydrated: false,
    })
    expect(result.followUps).toHaveLength(0)
  })

  it('followUps capped at 3', () => {
    const result = deriveOwnerHomeState({
      jobs: [
        makeJob({ id: 'j1', status: 'new', paymentState: 'none' }),
        makeJob({ id: 'j2', status: 'waiting_payment', paymentState: 'release_pending' }),
        makeJob({ id: 'j3', status: 'waiting_payment', paymentState: 'release_pending' }),
        makeJob({ id: 'j4', status: 'booked', paymentState: 'deposit_required' }),
      ],
      disputes: [],
      payoutReadiness: 'onboarding_required',
      onboardingProgress: makeOnboardingProgress(),
      ...HYDRATED_OWNER,
    })
    expect(result.followUps.length).toBeLessThanOrEqual(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Employee — loading
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEmployeeHomeState — loading', () => {
  it('returns loading when calendarHydrated is false', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [],
      todayKey: '2026-04-27',
      calendarHydrated: false,
    })
    expect(result.kind).toBe('loading')
    expect(result.primaryAction).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Employee — dayOff
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEmployeeHomeState — dayOff', () => {
  it('returns dayOff when there are no entries today', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.kind).toBe('dayOff')
    expect(result.primaryAction).toBeNull()
    expect(result.notificationDot).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Employee — between
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEmployeeHomeState — between', () => {
  it('returns between when today entries exist but none are in_progress', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [makeCalendarEntry({ status: 'scheduled' })],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.kind).toBe('between')
    expect(result.primaryAction?.actionId).toBe('start_deployment')
  })

  it('between primary action routes to the first entry', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [makeCalendarEntry({ id: 'entry-xyz', status: 'scheduled' })],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.primaryAction?.route).toBe('/worker/einsaetze/entry-xyz')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Employee — onsite
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveEmployeeHomeState — onsite', () => {
  it('returns onsite when a today entry is in_progress', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [makeCalendarEntry({ status: 'in_progress' })],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.kind).toBe('onsite')
    expect(result.primaryAction?.actionId).toBe('open_deployment')
  })

  it('onsite primary action routes to the in_progress entry', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [makeCalendarEntry({ id: 'active-entry', status: 'in_progress' })],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.primaryAction?.route).toBe('/worker/einsaetze/active-entry')
  })

  it('onsite > between — in_progress entry takes priority over scheduled', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [
        makeCalendarEntry({ id: 'e1', status: 'scheduled' }),
        makeCalendarEntry({ id: 'e2', status: 'in_progress' }),
      ],
      todayKey: '2026-04-27',
      calendarHydrated: true,
    })
    expect(result.kind).toBe('onsite')
    expect(result.primaryAction?.route).toBe('/worker/einsaetze/e2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting: hydration guard
// ─────────────────────────────────────────────────────────────────────────────

describe('hydration guard — never show payment-critical states before repos ready', () => {
  it('customer: loading when jobsHydrated=false even with urgent payment state', () => {
    const result = deriveCustomerHomeState({
      jobs: [makeJob({ status: 'waiting_payment', paymentState: 'release_pending' })],
      disputes: [makeDispute({ status: 'open' })],
      jobsHydrated: false,
      paymentHydrated: true,
    })
    expect(result.kind).toBe('loading')
  })

  it('owner: loading when jobsHydrated=false even with open dispute', () => {
    const result = deriveOwnerHomeState({
      jobs: [makeJob({ id: 'j1' })],
      disputes: [makeDispute({ jobId: 'j1', status: 'open' })],
      payoutReadiness: 'payout_ready',
      onboardingProgress: makeOnboardingProgress(),
      jobsHydrated: false,
      paymentHydrated: true,
    })
    expect(result.kind).toBe('loading')
  })

  it('employee: loading when calendarHydrated=false', () => {
    const result = deriveEmployeeHomeState({
      todayEntries: [makeCalendarEntry({ status: 'in_progress' })],
      todayKey: '2026-04-27',
      calendarHydrated: false,
    })
    expect(result.kind).toBe('loading')
  })
})
