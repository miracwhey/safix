import { describe, it, expect } from 'vitest'
import {
  deriveOnboardingProgress,
  getMissingOnboardingSteps,
  getNextOnboardingStep,
  isProviderReadyForDiscovery,
} from '../../src/lib/onboarding/selectors'
import type { CraftsmanBusinessProfile } from '../../src/lib/craftsman/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeProfile(
  overrides: Partial<CraftsmanBusinessProfile> = {},
): CraftsmanBusinessProfile {
  return {
    userId: 'user-1',
    businessName: 'Müller Bau GmbH',
    handle: 'mueller-bau',
    avatarUrl: 'https://example.com/avatar.jpg',
    bio: 'Wir bauen seit 20 Jahren.',
    location: 'Berlin',
    businessAddress: '',
    tradeCategories: ['Maurerarbeiten'],
    servicesOffered: ['Neubau', 'Renovierung'],
    serviceRadiusKm: 30,
    onboardingCompleted: true,
    taxProfile: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makePayoutAccount(
  overrides: Partial<ProviderPayoutAccount> = {},
): ProviderPayoutAccount {
  return {
    id: 'payout-1',
    providerUserId: 'user-1',
    stripeConnectAccountId: 'acct_test123',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

// ── deriveOnboardingProgress ──────────────────────────────────────────────────

describe('deriveOnboardingProgress', () => {
  describe('null profile', () => {
    it('returns 0/5 when profile is null', () => {
      const result = deriveOnboardingProgress(null, null)
      expect(result.completedCount).toBe(0)
      expect(result.totalCount).toBe(5)
      expect(result.completionPercent).toBe(0)
      expect(result.isComplete).toBe(false)
    })

    it('marks first step as next when profile is null', () => {
      const { steps } = deriveOnboardingProgress(null, null)
      expect(steps[0].status).toBe('next')
      expect(steps[0].id).toBe('business_identity')
    })

    it('marks remaining steps as incomplete when profile is null', () => {
      const { steps } = deriveOnboardingProgress(null, null)
      steps.slice(1).forEach((step) => {
        expect(step.status).toBe('incomplete')
      })
    })

    it('sets isDiscoveryBlocked to true when profile is null', () => {
      expect(deriveOnboardingProgress(null, null).isDiscoveryBlocked).toBe(true)
    })

    it('sets isProfileReady to false when profile is null', () => {
      expect(deriveOnboardingProgress(null, null).isProfileReady).toBe(false)
    })

    it('sets isPayoutReady to false when profile is null', () => {
      expect(deriveOnboardingProgress(null, null).isPayoutReady).toBe(false)
    })
  })

  describe('fully complete profile', () => {
    it('returns 5/5 when all steps are satisfied', () => {
      const result = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      expect(result.completedCount).toBe(5)
      expect(result.completionPercent).toBe(100)
      expect(result.isComplete).toBe(true)
    })

    it('sets nextStep to null when complete', () => {
      const result = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      expect(result.nextStep).toBeNull()
    })

    it('sets isDiscoveryBlocked to false when complete', () => {
      const result = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      expect(result.isDiscoveryBlocked).toBe(false)
    })

    it('sets isProfileReady to true when complete', () => {
      const result = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      expect(result.isProfileReady).toBe(true)
    })

    it('sets isPayoutReady to true when complete', () => {
      const result = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      expect(result.isPayoutReady).toBe(true)
    })

    it('marks all steps as complete', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      steps.forEach((step) => {
        expect(step.status).toBe('complete')
      })
    })
  })

  describe('profile complete, Stripe incomplete (CASE B — visibility decoupled)', () => {
    it('sets isDiscoveryBlocked to false (visible without Stripe)', () => {
      const result = deriveOnboardingProgress(makeProfile(), null)
      expect(result.isDiscoveryBlocked).toBe(false)
    })

    it('sets isProfileReady to true', () => {
      const result = deriveOnboardingProgress(makeProfile(), null)
      expect(result.isProfileReady).toBe(true)
    })

    it('sets isPayoutReady to false', () => {
      const result = deriveOnboardingProgress(makeProfile(), null)
      expect(result.isPayoutReady).toBe(false)
    })

    it('completes 4/5 steps (payout_setup is the only pending step)', () => {
      const result = deriveOnboardingProgress(makeProfile(), null)
      expect(result.completedCount).toBe(4)
      expect(result.completionPercent).toBe(80)
      expect(result.isComplete).toBe(false)
    })

    it('marks payout_setup as the next step', () => {
      const result = deriveOnboardingProgress(makeProfile(), null)
      expect(result.nextStep?.id).toBe('payout_setup')
    })

    it('marks activation as complete even without Stripe', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), null)
      const activation = steps.find((s) => s.id === 'activation')
      expect(activation?.status).toBe('complete')
    })

    it('marks payout_setup as next when Stripe has no account', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), null)
      const payout = steps.find((s) => s.id === 'payout_setup')
      expect(payout?.status).toBe('next')
    })

    it('marks payout_setup as next when charges are not enabled', () => {
      const result = deriveOnboardingProgress(
        makeProfile(),
        makePayoutAccount({ chargesEnabled: false }),
      )
      expect(result.nextStep?.id).toBe('payout_setup')
      expect(result.isProfileReady).toBe(true)
      expect(result.isPayoutReady).toBe(false)
    })

    it('marks payout_setup as next when payouts are not enabled', () => {
      const result = deriveOnboardingProgress(
        makeProfile(),
        makePayoutAccount({ payoutsEnabled: false }),
      )
      expect(result.nextStep?.id).toBe('payout_setup')
      expect(result.isProfileReady).toBe(true)
      expect(result.isPayoutReady).toBe(false)
    })
  })

  describe('business_identity stage', () => {
    it('marks business_identity as next when businessName is blank', () => {
      const { steps, nextStep } = deriveOnboardingProgress(
        makeProfile({ businessName: '' }),
        makePayoutAccount(),
      )
      expect(steps[0].status).toBe('next')
      expect(nextStep?.id).toBe('business_identity')
    })

    it('marks business_identity as next when handle is blank', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ handle: '' }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('business_identity')
    })

    it('marks business_identity as next when location is blank', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ location: '' }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('business_identity')
    })
  })

  describe('trades_services stage', () => {
    it('marks trades_services as next when tradeCategories is empty', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ tradeCategories: [] }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('trades_services')
    })

    it('marks trades_services as complete with one category', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      const step = steps.find((s) => s.id === 'trades_services')
      expect(step?.status).toBe('complete')
    })
  })

  describe('profile_trust stage', () => {
    it('marks profile_trust as next when avatarUrl is missing', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ avatarUrl: undefined }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('profile_trust')
    })

    it('marks profile_trust as next when bio is missing', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ bio: undefined }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('profile_trust')
    })

    it('marks profile_trust as next when avatarUrl is empty string', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ avatarUrl: '' }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('profile_trust')
    })
  })

  describe('payout_setup stage', () => {
    it('marks payout_setup as next when payout account is null', () => {
      const { nextStep } = deriveOnboardingProgress(makeProfile(), null)
      expect(nextStep?.id).toBe('payout_setup')
    })

    it('marks payout_setup as next when payout account has no stripe ID', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile(),
        makePayoutAccount({ stripeConnectAccountId: null }),
      )
      expect(nextStep?.id).toBe('payout_setup')
    })

    it('marks payout_setup as next when chargesEnabled is false', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile(),
        makePayoutAccount({ chargesEnabled: false }),
      )
      expect(nextStep?.id).toBe('payout_setup')
    })

    it('marks payout_setup as next when payoutsEnabled is false', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile(),
        makePayoutAccount({ payoutsEnabled: false }),
      )
      expect(nextStep?.id).toBe('payout_setup')
    })

    it('marks payout_setup as complete when charges and payouts are enabled', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      const step = steps.find((s) => s.id === 'payout_setup')
      expect(step?.status).toBe('complete')
    })
  })

  describe('activation stage', () => {
    it('marks activation as next when onboardingCompleted is false', () => {
      const { nextStep } = deriveOnboardingProgress(
        makeProfile({ onboardingCompleted: false }),
        makePayoutAccount(),
      )
      expect(nextStep?.id).toBe('activation')
    })

    it('sets isDiscoveryBlocked when activation is not complete', () => {
      const result = deriveOnboardingProgress(
        makeProfile({ onboardingCompleted: false }),
        makePayoutAccount(),
      )
      expect(result.isDiscoveryBlocked).toBe(true)
    })

    it('activation is complete when profile basics are done — does NOT require Stripe', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), null)
      const activation = steps.find((s) => s.id === 'activation')
      expect(activation?.status).toBe('complete')
    })
  })

  describe('completionPercent', () => {
    it('returns 20% when only business_identity is complete', () => {
      // All other steps are missing: tradeCategories, avatarUrl/bio, payout, activation
      const result = deriveOnboardingProgress(
        makeProfile({
          tradeCategories: [],
          avatarUrl: undefined,
          bio: undefined,
          onboardingCompleted: false,
        }),
        null,
      )
      // Only business_identity is satisfied (businessName, handle, location present)
      expect(result.completionPercent).toBe(20)
      expect(result.completedCount).toBe(1)
    })

    it('returns 40% when business_identity and trades_services are complete', () => {
      const result = deriveOnboardingProgress(
        makeProfile({
          avatarUrl: undefined,
          bio: undefined,
          onboardingCompleted: false,
        }),
        null,
      )
      expect(result.completionPercent).toBe(40)
      expect(result.completedCount).toBe(2)
    })
  })

  describe('step ordering', () => {
    it('returns steps in the canonical order', () => {
      const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
      const ids = steps.map((s) => s.id)
      expect(ids).toEqual([
        'business_identity',
        'trades_services',
        'profile_trust',
        'payout_setup',
        'activation',
      ])
    })

    it('only one step has status next at a time', () => {
      const { steps } = deriveOnboardingProgress(
        makeProfile({ avatarUrl: undefined }),
        null,
      )
      const nextSteps = steps.filter((s) => s.status === 'next')
      expect(nextSteps).toHaveLength(1)
    })
  })
})

// ── getMissingOnboardingSteps ─────────────────────────────────────────────────

describe('getMissingOnboardingSteps', () => {
  it('returns empty array when all steps are complete', () => {
    const missing = getMissingOnboardingSteps(makeProfile(), makePayoutAccount())
    expect(missing).toHaveLength(0)
  })

  it('returns all 5 steps when profile is null', () => {
    const missing = getMissingOnboardingSteps(null, null)
    expect(missing).toHaveLength(5)
  })

  it('returns only incomplete steps', () => {
    const missing = getMissingOnboardingSteps(
      makeProfile({ avatarUrl: undefined, bio: undefined, onboardingCompleted: false }),
      null,
    )
    const ids = missing.map((s) => s.id)
    expect(ids).toContain('profile_trust')
    expect(ids).toContain('payout_setup')
    expect(ids).toContain('activation')
    expect(ids).not.toContain('business_identity')
    expect(ids).not.toContain('trades_services')
  })
})

// ── getNextOnboardingStep ─────────────────────────────────────────────────────

describe('getNextOnboardingStep', () => {
  it('returns null when all steps complete', () => {
    expect(getNextOnboardingStep(makeProfile(), makePayoutAccount())).toBeNull()
  })

  it('returns the first step (business_identity) when profile is null', () => {
    const step = getNextOnboardingStep(null, null)
    expect(step).not.toBeNull()
    expect(step?.id).toBe('business_identity')
  })

  it('returns payout_setup as next when profile is complete but payout is missing', () => {
    const step = getNextOnboardingStep(makeProfile(), null)
    expect(step?.id).toBe('payout_setup')
  })

  it('returns activation as next when all steps done except activation', () => {
    const step = getNextOnboardingStep(
      makeProfile({ onboardingCompleted: false }),
      makePayoutAccount(),
    )
    expect(step?.id).toBe('activation')
  })

  it('includes a navigation path for each step', () => {
    const step = getNextOnboardingStep(makeProfile(), null)
    expect(step?.navigationPath).toBeTruthy()
  })
})

// ── isProviderReadyForDiscovery ───────────────────────────────────────────────

describe('isProviderReadyForDiscovery', () => {
  it('returns true when all steps are complete', () => {
    expect(isProviderReadyForDiscovery(makeProfile(), makePayoutAccount())).toBe(true)
  })

  it('returns false when profile is null', () => {
    expect(isProviderReadyForDiscovery(null, null)).toBe(false)
  })

  it('returns true when payout account is missing — Stripe is not required for discovery', () => {
    expect(isProviderReadyForDiscovery(makeProfile(), null)).toBe(true)
  })

  it('returns false when onboardingCompleted is false', () => {
    expect(
      isProviderReadyForDiscovery(makeProfile({ onboardingCompleted: false }), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns false when tradeCategories is empty', () => {
    expect(
      isProviderReadyForDiscovery(
        makeProfile({ tradeCategories: [] }),
        makePayoutAccount(),
      ),
    ).toBe(false)
  })

  it('returns false when businessName is blank', () => {
    expect(
      isProviderReadyForDiscovery(makeProfile({ businessName: '' }), makePayoutAccount()),
    ).toBe(false)
  })

  it('returns true when payout is blocked — Stripe does not gate discovery', () => {
    expect(
      isProviderReadyForDiscovery(
        makeProfile(),
        makePayoutAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'payout_blocked',
        }),
      ),
    ).toBe(true)
  })

  it('returns true when payout onboarding is still in progress — Stripe does not gate discovery', () => {
    expect(
      isProviderReadyForDiscovery(
        makeProfile(),
        makePayoutAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'onboarding_in_progress',
        }),
      ),
    ).toBe(true)
  })

  it('returns false when profile trust is incomplete (no avatar/bio)', () => {
    expect(
      isProviderReadyForDiscovery(
        makeProfile({ avatarUrl: undefined, bio: undefined }),
        makePayoutAccount(),
      ),
    ).toBe(false)
  })
})
