import { describe, it, expect } from 'vitest'
import {
  deriveOnboardingProgress,
  getNextOnboardingStep,
} from '../../src/lib/onboarding/selectors'
import type { CraftsmanBusinessProfile } from '../../src/lib/craftsman/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProfile(
  overrides: Partial<CraftsmanBusinessProfile> = {},
): CraftsmanBusinessProfile {
  return {
    userId: 'user-1',
    businessName: 'Müller Bau GmbH',
    handle: '@mueller-bau',
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

// ── Navigation paths ─────────────────────────────────────────────────────────

describe('onboarding step navigation paths', () => {
  it('business_identity navigates to /onboarding/craftsman-profile', () => {
    const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
    const step = steps.find((s) => s.id === 'business_identity')
    expect(step?.navigationPath).toBe('/onboarding/craftsman-profile')
  })

  it('trades_services navigates to /onboarding/craftsman-profile', () => {
    const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
    const step = steps.find((s) => s.id === 'trades_services')
    expect(step?.navigationPath).toBe('/onboarding/craftsman-profile')
  })

  it('profile_trust navigates to /craftsman/profile where avatar upload is available', () => {
    const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
    const step = steps.find((s) => s.id === 'profile_trust')
    expect(step?.navigationPath).toBe('/craftsman/profile')
  })

  it('payout_setup navigates to /craftsman/finance', () => {
    const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
    const step = steps.find((s) => s.id === 'payout_setup')
    expect(step?.navigationPath).toBe('/craftsman/finance')
  })

  it('activation navigates to /onboarding/craftsman-profile', () => {
    const { steps } = deriveOnboardingProgress(makeProfile(), makePayoutAccount())
    const step = steps.find((s) => s.id === 'activation')
    expect(step?.navigationPath).toBe('/onboarding/craftsman-profile')
  })

  it('profile_trust next step points to /craftsman/profile when avatar is missing', () => {
    const step = getNextOnboardingStep(
      makeProfile({ avatarUrl: undefined }),
      makePayoutAccount(),
    )
    expect(step?.id).toBe('profile_trust')
    expect(step?.navigationPath).toBe('/craftsman/profile')
  })

  it('profile_trust next step points to /craftsman/profile when bio is missing', () => {
    const step = getNextOnboardingStep(
      makeProfile({ bio: '' }),
      makePayoutAccount(),
    )
    expect(step?.id).toBe('profile_trust')
    expect(step?.navigationPath).toBe('/craftsman/profile')
  })

  it('all steps have defined navigation paths', () => {
    const { steps } = deriveOnboardingProgress(null, null)
    for (const step of steps) {
      expect(step.navigationPath).toBeTruthy()
      expect(step.navigationPath.startsWith('/')).toBe(true)
    }
  })
})
