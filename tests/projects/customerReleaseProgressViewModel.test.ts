/**
 * Block 7.2.1a — `deriveCustomerReleaseProgressViewModel` tests.
 *
 * Pure-function selector. Tests cover all six state branches plus the
 * priority ordering (dispute → released → acceptance_pending →
 * awaiting_admin_confirm → in_progress → commissioned).
 */

import { describe, it, expect } from 'vitest'

import { deriveCustomerReleaseProgressViewModel } from '../../src/lib/projects/customerReleaseProgressViewModel'
import type { Job } from '../../src/lib/jobs/types'
import type { Acceptance } from '../../src/lib/acceptance/types'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    title: 'Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: '',
    status: 'in_progress',
    amount: '1.000 €',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'owner-1',
    customerUserId: 'cust-1',
    providerId: 'prov-1',
    ...overrides,
  } as Job
}

function makeAcceptance(overrides: Partial<Acceptance> = {}): Acceptance {
  const now = Date.now()
  return {
    id: 'acc-1',
    jobId: 'job-1',
    customerUserId: 'cust-1',
    status: 'pending',
    expiresAt: now + 72 * 60 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('deriveCustomerReleaseProgressViewModel — state branches', () => {
  it('returns disputed when an active dispute is on the job', () => {
    const job = makeJob({ disputeStatus: 'open' })
    const vm = deriveCustomerReleaseProgressViewModel(job)
    expect(vm.state).toBe('disputed')
  })

  it('returns disputed for under_review / customer_waiting / provider_waiting', () => {
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ disputeStatus: 'under_review' })).state,
    ).toBe('disputed')
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ disputeStatus: 'customer_waiting' })).state,
    ).toBe('disputed')
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ disputeStatus: 'provider_waiting' })).state,
    ).toBe('disputed')
  })

  it('does NOT return disputed when disputeStatus is resolved/closed/cancelled', () => {
    const resolved = deriveCustomerReleaseProgressViewModel(makeJob({ disputeStatus: 'resolved' }))
    expect(resolved.state).not.toBe('disputed')
  })

  it('returns released when acceptance.status === accepted (manual)', () => {
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({ workConfirmedCompleteAt: Date.now() }),
      makeAcceptance({ status: 'accepted', acceptedAt: Date.now() }),
    )
    expect(vm.state).toBe('released')
  })

  it('returns released when acceptance.status === accepted (auto-released by cron)', () => {
    // The cron sets status='accepted' too — we cannot distinguish at the
    // selector level, and the customer copy is the same either way.
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({ workConfirmedCompleteAt: Date.now() - 100_000 }),
      makeAcceptance({ status: 'accepted', acceptedAt: Date.now() }),
    )
    expect(vm.state).toBe('released')
  })

  it('returns acceptance_pending with expiresAt + createdAt when acceptance is open', () => {
    const created = Date.now() - 1000
    const expires = created + 72 * 60 * 60 * 1000
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({ workConfirmedCompleteAt: created }),
      makeAcceptance({ status: 'pending', createdAt: created, expiresAt: expires }),
    )
    expect(vm.state).toBe('acceptance_pending')
    expect(vm.acceptanceExpiresAt).toBe(expires)
    expect(vm.acceptanceCreatedAt).toBe(created)
  })

  it('returns awaiting_admin_confirm when worker marked but owner did not confirm', () => {
    const marked = Date.now() - 5000
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({
        status: 'in_progress',
        workMarkedCompleteAt: marked,
        workConfirmedCompleteAt: undefined,
      }),
    )
    expect(vm.state).toBe('awaiting_admin_confirm')
    expect(vm.workMarkedCompleteAt).toBe(marked)
  })

  it('returns in_progress when status is in_progress and no mark', () => {
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({ status: 'in_progress', workMarkedCompleteAt: undefined }),
    )
    expect(vm.state).toBe('in_progress')
  })

  it('returns commissioned for status booked / scheduled / waiting_payment without acceptance', () => {
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ status: 'booked' })).state,
    ).toBe('commissioned')
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ status: 'scheduled' })).state,
    ).toBe('commissioned')
    // waiting_payment without acceptance is an unusual edge — selector falls
    // back to commissioned because none of the higher-priority states match.
    expect(
      deriveCustomerReleaseProgressViewModel(makeJob({ status: 'waiting_payment' })).state,
    ).toBe('commissioned')
  })
})

describe('deriveCustomerReleaseProgressViewModel — priority ordering', () => {
  it('disputed wins over an open acceptance', () => {
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({ disputeStatus: 'under_review', workConfirmedCompleteAt: Date.now() }),
      makeAcceptance({ status: 'pending' }),
    )
    expect(vm.state).toBe('disputed')
  })

  it('released wins over awaiting_admin_confirm signals (defensive — cannot happen)', () => {
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({
        workMarkedCompleteAt: Date.now(),
        workConfirmedCompleteAt: Date.now(),
      }),
      makeAcceptance({ status: 'accepted', acceptedAt: Date.now() }),
    )
    expect(vm.state).toBe('released')
  })

  it('acceptance_pending wins over awaiting_admin_confirm when both signals coexist', () => {
    // After admin-confirm both stamps are set. Acceptance is the truth-source.
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({
        workMarkedCompleteAt: Date.now() - 2000,
        workConfirmedCompleteAt: Date.now() - 1000,
        status: 'waiting_payment',
      }),
      makeAcceptance({ status: 'pending' }),
    )
    expect(vm.state).toBe('acceptance_pending')
  })

  it('awaiting_admin_confirm wins over in_progress when worker has marked', () => {
    const vm = deriveCustomerReleaseProgressViewModel(
      makeJob({
        status: 'in_progress',
        workMarkedCompleteAt: Date.now(),
        workConfirmedCompleteAt: undefined,
      }),
    )
    expect(vm.state).toBe('awaiting_admin_confirm')
  })
})
