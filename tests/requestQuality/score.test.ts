import { describe, it, expect } from 'vitest'
import {
  computeRequestQualityScore,
  tierForScore,
  REQUEST_QUALITY_TIER_THRESHOLDS,
  type RequestQualitySignals,
} from '../../src/lib/requestQuality/score'

/** A request with nothing filled in and no enrichment wired. */
function emptySignals(overrides: Partial<RequestQualitySignals> = {}): RequestQualitySignals {
  return {
    hasCategory: false,
    description: undefined,
    hasLocation: false,
    hasBudget: false,
    hasTiming: false,
    origin: null,
    ...overrides,
  }
}

describe('computeRequestQualityScore', () => {
  it('scores a fully complete request with all enrichment present as 100 / top', () => {
    const result = computeRequestQualityScore({
      hasCategory: true,
      description: 'a'.repeat(60),
      hasLocation: true,
      hasBudget: true,
      hasTiming: true,
      origin: 'project',
      customerVerified: true,
      customerHasRealProfile: true,
      isReturningCustomer: true,
      hasStructuredProject: true,
      hasSpatialScan: true,
    })

    expect(result.breakdown.completeness).toEqual({ earned: 45, possible: 45 })
    expect(result.breakdown.intent).toEqual({ earned: 35, possible: 35 })
    expect(result.breakdown.attachments).toEqual({ earned: 20, possible: 20 })
    expect(result.score).toBe(100)
    expect(result.tier).toBe('top')
  })

  it('returns 0 / pruefen for an empty request', () => {
    const result = computeRequestQualityScore(emptySignals())
    expect(result.score).toBe(0)
    expect(result.tier).toBe('pruefen')
  })

  it('keeps a low-information emergency visible (low score, never zero-hidden)', () => {
    // Category search, nothing else — the "Heizung tropft, heute?" case.
    const result = computeRequestQualityScore(
      emptySignals({ hasCategory: true, origin: 'category' }),
    )
    expect(result.score).toBeGreaterThan(0)
    expect(result.score).toBeLessThan(REQUEST_QUALITY_TIER_THRESHOLDS.solide)
    expect(result.tier).toBe('pruefen')
  })

  describe('normalisation against known signals', () => {
    it('does not deflate the score when enrichment signals are not yet wired', () => {
      // Complete intrinsic + structured project, all three customer-enrichment
      // signals undefined and scan undefined → everything known is present → 100.
      const result = computeRequestQualityScore({
        hasCategory: true,
        description: 'a'.repeat(60),
        hasLocation: true,
        hasBudget: true,
        hasTiming: true,
        origin: 'project',
        hasStructuredProject: true,
      })
      expect(result.breakdown.intent).toEqual({ earned: 18, possible: 18 })
      expect(result.breakdown.attachments).toEqual({ earned: 8, possible: 8 })
      expect(result.score).toBe(100)
      expect(result.tier).toBe('top')
    })

    it('counts a known-absent enrichment signal against the achievable maximum', () => {
      // Same request, but scan + returning are measured and absent → score drops.
      const withUnknown = computeRequestQualityScore({
        hasCategory: true,
        description: 'a'.repeat(60),
        hasLocation: true,
        hasBudget: true,
        hasTiming: true,
        origin: 'project',
        hasStructuredProject: true,
      })
      const withKnownAbsent = computeRequestQualityScore({
        hasCategory: true,
        description: 'a'.repeat(60),
        hasLocation: true,
        hasBudget: true,
        hasTiming: true,
        origin: 'project',
        hasStructuredProject: true,
        hasSpatialScan: false,
        isReturningCustomer: false,
      })
      expect(withKnownAbsent.score).toBeLessThan(withUnknown.score)
      expect(withKnownAbsent.breakdown.attachments).toEqual({ earned: 8, possible: 20 })
      expect(withKnownAbsent.breakdown.intent.possible).toBe(23)
    })
  })

  describe('description length tiers', () => {
    const base = emptySignals({ hasCategory: true })

    it('awards no description points when absent', () => {
      expect(computeRequestQualityScore(base).breakdown.completeness.earned).toBe(5)
    })

    it('awards 8 points for a short description', () => {
      const result = computeRequestQualityScore({ ...base, description: 'kurz' })
      expect(result.breakdown.completeness.earned).toBe(5 + 8)
    })

    it('awards 15 points for a detailed description (>= 60 chars)', () => {
      const result = computeRequestQualityScore({ ...base, description: 'a'.repeat(60) })
      expect(result.breakdown.completeness.earned).toBe(5 + 15)
    })
  })

  it('ranks origins by demonstrated intent (project > category > profile > reel)', () => {
    const scoreFor = (origin: RequestQualitySignals['origin']) =>
      computeRequestQualityScore(emptySignals({ origin })).breakdown.intent.earned
    expect(scoreFor('project')).toBeGreaterThan(scoreFor('category'))
    expect(scoreFor('category')).toBeGreaterThan(scoreFor('profile'))
    expect(scoreFor('profile')).toBeGreaterThan(scoreFor('reel'))
    expect(scoreFor(null)).toBe(0)
  })

  it('keeps breakdown earned/possible consistent with the headline score', () => {
    const result = computeRequestQualityScore({
      hasCategory: true,
      description: 'kurz',
      hasLocation: true,
      hasBudget: false,
      hasTiming: true,
      origin: 'category',
      hasStructuredProject: false,
      hasSpatialScan: true,
    })
    const earned =
      result.breakdown.completeness.earned +
      result.breakdown.intent.earned +
      result.breakdown.attachments.earned
    const possible =
      result.breakdown.completeness.possible +
      result.breakdown.intent.possible +
      result.breakdown.attachments.possible
    expect(result.score).toBe(Math.round((earned / possible) * 100))
  })
})

describe('tierForScore', () => {
  it('maps boundary scores to the correct tier', () => {
    expect(tierForScore(70)).toBe('top')
    expect(tierForScore(69)).toBe('solide')
    expect(tierForScore(40)).toBe('solide')
    expect(tierForScore(39)).toBe('pruefen')
    expect(tierForScore(0)).toBe('pruefen')
  })
})
