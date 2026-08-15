import { describe, it, expect } from 'vitest'
import {
  deriveDiscoveryReadiness,
  isDiscoveryVisible,
} from '../../src/lib/discovery/discoverySelectors'
import type { DiscoveryProvider } from '../../src/lib/discovery/discoveryTypes'

/** Build a fully-ready provider, then allow individual fields to be overridden */
function makeProvider(overrides: Partial<DiscoveryProvider> = {}): DiscoveryProvider {
  return {
    id: 'provider-1',
    profileId: 'profile-1',
    companyName: 'Muster GmbH',
    displayName: 'Max Muster',
    description: 'Ihr zuverlässiger Handwerker.',
    city: 'Berlin',
    tradeCategories: ['Sanitär'],
    avatarUrl: null,
    rating: 4.8,
    ratingCount: 10,
    verified: true,
    isPublic: true,
    onboardingDone: true,
    craftsmanRole: 'craftsman',
    isOperator: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('Discovery Selectors', () => {
  // -------------------------------------------------------------------------
  // deriveDiscoveryReadiness – happy path
  // -------------------------------------------------------------------------
  describe('deriveDiscoveryReadiness – complete provider', () => {
    it('returns isReady = true and no missing fields for a fully-complete provider', () => {
      const result = deriveDiscoveryReadiness(makeProvider())
      expect(result.isReady).toBe(true)
      expect(result.missingFields).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // deriveDiscoveryReadiness – individual field failures
  // -------------------------------------------------------------------------
  describe('deriveDiscoveryReadiness – missing companyName', () => {
    it('returns isReady = false when companyName is empty string', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ companyName: '' }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Betriebsname fehlt')
    })

    it('returns isReady = false when companyName is whitespace only', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ companyName: '   ' }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Betriebsname fehlt')
    })
  })

  describe('deriveDiscoveryReadiness – missing city', () => {
    it('returns isReady = false when city is null', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ city: null }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Standort fehlt')
    })

    it('returns isReady = false when city is empty string', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ city: '' }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Standort fehlt')
    })
  })

  describe('deriveDiscoveryReadiness – missing tradeCategories', () => {
    it('returns isReady = false when tradeCategories is empty', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ tradeCategories: [] }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Gewerke fehlen')
    })
  })

  describe('deriveDiscoveryReadiness – isPublic = false', () => {
    it('returns isReady = false when provider has not opted into public visibility', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ isPublic: false }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Profil nicht öffentlich')
    })
  })

  describe('deriveDiscoveryReadiness – onboardingDone = false', () => {
    it('returns isReady = false when onboarding is incomplete', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ onboardingDone: false }))
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toContain('Onboarding nicht abgeschlossen')
    })
  })

  // -------------------------------------------------------------------------
  // deriveDiscoveryReadiness – multiple missing fields
  // -------------------------------------------------------------------------
  describe('deriveDiscoveryReadiness – multiple missing fields', () => {
    it('reports all missing fields when provider is completely blank', () => {
      const result = deriveDiscoveryReadiness(
        makeProvider({
          companyName: '',
          city: null,
          tradeCategories: [],
          isPublic: false,
          onboardingDone: false,
        })
      )
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toHaveLength(5)
    })

    it('reports exactly two fields when city and onboarding are missing', () => {
      const result = deriveDiscoveryReadiness(
        makeProvider({ city: null, onboardingDone: false })
      )
      expect(result.isReady).toBe(false)
      expect(result.missingFields).toHaveLength(2)
    })

    it('Operator-Account löst KEINE Readiness-Lücke aus (Operator-Handwerker sind valide Persona)', () => {
      const result = deriveDiscoveryReadiness(makeProvider({ isOperator: true }))
      expect(result.isReady).toBe(true)
      expect(result.missingFields).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // isDiscoveryVisible — Block 1: Pass-Through. Hartes Sichtbarkeits-Gate
  // läuft über die DB-View `visible_discovery_providers`. Alles, was die View
  // ausliefert, wird Customer-seitig gerendert (mit Soft-Penalty/Badge).
  // -------------------------------------------------------------------------
  describe('isDiscoveryVisible (Pass-Through ab Block 1)', () => {
    it('returns true for a fully-complete provider', () => {
      expect(isDiscoveryVisible(makeProvider())).toBe(true)
    })

    it('returns true even when companyName is missing — Soft-Penalty + Badge in UI', () => {
      expect(isDiscoveryVisible(makeProvider({ companyName: '' }))).toBe(true)
    })

    it('returns true even when city is missing — Soft-Penalty + Badge in UI', () => {
      expect(isDiscoveryVisible(makeProvider({ city: null }))).toBe(true)
    })

    it('returns true even when tradeCategories is empty', () => {
      expect(isDiscoveryVisible(makeProvider({ tradeCategories: [] }))).toBe(true)
    })

    it('returns true for an Operator-Handwerker', () => {
      expect(isDiscoveryVisible(makeProvider({ isOperator: true }))).toBe(true)
    })

    it('returns true even when isPublic = false (DB-View wäre das hartes Gate, JS bleibt Pass-Through)', () => {
      expect(isDiscoveryVisible(makeProvider({ isPublic: false }))).toBe(true)
    })

    it('returns true for a provider with critically low rating', () => {
      expect(
        isDiscoveryVisible(makeProvider({ rating: 2.0, ratingCount: 5 }))
      ).toBe(true)
    })

    it('returns true for a provider with no ratings yet', () => {
      expect(
        isDiscoveryVisible(makeProvider({ rating: null, ratingCount: 0 }))
      ).toBe(true)
    })

    it('Pass-Through über bunte Provider-Liste', () => {
      const providers = [
        makeProvider({ id: 'p1' }),
        makeProvider({ id: 'p2', isPublic: false }),
        makeProvider({ id: 'p3', onboardingDone: false }),
        makeProvider({ id: 'p4', city: null }),
        makeProvider({ id: 'p5', tradeCategories: [] }),
        makeProvider({ id: 'p6', companyName: '' }),
        makeProvider({ id: 'p7', isOperator: true }),
      ]
      const visible = providers.filter(isDiscoveryVisible)
      expect(visible.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
    })
  })
})
