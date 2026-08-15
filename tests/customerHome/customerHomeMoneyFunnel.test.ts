/**
 * Customer-Home money funnel — 5 % / 9 % behavioral repro (Block 6).
 *
 * The redesign must never leak the 5 % merchant rate through a home route.
 * Invariants proved here:
 *   • Fee contract: merchant_brought → 5 %, everything else → 9 % (safe default).
 *   • inferCommercialOrigin NEVER returns merchant_brought for any home
 *     discovery origin — 5 % is reachable ONLY via an explicit invite
 *     relationship (the GuidedEntry invited funnel).
 *   • The NUDGE answer-card routes through project-mode search (9 %), never
 *     provider-mode (the 5 % funnel).
 *   • Route pins: the home search pill stays manual-mode and provider-free;
 *     the GuidedEntry invited path still carries mode:'provider' (5 % entry
 *     preserved after the resume-mode removal).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

import { resolveFeeRateFromOrigin } from '../../src/lib/shared/feeRate'
import { inferCommercialOrigin } from '../../src/lib/commercialAttribution/commercialAttributionService'
import { deriveCanonicalProjection } from '../../src/lib/shared/canonicalCustomerLifecycle'
import { buildCustomerAnswerCardModel } from '../../src/lib/viewmodel/customerAnswerCard'
import type { Project } from '../../src/lib/projects/projectTypes'

const NOW = 1_700_000_000_000

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1', sourceJobId: 'job-1', title: 'Bad', customer: 'Max',
    craftsman: 'Müller', location: 'Hannover', dateLabel: 'Morgen', price: '5.000 €',
    status: 'request', paymentState: 'none', category: 'Bad', messageCount: 0,
    noteCount: 0, photoCount: 0, createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

function readSrc(rel: string): string {
  return readFileSync(resolve(__dirname, '../../', rel), 'utf8')
}

describe('Fee contract — merchant 5 %, else 9 % safe default', () => {
  it('merchant_brought → 0.05', () => {
    expect(resolveFeeRateFromOrigin('merchant_brought')).toBe(0.05)
  })
  it('platform_acquired → 0.09', () => {
    expect(resolveFeeRateFromOrigin('platform_acquired')).toBe(0.09)
  })
  it('undefined / null / unknown → 0.09 (never silently discounts)', () => {
    expect(resolveFeeRateFromOrigin(undefined)).toBe(0.09)
    expect(resolveFeeRateFromOrigin(null)).toBe(0.09)
    expect(resolveFeeRateFromOrigin('unknown_pending_resolution')).toBe(0.09)
  })
})

describe('inferCommercialOrigin — home discovery never yields 5 %', () => {
  const homeOrigins: Array<'reel' | 'profile' | 'project' | 'category' | null | undefined> = [
    'reel', 'profile', 'project', 'category', null, undefined,
  ]
  for (const inquiryOrigin of homeOrigins) {
    it(`origin=${String(inquiryOrigin)} → platform_acquired (9 %), never merchant_brought`, () => {
      const { origin } = inferCommercialOrigin({ inquiryOrigin })
      expect(origin).toBe('platform_acquired')
      expect(origin).not.toBe('merchant_brought')
      expect(resolveFeeRateFromOrigin(origin)).toBe(0.09)
    })
  }
})

describe('NUDGE routes project-mode (9 %), never provider-mode (5 %)', () => {
  it('job-less project → /search { mode: project }, not provider', () => {
    const project = makeProject({ sourceJobId: '', status: 'request', paymentState: 'none' })
    const model = buildCustomerAnswerCardModel({
      project,
      canonical: deriveCanonicalProjection(project),
      sourceJob: undefined,
      disputeStatus: undefined,
      fundingStatus: undefined,
      fundingRequestId: undefined,
    })
    expect(model.tone).toBe('nudge')
    expect(model.route.to).toBe('/search')
    expect(model.route.state?.mode).toBe('project')
    expect(model.route.state?.mode).not.toBe('provider')
  })
})

describe('Route pins — funnel boundaries survive the redesign', () => {
  it('home search pill is manual-mode and provider-free', () => {
    const home = readSrc('src/screens/CustomerHomeScreen.tsx')
    expect(home).toContain("mode: 'manual'")
    expect(home).not.toContain("mode: 'provider'")
  })

  it('GuidedEntry invited path still carries mode:provider (5 % entry preserved)', () => {
    const guided = readSrc('src/components/customer/GuidedEntryCard.tsx')
    expect(guided).toContain("mode: 'provider'")
  })
})
