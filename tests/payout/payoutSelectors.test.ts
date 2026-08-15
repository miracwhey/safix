import { describe, it, expect } from 'vitest'
import {
  derivePayoutReadinessStatus,
  isPayoutEligible,
  getPayoutReadinessLabel,
} from '../../src/lib/payout/selectors'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

function makeAccount(
  overrides: Partial<ProviderPayoutAccount> = {},
): ProviderPayoutAccount {
  return {
    id: 'payout-acc-1',
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

describe('derivePayoutReadinessStatus', () => {
  it('returns no_account when account is null', () => {
    expect(derivePayoutReadinessStatus(null)).toBe('no_account')
  })

  it('returns no_account when stripeConnectAccountId is null', () => {
    expect(
      derivePayoutReadinessStatus(makeAccount({ stripeConnectAccountId: null })),
    ).toBe('no_account')
  })

  it('returns payout_ready when both chargesEnabled and payoutsEnabled are true', () => {
    expect(
      derivePayoutReadinessStatus(
        makeAccount({ chargesEnabled: true, payoutsEnabled: true }),
      ),
    ).toBe('payout_ready')
  })

  it('returns payout_blocked when onboarding_status is payout_blocked', () => {
    expect(
      derivePayoutReadinessStatus(
        makeAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'payout_blocked',
        }),
      ),
    ).toBe('payout_blocked')
  })

  it('returns onboarding_in_progress when status is onboarding_in_progress', () => {
    expect(
      derivePayoutReadinessStatus(
        makeAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'onboarding_in_progress',
        }),
      ),
    ).toBe('onboarding_in_progress')
  })

  it('returns onboarding_required when account exists but not yet active and status is not_started', () => {
    expect(
      derivePayoutReadinessStatus(
        makeAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'not_started',
        }),
      ),
    ).toBe('onboarding_required')
  })

  it('returns onboarding_required when charges disabled but payouts enabled', () => {
    expect(
      derivePayoutReadinessStatus(
        makeAccount({
          chargesEnabled: false,
          payoutsEnabled: true,
          onboardingStatus: 'onboarding_complete',
        }),
      ),
    ).toBe('onboarding_required')
  })
})

describe('isPayoutEligible', () => {
  it('returns true when account is payout_ready', () => {
    expect(isPayoutEligible(makeAccount({ chargesEnabled: true, payoutsEnabled: true }))).toBe(true)
  })

  it('returns false when account is null', () => {
    expect(isPayoutEligible(null)).toBe(false)
  })

  it('returns false when onboarding not complete', () => {
    expect(
      isPayoutEligible(makeAccount({ chargesEnabled: false, payoutsEnabled: false })),
    ).toBe(false)
  })

  it('returns false when payout_blocked', () => {
    expect(
      isPayoutEligible(
        makeAccount({
          chargesEnabled: false,
          payoutsEnabled: false,
          onboardingStatus: 'payout_blocked',
        }),
      ),
    ).toBe(false)
  })
})

describe('getPayoutReadinessLabel', () => {
  it('returns German label for no_account', () => {
    expect(getPayoutReadinessLabel('no_account')).toBe('Kein Konto verknüpft')
  })

  it('returns German label for onboarding_required', () => {
    expect(getPayoutReadinessLabel('onboarding_required')).toBe('Einrichtung erforderlich')
  })

  it('returns German label for onboarding_in_progress', () => {
    expect(getPayoutReadinessLabel('onboarding_in_progress')).toBe('Einrichtung läuft')
  })

  it('returns German label for payout_ready', () => {
    expect(getPayoutReadinessLabel('payout_ready')).toBe('Auszahlungen aktiv')
  })

  it('returns German label for payout_blocked', () => {
    expect(getPayoutReadinessLabel('payout_blocked')).toBe('Auszahlungen gesperrt')
  })
})
