/**
 * Block 7.2.1a — `deriveDownPaymentRequestPending` tests.
 */

import { describe, it, expect } from 'vitest'

import { deriveDownPaymentRequestPending } from '../../src/lib/projects/customerHomeHeroDownPaymentSelectors'
import type { FundingRequest, FundingRequestStatus } from '../../src/lib/payments/fundingRequest/types'
import type { SupplementaryPaymentRequest, SupplementaryPaymentStatus } from '../../src/lib/payments/supplementary/types'

function makeFundingRequest(status: FundingRequestStatus): FundingRequest {
  return {
    id: 'fr-1',
    sourceOfferId: 'offer-1',
    jobId: 'job-1',
    escrowPlanId: 'plan-1',
    customerUserId: 'cust-1',
    providerId: 'prov-1',
    providerUserId: 'owner-1',
    type: 'full_escrow',
    status,
    amount: 1000,
    currency: 'EUR',
    createdBy: 'provider',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeSupplementary(status: SupplementaryPaymentStatus): SupplementaryPaymentRequest {
  return {
    id: 'sp-1',
    changeOrderId: 'co-1',
    jobId: 'job-1',
    originalPaymentId: 'pay-1',
    customerUserId: 'cust-1',
    craftsmanUserId: 'owner-1',
    amountCents: 50_000,
    currency: 'EUR',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as SupplementaryPaymentRequest
}

describe('deriveDownPaymentRequestPending', () => {
  it('returns false when both inputs are undefined', () => {
    expect(deriveDownPaymentRequestPending(undefined, undefined)).toBe(false)
  })

  it('returns false when both inputs are empty arrays', () => {
    expect(deriveDownPaymentRequestPending([], [])).toBe(false)
  })

  it('returns true when at least one funding request is in `sent`', () => {
    expect(
      deriveDownPaymentRequestPending([makeFundingRequest('sent')], []),
    ).toBe(true)
  })

  it('returns true for funding_started / funding_initiated', () => {
    expect(
      deriveDownPaymentRequestPending([makeFundingRequest('funding_started')], []),
    ).toBe(true)
    expect(
      deriveDownPaymentRequestPending([makeFundingRequest('funding_initiated')], []),
    ).toBe(true)
  })

  it('returns false when funding requests are all in terminal states', () => {
    const terminalStates: FundingRequestStatus[] = ['funded', 'expired', 'cancelled', 'funding_failed']
    for (const s of terminalStates) {
      expect(
        deriveDownPaymentRequestPending([makeFundingRequest(s)], []),
      ).toBe(false)
    }
  })

  it('returns true when a supplementary payment is pending / acknowledged / funding_initiated', () => {
    expect(
      deriveDownPaymentRequestPending([], [makeSupplementary('pending')]),
    ).toBe(true)
    expect(
      deriveDownPaymentRequestPending([], [makeSupplementary('acknowledged')]),
    ).toBe(true)
    expect(
      deriveDownPaymentRequestPending([], [makeSupplementary('funding_initiated')]),
    ).toBe(true)
  })

  it('returns false when a supplementary payment is funded / released / paid / waived', () => {
    const closedStates: SupplementaryPaymentStatus[] = ['funded', 'released', 'paid', 'waived']
    for (const s of closedStates) {
      expect(
        deriveDownPaymentRequestPending([], [makeSupplementary(s)]),
      ).toBe(false)
    }
  })
})
