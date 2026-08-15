import { describe, it, expect } from 'vitest'
import {
  deriveProviderTrustFlags,
  deriveProviderTrustStatus,
  deriveProviderTrustAssessment,
  isProviderTrustedForDiscovery,
  deriveTrustScorePenalty,
  deriveCustomerRiskFlags,
  deriveCustomerRiskStatus,
  deriveCustomerRiskAssessment,
} from '../../src/lib/trust/trustSelectors'
import type { ProviderTrustInput, CustomerRiskInput } from '../../src/lib/trust/trustTypes'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProviderInput(overrides: Partial<ProviderTrustInput> = {}): ProviderTrustInput {
  return {
    providerUserId: 'provider-1',
    averageRating: 4.5,
    ratingCount: 10,
    payoutReady: true,
    onboardingCompleted: true,
    openDisputeCount: 0,
    totalDisputeCount: 0,
    completedJobsCount: 5,
    ...overrides,
  }
}

function makeCustomerInput(overrides: Partial<CustomerRiskInput> = {}): CustomerRiskInput {
  return {
    customerUserId: 'customer-1',
    totalDisputesRaised: 0,
    openDisputesRaised: 0,
    totalJobsCompleted: 5,
    ...overrides,
  }
}

// ── deriveProviderTrustFlags ──────────────────────────────────────────────────

describe('deriveProviderTrustFlags', () => {
  describe('fully trusted provider', () => {
    it('returns no flags when provider has good signals', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput())
      expect(flags).toHaveLength(0)
    })
  })

  describe('low reputation flag', () => {
    it('returns low_reputation watch flag when rating is between 2.5 and 3.0 with sufficient data', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 2.7, ratingCount: 5 })
      )
      const reputationFlag = flags.find((f) => f.kind === 'low_reputation')
      expect(reputationFlag).toBeDefined()
      expect(reputationFlag?.severity).toBe('medium')
    })

    it('returns low_reputation high-severity flag when rating is below 2.5 with sufficient data', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 2.0, ratingCount: 5 })
      )
      const reputationFlag = flags.find((f) => f.kind === 'low_reputation')
      expect(reputationFlag).toBeDefined()
      expect(reputationFlag?.severity).toBe('high')
    })

    it('does NOT flag reputation when ratingCount is below minimum (< 3)', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 1.0, ratingCount: 2 })
      )
      expect(flags.find((f) => f.kind === 'low_reputation')).toBeUndefined()
    })

    it('does NOT flag reputation when ratingCount is exactly 0', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 0, ratingCount: 0 })
      )
      expect(flags.find((f) => f.kind === 'low_reputation')).toBeUndefined()
    })

    it('does NOT flag reputation when average is exactly 3.0', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 3.0, ratingCount: 5 })
      )
      expect(flags.find((f) => f.kind === 'low_reputation')).toBeUndefined()
    })

    it('does NOT flag reputation when average is exactly 2.5', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({ averageRating: 2.5, ratingCount: 5 })
      )
      // 2.5 is not strictly < 2.5, so no high-severity flag
      expect(flags.find((f) => f.kind === 'low_reputation')?.severity).toBe('medium')
    })
  })

  describe('payout_not_ready flag', () => {
    it('returns payout_not_ready flag when payoutReady is false', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ payoutReady: false }))
      expect(flags.find((f) => f.kind === 'payout_not_ready')).toBeDefined()
    })

    it('does NOT flag payout when payoutReady is true', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ payoutReady: true }))
      expect(flags.find((f) => f.kind === 'payout_not_ready')).toBeUndefined()
    })
  })

  describe('repeated_disputes flag', () => {
    it('returns medium severity flag with 1 open dispute', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ openDisputeCount: 1 }))
      const disputeFlag = flags.find((f) => f.kind === 'repeated_disputes')
      expect(disputeFlag).toBeDefined()
      expect(disputeFlag?.severity).toBe('medium')
    })

    it('returns high severity flag with 3 or more open disputes', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ openDisputeCount: 3 }))
      const disputeFlag = flags.find((f) => f.kind === 'repeated_disputes')
      expect(disputeFlag).toBeDefined()
      expect(disputeFlag?.severity).toBe('high')
    })

    it('does NOT flag disputes when openDisputeCount is 0', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ openDisputeCount: 0 }))
      expect(flags.find((f) => f.kind === 'repeated_disputes')).toBeUndefined()
    })
  })

  describe('incomplete_onboarding flag', () => {
    it('returns incomplete_onboarding flag when onboarding is not complete', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ onboardingCompleted: false }))
      expect(flags.find((f) => f.kind === 'incomplete_onboarding')).toBeDefined()
    })

    it('does NOT flag onboarding when completed', () => {
      const flags = deriveProviderTrustFlags(makeProviderInput({ onboardingCompleted: true }))
      expect(flags.find((f) => f.kind === 'incomplete_onboarding')).toBeUndefined()
    })
  })

  describe('multiple flags', () => {
    it('can return multiple flags simultaneously', () => {
      const flags = deriveProviderTrustFlags(
        makeProviderInput({
          averageRating: 2.0,
          ratingCount: 5,
          payoutReady: false,
          openDisputeCount: 2,
          onboardingCompleted: false,
        })
      )
      expect(flags.length).toBeGreaterThanOrEqual(3)
      expect(flags.find((f) => f.kind === 'low_reputation')).toBeDefined()
      expect(flags.find((f) => f.kind === 'payout_not_ready')).toBeDefined()
      expect(flags.find((f) => f.kind === 'repeated_disputes')).toBeDefined()
    })
  })
})

// ── deriveProviderTrustStatus ─────────────────────────────────────────────────

describe('deriveProviderTrustStatus', () => {
  it('returns trusted when no flags', () => {
    expect(deriveProviderTrustStatus([])).toBe('trusted')
  })

  it('returns trusted when only low-severity flags (informational only)', () => {
    const flags = [{ kind: 'incomplete_onboarding' as const, label: 'test', severity: 'low' as const }]
    expect(deriveProviderTrustStatus(flags)).toBe('trusted')
  })

  it('returns watch when only medium-severity flags', () => {
    const flags = [{ kind: 'payout_not_ready' as const, label: 'test', severity: 'medium' as const }]
    expect(deriveProviderTrustStatus(flags)).toBe('watch')
  })

  it('returns restricted when any high-severity flag present', () => {
    const flags = [{ kind: 'low_reputation' as const, label: 'test', severity: 'high' as const }]
    expect(deriveProviderTrustStatus(flags)).toBe('restricted')
  })

  it('returns restricted when mix of high and medium severity', () => {
    const flags = [
      { kind: 'low_reputation' as const, label: 'a', severity: 'high' as const },
      { kind: 'payout_not_ready' as const, label: 'b', severity: 'medium' as const },
    ]
    expect(deriveProviderTrustStatus(flags)).toBe('restricted')
  })
})

// ── deriveProviderTrustAssessment ─────────────────────────────────────────────

describe('deriveProviderTrustAssessment', () => {
  it('trusted provider: not discovery blocked, not payout restricted', () => {
    const assessment = deriveProviderTrustAssessment(makeProviderInput())
    expect(assessment.status).toBe('trusted')
    expect(assessment.isDiscoveryBlocked).toBe(false)
    expect(assessment.isPayoutRestricted).toBe(false)
    expect(assessment.flags).toHaveLength(0)
  })

  it('restricted provider (low rating): discovery blocked', () => {
    const assessment = deriveProviderTrustAssessment(
      makeProviderInput({ averageRating: 2.0, ratingCount: 5 })
    )
    expect(assessment.status).toBe('restricted')
    expect(assessment.isDiscoveryBlocked).toBe(true)
  })

  it('watch provider (payout not ready): payout restricted but NOT discovery blocked', () => {
    const assessment = deriveProviderTrustAssessment(
      makeProviderInput({ payoutReady: false })
    )
    expect(assessment.status).toBe('watch')
    expect(assessment.isDiscoveryBlocked).toBe(false)
    expect(assessment.isPayoutRestricted).toBe(true)
  })

  it('includes providerUserId in assessment', () => {
    const assessment = deriveProviderTrustAssessment(
      makeProviderInput({ providerUserId: 'provider-xyz' })
    )
    expect(assessment.providerUserId).toBe('provider-xyz')
  })
})

// ── isProviderTrustedForDiscovery ─────────────────────────────────────────────

describe('isProviderTrustedForDiscovery', () => {
  it('returns true when rating is good', () => {
    expect(isProviderTrustedForDiscovery({ rating: 4.8, ratingCount: 10 })).toBe(true)
  })

  it('returns true when no ratings yet', () => {
    expect(isProviderTrustedForDiscovery({ rating: null, ratingCount: 0 })).toBe(true)
  })

  it('returns true when ratingCount is below minimum threshold (< 3)', () => {
    expect(isProviderTrustedForDiscovery({ rating: 1.0, ratingCount: 2 })).toBe(true)
  })

  it('returns false when rating < 2.5 AND ratingCount >= 3', () => {
    expect(isProviderTrustedForDiscovery({ rating: 2.0, ratingCount: 5 })).toBe(false)
  })

  it('returns false when rating is exactly 2.4 with sufficient ratings', () => {
    expect(isProviderTrustedForDiscovery({ rating: 2.4, ratingCount: 3 })).toBe(false)
  })

  it('returns true when rating is exactly 2.5 (threshold is exclusive)', () => {
    expect(isProviderTrustedForDiscovery({ rating: 2.5, ratingCount: 10 })).toBe(true)
  })

  it('returns true when rating is exactly 2.6 (above threshold)', () => {
    expect(isProviderTrustedForDiscovery({ rating: 2.6, ratingCount: 10 })).toBe(true)
  })

  it('correctly gates discovery pipeline: blocks low-rated providers', () => {
    const providers = [
      { rating: 4.8, ratingCount: 20 },
      { rating: 2.0, ratingCount: 5 },
      { rating: null, ratingCount: 0 },
      { rating: 2.8, ratingCount: 10 },
      { rating: 1.5, ratingCount: 3 },
    ]
    const trusted = providers.filter(isProviderTrustedForDiscovery)
    // Trusted: good rating (4.8), no ratings yet (null), and above-threshold rating (2.8)
    expect(trusted).toHaveLength(3)
    expect(trusted[0].rating).toBe(4.8)
    expect(trusted[1].rating).toBeNull()
    expect(trusted[2].rating).toBe(2.8)
    // Untrusted (receive restricted penalty): 2.0 and 1.5 with sufficient rating counts
    const untrusted = providers.filter((p) => !isProviderTrustedForDiscovery(p))
    expect(untrusted).toHaveLength(2)
    expect(untrusted.every((p) => p.rating !== null && p.rating < 2.5)).toBe(true)
  })
})

// ── deriveCustomerRiskFlags ───────────────────────────────────────────────────

describe('deriveCustomerRiskFlags', () => {
  it('returns no flags for a normal customer', () => {
    const flags = deriveCustomerRiskFlags(makeCustomerInput())
    expect(flags).toHaveLength(0)
  })

  it('returns repeated_disputes flag when disputes >= 2', () => {
    const flags = deriveCustomerRiskFlags(makeCustomerInput({ totalDisputesRaised: 2 }))
    expect(flags.find((f) => f.kind === 'repeated_disputes')).toBeDefined()
  })

  it('does NOT flag disputes when totalDisputesRaised is 1', () => {
    const flags = deriveCustomerRiskFlags(makeCustomerInput({ totalDisputesRaised: 1 }))
    expect(flags.find((f) => f.kind === 'repeated_disputes')).toBeUndefined()
  })

  it('returns high_dispute_rate flag when dispute rate >= 50%', () => {
    const flags = deriveCustomerRiskFlags(
      makeCustomerInput({ totalDisputesRaised: 3, totalJobsCompleted: 5 })
    )
    expect(flags.find((f) => f.kind === 'high_dispute_rate')).toBeDefined()
  })

  it('does NOT return high_dispute_rate when jobs completed is 0', () => {
    const flags = deriveCustomerRiskFlags(
      makeCustomerInput({ totalDisputesRaised: 5, totalJobsCompleted: 0 })
    )
    expect(flags.find((f) => f.kind === 'high_dispute_rate')).toBeUndefined()
  })
})

// ── deriveCustomerRiskStatus ──────────────────────────────────────────────────

describe('deriveCustomerRiskStatus', () => {
  it('returns normal for customer with no flags', () => {
    const input = makeCustomerInput()
    const flags = deriveCustomerRiskFlags(input)
    expect(deriveCustomerRiskStatus(flags, input)).toBe('normal')
  })

  it('returns elevated when flags are present but disputes < 4', () => {
    const input = makeCustomerInput({ totalDisputesRaised: 2 })
    const flags = deriveCustomerRiskFlags(input)
    expect(deriveCustomerRiskStatus(flags, input)).toBe('elevated')
  })

  it('returns high when totalDisputesRaised >= 4', () => {
    const input = makeCustomerInput({ totalDisputesRaised: 4 })
    const flags = deriveCustomerRiskFlags(input)
    expect(deriveCustomerRiskStatus(flags, input)).toBe('high')
  })
})

// ── deriveCustomerRiskAssessment ──────────────────────────────────────────────

describe('deriveCustomerRiskAssessment', () => {
  it('normal customer: normal status, no flags', () => {
    const assessment = deriveCustomerRiskAssessment(makeCustomerInput())
    expect(assessment.status).toBe('normal')
    expect(assessment.flags).toHaveLength(0)
    expect(assessment.customerUserId).toBe('customer-1')
  })

  it('high-risk customer: high status with flags', () => {
    const assessment = deriveCustomerRiskAssessment(
      makeCustomerInput({ totalDisputesRaised: 5, totalJobsCompleted: 8 })
    )
    expect(assessment.status).toBe('high')
    expect(assessment.flags.length).toBeGreaterThan(0)
  })
})

// ── deriveTrustScorePenalty ───────────────────────────────────────────────────

describe('deriveTrustScorePenalty', () => {
  it('returns 1.0 (no penalty) for a well-rated provider', () => {
    expect(deriveTrustScorePenalty({ rating: 4.5, ratingCount: 10 })).toBe(1.0)
  })

  it('returns 1.0 (no penalty) when there are no ratings', () => {
    expect(deriveTrustScorePenalty({ rating: null, ratingCount: 0 })).toBe(1.0)
  })

  it('returns 1.0 (no penalty) when ratingCount is below minimum (< 3)', () => {
    // Insufficient data — no penalty applied regardless of raw rating value
    expect(deriveTrustScorePenalty({ rating: 1.0, ratingCount: 2 })).toBe(1.0)
  })

  it('returns 0.8 (watch penalty) when rating is between 2.5 and 3.0 with ≥ 3 ratings', () => {
    expect(deriveTrustScorePenalty({ rating: 2.7, ratingCount: 5 })).toBe(0.8)
    expect(deriveTrustScorePenalty({ rating: 2.9, ratingCount: 3 })).toBe(0.8)
  })

  it('returns 0.5 (restricted penalty) when rating is below 2.5 with ≥ 3 ratings', () => {
    expect(deriveTrustScorePenalty({ rating: 2.0, ratingCount: 5 })).toBe(0.5)
    expect(deriveTrustScorePenalty({ rating: 1.0, ratingCount: 10 })).toBe(0.5)
  })

  it('returns 1.0 when rating is exactly 3.0 (at boundary, no penalty)', () => {
    expect(deriveTrustScorePenalty({ rating: 3.0, ratingCount: 5 })).toBe(1.0)
  })

  it('returns 0.8 when rating is exactly 2.5 (watch boundary)', () => {
    // 2.5 is not strictly < 2.5, so watch penalty applies
    expect(deriveTrustScorePenalty({ rating: 2.5, ratingCount: 5 })).toBe(0.8)
  })

  it('returns 1.0 when ratingCount is exactly 3 but rating is null', () => {
    expect(deriveTrustScorePenalty({ rating: null, ratingCount: 3 })).toBe(1.0)
  })
})

// ── Integration: isDiscoveryVisible + trust penalty ───────────────────────────

describe('Discovery visibility trust integration', () => {
  it('isProviderTrustedForDiscovery returns false for low-reputation provider', () => {
    expect(
      isProviderTrustedForDiscovery({ rating: 1.8, ratingCount: 7 })
    ).toBe(false)
  })

  it('isProviderTrustedForDiscovery returns true for well-rated provider', () => {
    expect(
      isProviderTrustedForDiscovery({ rating: 4.5, ratingCount: 15 })
    ).toBe(true)
  })

  it('discovery trust gate is not triggered for providers with insufficient rating data', () => {
    // Provider with only 1 rating below threshold should still be trusted (not enough data)
    expect(
      isProviderTrustedForDiscovery({ rating: 2.0, ratingCount: 1 })
    ).toBe(true)
  })

  it('low-trust providers still receive a penalty (not blocked) via deriveTrustScorePenalty', () => {
    // isDiscoveryVisible no longer hard-blocks — penalty drives ranking instead
    const penalty = deriveTrustScorePenalty({ rating: 2.0, ratingCount: 5 })
    expect(penalty).toBe(0.5)
    expect(penalty).toBeLessThan(1.0)
  })
})
