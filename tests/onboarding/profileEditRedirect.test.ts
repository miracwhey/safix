/**
 * Profile Edit Redirect Logic Tests
 *
 * Validates that the profile edit redirect behavior is correct:
 * - Returning users (onboardingCompleted=true) should be redirected to /craftsman/profile
 * - New users (onboardingCompleted=false/null) should be redirected to /onboarding/craftsman-success
 *
 * This tests the pure logic (the isReturningUser flag derivation),
 * not the full React component rendering.
 */

import { describe, it, expect } from 'vitest'
import type { CraftsmanBusinessProfile } from '../../src/lib/craftsman/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/**
 * Derives the redirect destination after saving a profile.
 *
 * This mirrors the logic in CraftsmanOnboardingProfileScreen:
 * - if onboardingCompleted was true when the profile was loaded → returning user → /craftsman/profile
 * - otherwise → new user → /onboarding/craftsman-success
 */
function derivePostSaveRedirect(profile: CraftsmanBusinessProfile | null): string {
  const isReturningUser = profile?.onboardingCompleted === true
  return isReturningUser ? '/craftsman/profile' : '/onboarding/craftsman-success'
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('profile edit redirect logic', () => {
  it('returning user (onboardingCompleted=true) is redirected to /craftsman/profile', () => {
    const profile = makeProfile({ onboardingCompleted: true })
    expect(derivePostSaveRedirect(profile)).toBe('/craftsman/profile')
  })

  it('new user (onboardingCompleted=false) is redirected to /onboarding/craftsman-success', () => {
    const profile = makeProfile({ onboardingCompleted: false })
    expect(derivePostSaveRedirect(profile)).toBe('/onboarding/craftsman-success')
  })

  it('null profile is treated as new user', () => {
    expect(derivePostSaveRedirect(null)).toBe('/onboarding/craftsman-success')
  })

  it('fully complete profile gets profile redirect', () => {
    const profile = makeProfile()
    expect(derivePostSaveRedirect(profile)).toBe('/craftsman/profile')
  })

  it('profile with onboardingCompleted=true but missing fields still gets profile redirect', () => {
    // The redirect is based on returning-user status, not field completeness
    const profile = makeProfile({ onboardingCompleted: true, bio: '', avatarUrl: '' })
    expect(derivePostSaveRedirect(profile)).toBe('/craftsman/profile')
  })
})
