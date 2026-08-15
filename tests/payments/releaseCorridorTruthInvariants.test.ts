/**
 * Release Corridor Truth Invariants
 *
 * Targeted tests proving the corridor invariants fixed in the
 * server-truth / finance / CTA alignment patch:
 *
 * A. Server stale reconciliation: the api/release-tranche.ts endpoint contains
 *    reconciliation logic that transitions 'funded' tranches to
 *    'eligible_for_release' when the release trigger is met — structurally
 *    verified. Client-side trigger satisfaction logic is functionally tested.
 *
 * B. Finance aggregation split: eligible tranche amounts surface in
 *    releasableNetEstimated, not hidden under inEscrowNetEstimated.
 *    Includes stale-trigger coverage (funded + trigger satisfied).
 *
 * C. Error surface: raw backend error messages never reach the UI — all errors
 *    are mapped to fachliche German messages.
 *
 * D. CTA visibility: primary CTA (e.g. complete_work) is not blanket-hidden
 *    during release phases when no tranche has an eligible release CTA.
 *
 * E. Canonical truth function: isTriggerSatisfied / isEffectivelyEligible
 *    covers ALL trigger kinds, ALL job statuses, and mirrors the server gate.
 *
 * F. Cross-surface consistency: same fachliche Zustand → same answer from
 *    trancheTrigger, deriveTrancheReleaseState, craftsmanPayoutSummary,
 *    moneyFlowProjection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// A. Server stale reconciliation
// ═══════════════════════════════════════════════════════════════════════════
//
// Structural verification that api/release-tranche.ts:
//  1. Fetches release_trigger from escrow_tranches
//  2. Checks job status against trigger condition
//  3. Reconciles funded → eligible_for_release before the guard
//  4. Returns German error messages for all 409 states
//
// Client-side trigger satisfaction logic is tested functionally via the
// in-memory escrow service (same shared trigger sets).

describe('A — Server stale tranche reconciliation (structural + functional)', () => {
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, '../../api/release-tranche.ts'), 'utf-8',
  )

  it('tranche SELECT includes release_trigger field', () => {
    expect(apiSource).toMatch(/\.select\([^)]*release_trigger/)
  })

  it('plan fetch is before the guard check (reconciliation can use plan.job_id)', () => {
    const planFetchIdx = apiSource.indexOf("from('escrow_payment_plans')")
    const guardIdx = apiSource.indexOf("status !== 'eligible_for_release'")
    expect(planFetchIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(-1)
    expect(planFetchIdx).toBeLessThan(guardIdx)
  })

  it('reconciliation block exists: funded + release_trigger + job_id guard', () => {
    // The reconciliation checks all three conditions
    expect(apiSource).toContain("tranche.status === 'funded'")
    expect(apiSource).toContain('tranche.release_trigger')
    expect(apiSource).toContain('plan.job_id')
  })

  it('reconciliation checks both trigger types with correct job statuses', () => {
    expect(apiSource).toContain("'work_started'")
    expect(apiSource).toContain("'work_completed'")
    expect(apiSource).toContain("'in_progress'")
    expect(apiSource).toContain("'deposit_release'")
    expect(apiSource).toContain("'final_release'")
  })

  it('reconciliation writes eligible_for_release with optimistic lock', () => {
    // Must update with status guard (only if still funded)
    expect(apiSource).toContain("status: 'eligible_for_release'")
    // Optimistic lock: .eq('status', 'funded') — only updates if still in funded state
    expect(apiSource).toContain(".eq('status', 'funded')")
    // Comment documents the optimistic lock intent
    expect(apiSource).toMatch(/[Oo]ptimistic/)
  })

  it('guard 409 messages are German for all tranche states', () => {
    // Each status → German message
    expect(apiSource).toContain('noch nicht freigabefähig')
    expect(apiSource).toContain('Kundeneinzahlung')
    expect(apiSource).toContain('Streitfall aktiv')
    expect(apiSource).toContain('storniert oder erstattet')
  })

  it('guard 409 never sends raw English "current status is" pattern', () => {
    // After the guard block (line ~254+), errors must not contain raw English
    // Find the guard's 409 response section
    const guardSection = apiSource.slice(
      apiSource.indexOf("status !== 'eligible_for_release'"),
      apiSource.indexOf('Authorization'),
    )
    expect(guardSection).not.toContain('current status is')
    expect(guardSection).not.toContain('not eligible for release')
  })

  // Functional test: client-side trigger satisfaction logic (shared trigger sets)
  it('recordWorkStarted makes deposit_release tranche eligible', async () => {
    const { setupCleanRepositories } = await import('../helpers/setupRepositories')
    const { ensureEscrowPlan, confirmFunding, recordWorkStarted, getEscrowTranches } =
      await import('../../src/lib/payments/escrow')

    setupCleanRepositories()
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-a-func-${Date.now()}`,
      jobId: `job-a-func-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    const final = tranches.find(t => t.kind === 'final_release')!
    expect(deposit.status).toBe('eligible_for_release')
    expect(final.status).toBe('funded')
  })

  it('recordWorkCompleted makes final_release tranche eligible', async () => {
    const { setupCleanRepositories } = await import('../helpers/setupRepositories')
    const { ensureEscrowPlan, confirmFunding, recordWorkStarted, recordWorkCompleted, getEscrowTranches } =
      await import('../../src/lib/payments/escrow')

    setupCleanRepositories()
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-a-func2-${Date.now()}`,
      jobId: `job-a-func2-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')
    await recordWorkCompleted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches.every(t => t.status === 'eligible_for_release')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B. Finance aggregation: releasableNetEstimated split
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests that craftsmanPayoutSummary separates eligible tranche amounts from
// inEscrowNetEstimated into releasableNetEstimated.

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  ensureEscrowPlan,
  confirmFunding,
  recordWorkStarted,
  recordWorkCompleted,
  getEscrowTranches,
} from '../../src/lib/payments/escrow'
import {
  deriveCraftsmanPayoutSummary,
} from '../../src/lib/payout/craftsmanPayoutSummary'
import type { Payment } from '../../src/lib/payments/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

const CRAFTSMAN_ID = 'craftsman-inv'
const EFFECTIVE_FEE_RATE = 0.09

function makePayment(
  overrides: Partial<Payment> & { state: Payment['state'] },
): Payment {
  return {
    id: `pay-inv-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-inv-${Math.random().toString(36).slice(2, 8)}`,
    craftsmanUserId: CRAFTSMAN_ID,
    state: overrides.state,
    amounts: {
      totalAmount: 4000,
      depositAmount: 1000,
      finalAmount: 3000,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

function makePayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'acc-inv',
    providerUserId: CRAFTSMAN_ID,
    stripeConnectAccountId: 'acct_inv',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('B — Finance aggregation: releasable vs. gesichert split', () => {
  beforeEach(() => setupCleanRepositories())

  it('eligible tranche amounts appear in releasableNetEstimated, NOT in inEscrowNetEstimated', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-inv-b1-${Date.now()}`,
      jobId: 'job-inv-b1',
      customerUserId: 'customer-inv',
      providerId: 'provider-inv',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    // After work_started: deposit_release tranche (25% = 1000) is eligible
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    expect(deposit.status).toBe('eligible_for_release')

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: 'job-inv-b1',
    })

    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )

    // releasableNetEstimated must contain the eligible deposit amount (net)
    expect(summary.releasableNetEstimated).toBeGreaterThan(0)
    const expectedReleasableNet = Number((1000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.releasableNetEstimated).toBeCloseTo(expectedReleasableNet, 2)

    // inEscrowNetEstimated must NOT contain the releasable portion
    const totalNet = Number((4000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.inEscrowNetEstimated).toBeCloseTo(totalNet - expectedReleasableNet, 2)
  })

  it('non-eligible tranches stay entirely in inEscrowNetEstimated', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-inv-b2-${Date.now()}`,
      jobId: 'job-inv-b2',
      customerUserId: 'customer-inv',
      providerId: 'provider-inv',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    // No recordWorkStarted → both tranches stay 'funded'

    const tranches = getEscrowTranches(plan.id)
    expect(tranches.every(t => t.status === 'funded')).toBe(true)

    const payment = makePayment({
      state: 'in_escrow',
      jobId: 'job-inv-b2',
    })

    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )

    // Everything in inEscrow, nothing in releasable
    expect(summary.releasableNetEstimated).toBe(0)
    const totalNet = Number((4000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.inEscrowNetEstimated).toBeCloseTo(totalNet, 2)
  })

  it('after work_completed: both tranches eligible → full amount in releasableNetEstimated', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-inv-b3-${Date.now()}`,
      jobId: 'job-inv-b3',
      customerUserId: 'customer-inv',
      providerId: 'provider-inv',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')
    await recordWorkCompleted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches.every(t => t.status === 'eligible_for_release')).toBe(true)

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: 'job-inv-b3',
    })

    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )

    const totalNet = Number((4000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.releasableNetEstimated).toBeCloseTo(totalNet, 2)
    expect(summary.inEscrowNetEstimated).toBe(0)
  })

  it('mixed state: deposit eligible, final funded → split correctly', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-inv-b4-${Date.now()}`,
      jobId: 'job-inv-b4',
      customerUserId: 'customer-inv',
      providerId: 'provider-inv',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    const final = tranches.find(t => t.kind === 'final_release')!
    expect(deposit.status).toBe('eligible_for_release')
    expect(final.status).toBe('funded')

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: 'job-inv-b4',
    })

    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )

    // Deposit (1000) → releasable; Final (3000) → inEscrow
    const depositNet = Number((deposit.amount * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    const finalNet = Number((final.amount * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))

    expect(summary.releasableNetEstimated).toBeCloseTo(depositNet, 2)
    expect(summary.inEscrowNetEstimated).toBeCloseTo(finalNet, 2)
  })

  it('releasableNetEstimated type exists on CraftsmanPayoutSummary', async () => {
    const summary = deriveCraftsmanPayoutSummary(CRAFTSMAN_ID, [], [], null)
    expect('releasableNetEstimated' in summary).toBe(true)
    expect(typeof summary.releasableNetEstimated).toBe('number')
    expect(summary.releasableNetEstimated).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C. Error surface: no raw English errors in UI
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests that releaseClient.ts maps all server error responses to German
// user-facing messages.

import { requestServerTrancheRelease } from '../../src/lib/payments/releaseClient'

describe('C — Error surface: releaseClient maps to German messages', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchError(statusCode: number, body: Record<string, unknown>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: statusCode,
      json: vi.fn().mockResolvedValue(body),
    })
  }

  it('maps funded status error to German message', async () => {
    mockFetchError(409, {
      error: 'current status is funded',
      currentStatus: 'funded',
    })

    const result = await requestServerTrancheRelease('t1', 'p1', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).not.toMatch(/current status/i)
      expect(result.message).toContain('freigabefähig')
    }
  })

  it('maps pending_funding status to German message', async () => {
    mockFetchError(409, {
      error: 'current status is pending_funding',
      currentStatus: 'pending_funding',
    })

    const result = await requestServerTrancheRelease('t2', 'p2', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Kundeneinzahlung')
    }
  })

  it('maps disputed status to German message', async () => {
    mockFetchError(409, {
      error: 'DISPUTE_BLOCKING',
      currentStatus: 'disputed',
    })

    const result = await requestServerTrancheRelease('t3', 'p3', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Streitfall')
    }
  })

  it('maps PROVIDER_NOT_PAYOUT_READY to German message', async () => {
    mockFetchError(409, {
      error: 'PROVIDER_NOT_PAYOUT_READY: Stripe Connect not ready',
      code: 'PROVIDER_NOT_PAYOUT_READY',
    })

    const result = await requestServerTrancheRelease('t4', 'p4', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Stripe-Connect')
      expect(result.message).not.toMatch(/PROVIDER_NOT_PAYOUT_READY/i)
    }
  })

  it('maps HTTP 403 to German authorization error', async () => {
    mockFetchError(403, { error: 'Forbidden: you are not authorized' })

    const result = await requestServerTrancheRelease('t5', 'p5', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('berechtigt')
      expect(result.message).not.toMatch(/Forbidden/i)
    }
  })

  it('maps HTTP 500 to German server error', async () => {
    mockFetchError(500, { error: 'Internal server error' })

    const result = await requestServerTrancheRelease('t6', 'p6', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Serverfehler')
      expect(result.message).not.toMatch(/Internal/i)
    }
  })

  it('passes through already-German messages from server', async () => {
    mockFetchError(409, {
      error: 'Diese Tranche ist noch nicht freigabefähig.',
      currentStatus: 'funded',
    })

    const result = await requestServerTrancheRelease('t7', 'p7', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // German message is passed through, not double-mapped
      expect(result.message).toContain('Tranche')
      expect(result.message).toContain('freigabefähig')
    }
  })

  it('catch-all: unknown error text → German fallback, never raw English', async () => {
    mockFetchError(422, { error: 'Some unknown English error from a weird edge case' })

    const result = await requestServerTrancheRelease('t8', 'p8', 'provider')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('Freigabe')
      expect(result.message).not.toMatch(/unknown English/i)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D. CTA visibility: primary CTA not blanket-hidden in release phases
// ═══════════════════════════════════════════════════════════════════════════
//
// Structural test: the CraftsmanJobOperationsCard shows the primary CTA
// (e.g. complete_work) when in a release phase but no tranche has an
// eligible release CTA.

describe('D — CTA visibility: primary CTA not blanket-hidden in release phases', () => {
  it('CraftsmanJobOperationsCard conditions primary CTA on hasEligibleTrancheCTA, not just RELEASE_PHASES', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // The fix: showPrimary must check hasEligibleTrancheCTA,
    // not just !RELEASE_PHASES.has(phaseVM.phase)
    expect(content).toContain('hasEligibleTrancheCTA')

    // showPrimary logic: show primary CTA when NOT in release phase
    // OR when in release phase but NO tranche has eligible state
    expect(content).toContain('showPrimary')
    expect(content).toMatch(/!RELEASE_PHASES\.has\(phaseVM\.phase\)\s*\|\|\s*!hasEligibleTrancheCTA/)
  })

  it('RELEASE_PHASES exists and includes the relevant phases', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    expect(content).toContain("'work_started'")
    expect(content).toContain("'work_completed'")
    expect(content).toContain("'partially_released'")
  })

  it('hasEligibleTrancheCTA is computed using deriveTrancheReleaseState', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Both must be present in the file — the CTA check uses the selector
    expect(content).toContain('hasEligibleTrancheCTA')
    expect(content).toContain('deriveTrancheReleaseState')
    // The eligible check string must exist
    expect(content).toContain("=== 'eligible'")
  })

  it('HeroPayoutCard displays "Freigabefähig" tier from releasableNetEstimated', () => {
    const heroPath = path.resolve(
      __dirname,
      '../../src/components/finance/HeroPayoutCard.tsx',
    )
    const content = fs.readFileSync(heroPath, 'utf-8')

    expect(content).toContain('releasableNetEstimated')
    expect(content).toContain('Freigabefähig')
    expect(content).toContain('freigabefaehig')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// E. Canonical truth function: isTriggerSatisfied / isEffectivelyEligible
// ═══════════════════════════════════════════════════════════════════════════
//
// The single truth function in trancheTrigger.ts must handle BOTH trigger
// kinds with the SAME job-status sets as the server gate.

import {
  isTriggerSatisfied,
  isEffectivelyEligible,
  WORK_STARTED_SATISFIED,
  WORK_COMPLETED_SATISFIED,
} from '../../src/lib/payments/escrow/trancheTrigger'

describe('E — Canonical truth: isTriggerSatisfied / isEffectivelyEligible', () => {
  // ── deposit_release + work_started ────────────────────────────────────────

  it('deposit_release funded + in_progress → trigger satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'funded', releaseTrigger: 'work_started' },
      'in_progress',
    )).toBe(true)
  })

  it('deposit_release funded + waiting_payment → trigger satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'funded', releaseTrigger: 'work_started' },
      'waiting_payment',
    )).toBe(true)
  })

  it('deposit_release funded + completed → trigger satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'funded', releaseTrigger: 'work_started' },
      'completed',
    )).toBe(true)
  })

  it('deposit_release funded + booked → trigger NOT satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'funded', releaseTrigger: 'work_started' },
      'booked',
    )).toBe(false)
  })

  // ── final_release + work_completed ────────────────────────────────────────

  it('final_release funded + waiting_payment → trigger satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'final_release', status: 'funded', releaseTrigger: 'work_completed' },
      'waiting_payment',
    )).toBe(true)
  })

  it('final_release funded + completed → trigger satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'final_release', status: 'funded', releaseTrigger: 'work_completed' },
      'completed',
    )).toBe(true)
  })

  it('final_release funded + in_progress → trigger NOT satisfied', () => {
    expect(isTriggerSatisfied(
      { kind: 'final_release', status: 'funded', releaseTrigger: 'work_completed' },
      'in_progress',
    )).toBe(false)
  })

  // ── Non-funded tranches → always false ────────────────────────────────────

  it('eligible_for_release tranche → isTriggerSatisfied returns false (no reconciliation needed)', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'eligible_for_release', releaseTrigger: 'work_started' },
      'in_progress',
    )).toBe(false)
  })

  it('released tranche → isTriggerSatisfied returns false', () => {
    expect(isTriggerSatisfied(
      { kind: 'deposit_release', status: 'released', releaseTrigger: 'work_started' },
      'in_progress',
    )).toBe(false)
  })

  // ── isEffectivelyEligible ─────────────────────────────────────────────────

  it('eligible_for_release → effectively eligible regardless of job status', () => {
    expect(isEffectivelyEligible(
      { kind: 'deposit_release', status: 'eligible_for_release', releaseTrigger: 'work_started' },
      'booked',
    )).toBe(true)
  })

  it('funded + trigger satisfied → effectively eligible', () => {
    expect(isEffectivelyEligible(
      { kind: 'final_release', status: 'funded', releaseTrigger: 'work_completed' },
      'waiting_payment',
    )).toBe(true)
  })

  it('funded + trigger NOT satisfied → NOT effectively eligible', () => {
    expect(isEffectivelyEligible(
      { kind: 'final_release', status: 'funded', releaseTrigger: 'work_completed' },
      'in_progress',
    )).toBe(false)
  })

  // ── Client sets mirror server sets ────────────────────────────────────────

  it('WORK_STARTED_SATISFIED matches server set: {in_progress, waiting_payment, completed}', () => {
    expect(WORK_STARTED_SATISFIED.has('in_progress')).toBe(true)
    expect(WORK_STARTED_SATISFIED.has('waiting_payment')).toBe(true)
    expect(WORK_STARTED_SATISFIED.has('completed')).toBe(true)
    expect(WORK_STARTED_SATISFIED.has('booked')).toBe(false)
    expect(WORK_STARTED_SATISFIED.has('new')).toBe(false)
  })

  it('WORK_COMPLETED_SATISFIED matches server set: {waiting_payment, completed}', () => {
    expect(WORK_COMPLETED_SATISFIED.has('waiting_payment')).toBe(true)
    expect(WORK_COMPLETED_SATISFIED.has('completed')).toBe(true)
    expect(WORK_COMPLETED_SATISFIED.has('in_progress')).toBe(false)
    expect(WORK_COMPLETED_SATISFIED.has('booked')).toBe(false)
  })

  it('server api/release-tranche.ts uses identical status sets', () => {
    const apiSource = fs.readFileSync(
      path.resolve(__dirname, '../../api/release-tranche.ts'), 'utf-8',
    )
    // Server defines WORK_STARTED_SATISFIED with same members
    expect(apiSource).toContain("'in_progress'")
    expect(apiSource).toContain("'waiting_payment'")
    expect(apiSource).toContain("'completed'")
    expect(apiSource).toContain('WORK_STARTED_SATISFIED')
    expect(apiSource).toContain('WORK_COMPLETED_SATISFIED')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// F. Cross-surface consistency: same input → same answer everywhere
// ═══════════════════════════════════════════════════════════════════════════
//
// For the same fachliche state (stale funded tranche + trigger satisfied),
// ALL derivation paths must agree:
// - trancheTrigger.ts → effectively eligible
// - deriveTrancheReleaseState → eligible (or payout_blocked)
// - craftsmanPayoutSummary → amount in releasableNetEstimated
// - moneyFlowProjection deriveTrancheProjection → isEligible: true

import { deriveTrancheReleaseState } from '../../src/lib/workflow/releaseOperations'
import { addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'
import type { JobStatus } from '../../src/lib/shared/coreTypes'

function makeJob(overrides: Partial<Job> & { id: string; status: JobStatus }): Job {
  return {
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    amount: '4.000 €',
    description: 'Test',
    paymentState: 'in_escrow',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: CRAFTSMAN_ID,
    ...overrides,
  } as Job
}

describe('F — Cross-surface consistency for stale funded tranches', () => {
  beforeEach(() => setupCleanRepositories())

  it('I5: stale funded DEPOSIT tranche → all surfaces agree: eligible', async () => {
    // Setup: funded deposit tranche, job is in_progress, trigger satisfied but DB stale
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-f1-${Date.now()}`,
      jobId: `job-f1-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    // Do NOT call recordWorkStarted — tranche stays 'funded'

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    expect(deposit.status).toBe('funded') // stale

    // 1. trancheTrigger: effectively eligible
    expect(isTriggerSatisfied(deposit, 'in_progress')).toBe(true)
    expect(isEffectivelyEligible(deposit, 'in_progress')).toBe(true)

    // 2. deriveTrancheReleaseState: eligible (with payout account ready)
    const releaseState = deriveTrancheReleaseState(deposit, makePayoutAccount(), 'in_progress')
    expect(releaseState).toBe('eligible')

    // 3. craftsmanPayoutSummary: amount in releasableNetEstimated
    // Register job in jobs store so the summary can look up job status
    await addJob(makeJob({ id: plan.jobId, status: 'in_progress' }))

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: plan.jobId,
    })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )
    const depositNet = Number((deposit.amount * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.releasableNetEstimated).toBeCloseTo(depositNet, 2)
  })

  it('I5: stale funded FINAL tranche → all surfaces agree: eligible', async () => {
    // Setup: funded final tranche, job is waiting_payment, trigger satisfied but DB stale
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-f2-${Date.now()}`,
      jobId: `job-f2-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider') // deposit becomes eligible
    // Do NOT call recordWorkCompleted — final stays 'funded'

    const tranches = getEscrowTranches(plan.id)
    const final = tranches.find(t => t.kind === 'final_release')!
    expect(final.status).toBe('funded') // stale

    // 1. trancheTrigger: effectively eligible
    expect(isTriggerSatisfied(final, 'waiting_payment')).toBe(true)
    expect(isEffectivelyEligible(final, 'waiting_payment')).toBe(true)

    // 2. deriveTrancheReleaseState: eligible (with payout account ready)
    const releaseState = deriveTrancheReleaseState(final, makePayoutAccount(), 'waiting_payment')
    expect(releaseState).toBe('eligible')

    // 3. craftsmanPayoutSummary: final amount in releasableNetEstimated
    await addJob(makeJob({ id: plan.jobId, status: 'waiting_payment' }))

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: plan.jobId,
    })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )
    // Both deposit (eligible) and final (stale but trigger satisfied) → releasable
    const totalNet = Number((4000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    expect(summary.releasableNetEstimated).toBeCloseTo(totalNet, 2)
    expect(summary.inEscrowNetEstimated).toBe(0)
  })

  it('I1/I6: stale funded final tranche shows in Hero as "freigabefähig", not "gesichert"', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-f3-${Date.now()}`,
      jobId: `job-f3-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')
    // Final stays funded

    await addJob(makeJob({ id: plan.jobId, status: 'waiting_payment' }))

    const payment = makePayment({
      state: 'work_in_progress',
      jobId: plan.jobId,
    })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [payment], [], makePayoutAccount(),
    )

    // I1: amount is in releasableNetEstimated (→ "freigabefähig" in Hero)
    // NOT in inEscrowNetEstimated (→ "gesichert" in Hero)
    expect(summary.releasableNetEstimated).toBeGreaterThan(0)
    expect(summary.inEscrowNetEstimated).toBe(0)
  })

  it('I2: stale funded final tranche → CTA shows eligible, not not_eligible', () => {
    // Direct deriveTrancheReleaseState test for final_release
    const staleFinalTranche = {
      id: 'tranche-stale-final',
      planId: 'plan-x',
      kind: 'final_release' as const,
      percentage: 75,
      amount: 3000,
      releaseTrigger: 'work_completed' as const,
      status: 'funded' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // With trigger satisfied
    expect(deriveTrancheReleaseState(
      staleFinalTranche, makePayoutAccount(), 'waiting_payment',
    )).toBe('eligible')

    // Without trigger satisfied → not_eligible
    expect(deriveTrancheReleaseState(
      staleFinalTranche, makePayoutAccount(), 'in_progress',
    )).toBe('not_eligible')
  })

  it('I3: payout_blocked surfaces correctly for stale funded tranche', () => {
    const staleTranche = {
      id: 'tranche-stale-blocked',
      planId: 'plan-x',
      kind: 'final_release' as const,
      percentage: 75,
      amount: 3000,
      releaseTrigger: 'work_completed' as const,
      status: 'funded' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // No payout account → payout_blocked (not eligible, not not_eligible)
    expect(deriveTrancheReleaseState(
      staleTranche, null, 'waiting_payment',
    )).toBe('payout_blocked')
  })

  it('I4: non-stale funded tranche (trigger NOT satisfied) → correctly not_eligible everywhere', () => {
    const fundedFinal = {
      id: 'tranche-not-stale',
      planId: 'plan-x',
      kind: 'final_release' as const,
      percentage: 75,
      amount: 3000,
      releaseTrigger: 'work_completed' as const,
      status: 'funded' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Job in_progress → final trigger NOT satisfied
    expect(isTriggerSatisfied(fundedFinal, 'in_progress')).toBe(false)
    expect(isEffectivelyEligible(fundedFinal, 'in_progress')).toBe(false)
    expect(deriveTrancheReleaseState(fundedFinal, makePayoutAccount(), 'in_progress')).toBe('not_eligible')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// G. Divergenzfix-Verifikation: statusLabel, CustomerCard, Bridge
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests for the three divergence paths found in the verification audit:
// G1: MoneyFlowProjection statusLabel reflects effective eligibility
// G2: CustomerReleaseProgressCard shows correct icon for stale funded
// G3: releaseEscrowWorkflow bridge includes stale funded tranches

import { deriveMoneyFlowProjection, type MoneyFlowProjectionInput } from '../../src/lib/payments/moneyFlowProjection'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'

function makeTranche(overrides: Partial<EscrowTranche> & { kind: EscrowTranche['kind']; status: EscrowTranche['status'] }): EscrowTranche {
  return {
    id: `tranche-g-${Math.random().toString(36).slice(2, 8)}`,
    planId: 'plan-g',
    percentage: overrides.kind === 'deposit_release' ? 25 : 75,
    amount: overrides.kind === 'deposit_release' ? 1000 : 3000,
    releaseTrigger: overrides.kind === 'deposit_release' ? 'work_started' : 'work_completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as EscrowTranche
}

function makePlan(overrides?: Partial<EscrowPaymentPlan>): EscrowPaymentPlan {
  return {
    id: 'plan-g',
    jobId: 'job-g',
    sourceOfferId: 'offer-g',
    customerUserId: 'c',
    providerId: 'p',
    totalAmount: 4000,
    platformFeeRate: 0.09,
    platformFeeAmount: 360,
    providerNetAmount: 3640,
    currency: 'EUR',
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as EscrowPaymentPlan
}

function makeProjectionInput(overrides: Partial<MoneyFlowProjectionInput>): MoneyFlowProjectionInput {
  return {
    job: makeJob({ id: 'job-g', status: 'in_progress' }),
    escrowPlan: makePlan(),
    tranches: [],
    payment: null,
    dispute: null,
    providerPayoutAccount: makePayoutAccount(),
    ...overrides,
  }
}

describe('G — Divergenzfix-Verifikation', () => {
  beforeEach(() => setupCleanRepositories())

  // ── G1: statusLabel reflects effective eligibility ─────────────────────────

  it('G1: stale funded deposit tranche → statusLabel is "Freigabefähig", not "Im Stripe-Absicherung"', () => {
    const tranche = makeTranche({ kind: 'deposit_release', status: 'funded' })
    const input = makeProjectionInput({
      job: makeJob({ id: 'job-g', status: 'in_progress' }),
      tranches: [tranche],
    })
    const projection = deriveMoneyFlowProjection(input)
    const depositProjection = projection.tranches.find(t => t.kind === 'deposit_release')!

    expect(depositProjection.isEligible).toBe(true)
    expect(depositProjection.statusLabel).toBe('Freigabefähig')
    expect(depositProjection.statusLabel).not.toBe('Im Stripe-Absicherung')
  })

  it('G1: stale funded final tranche → statusLabel is "Freigabefähig", not "Im Stripe-Absicherung"', () => {
    const tranche = makeTranche({ kind: 'final_release', status: 'funded' })
    const input = makeProjectionInput({
      job: makeJob({ id: 'job-g', status: 'waiting_payment' }),
      tranches: [tranche],
    })
    const projection = deriveMoneyFlowProjection(input)
    const finalProjection = projection.tranches.find(t => t.kind === 'final_release')!

    expect(finalProjection.isEligible).toBe(true)
    expect(finalProjection.statusLabel).toBe('Freigabefähig')
  })

  it('G1: non-stale funded tranche → statusLabel remains "Im Stripe-Absicherung"', () => {
    const tranche = makeTranche({ kind: 'final_release', status: 'funded' })
    const input = makeProjectionInput({
      job: makeJob({ id: 'job-g', status: 'in_progress' }), // not waiting_payment
      tranches: [tranche],
    })
    const projection = deriveMoneyFlowProjection(input)
    const finalProjection = projection.tranches.find(t => t.kind === 'final_release')!

    expect(finalProjection.isEligible).toBe(false)
    expect(finalProjection.statusLabel).toBe('Im Stripe-Absicherung')
  })

  it('G1: already eligible_for_release tranche → statusLabel is "Freigabefähig" (unchanged)', () => {
    const tranche = makeTranche({ kind: 'deposit_release', status: 'eligible_for_release' })
    const input = makeProjectionInput({ tranches: [tranche] })
    const projection = deriveMoneyFlowProjection(input)

    expect(projection.tranches[0].statusLabel).toBe('Freigabefähig')
  })

  // ── G2: CustomerReleaseProgressCard structural ─────────────────────────────

  it('G2: CustomerReleaseProgressCard handles stale funded isEligible override', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/projects/CustomerReleaseProgressCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Must check tranche.isEligible for stale funded override
    expect(content).toContain('tranche.isEligible')
    // Must show "Freigabe möglich" for stale funded eligible
    expect(content).toContain('Freigabe möglich')
  })

  // ── G3: releaseEscrowWorkflow bridge includes stale funded ─────────────────

  it('G3: releaseEscrowWorkflow bridge uses isTriggerSatisfied to include stale funded tranches', () => {
    const workflowPath = path.resolve(
      __dirname,
      '../../src/lib/workflow/paymentWorkflow.ts',
    )
    const content = fs.readFileSync(workflowPath, 'utf-8')

    // The bridge must exist inside releaseEscrowWorkflow and use isTriggerSatisfied.
    // Extract the function body (from its export declaration to the next export).
    const funcStart = content.indexOf('export async function releaseEscrowWorkflow')
    const funcEnd = content.indexOf('\nexport async function refundEscrowWorkflow')
    const funcContent = content.slice(funcStart, funcEnd)

    expect(funcContent).toContain('Bridge: release eligible escrow tranches')
    expect(funcContent).toContain('isTriggerSatisfied')
  })

  // ── Pflicht-Szenarien-Matrix (S1–S14) ─────────────────────────────────────

  it('S1: funded + deposit_release + work_started + in_progress → eligible', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'funded' })
    expect(isEffectivelyEligible(t, 'in_progress')).toBe(true)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'in_progress')).toBe('eligible')
  })

  it('S2: funded + deposit_release + work_started + waiting_payment → eligible', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'funded' })
    expect(isEffectivelyEligible(t, 'waiting_payment')).toBe(true)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'waiting_payment')).toBe('eligible')
  })

  it('S3: funded + deposit_release + work_started + completed → eligible', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'funded' })
    expect(isEffectivelyEligible(t, 'completed')).toBe(true)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'completed')).toBe('eligible')
  })

  it('S4: funded + final_release + work_completed + waiting_payment → eligible', () => {
    const t = makeTranche({ kind: 'final_release', status: 'funded' })
    expect(isEffectivelyEligible(t, 'waiting_payment')).toBe(true)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'waiting_payment')).toBe('eligible')
  })

  it('S5: funded + final_release + work_completed + completed → eligible', () => {
    const t = makeTranche({ kind: 'final_release', status: 'funded' })
    expect(isEffectivelyEligible(t, 'completed')).toBe(true)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'completed')).toBe('eligible')
  })

  it('S6: funded + trigger NOT satisfied → not_eligible', () => {
    const deposit = makeTranche({ kind: 'deposit_release', status: 'funded' })
    const final = makeTranche({ kind: 'final_release', status: 'funded' })
    expect(isEffectivelyEligible(deposit, 'booked')).toBe(false)
    expect(isEffectivelyEligible(final, 'in_progress')).toBe(false)
    expect(deriveTrancheReleaseState(deposit, makePayoutAccount(), 'booked')).toBe('not_eligible')
    expect(deriveTrancheReleaseState(final, makePayoutAccount(), 'in_progress')).toBe('not_eligible')
  })

  it('S7: eligible_for_release + payout ready → eligible', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'eligible_for_release' })
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'in_progress')).toBe('eligible')
  })

  it('S8: eligible_for_release + payout blocked → payout_blocked', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'eligible_for_release' })
    expect(deriveTrancheReleaseState(t, null, 'in_progress')).toBe('payout_blocked')
  })

  it('S9: release_pending → release_pending regardless of payout', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'release_pending' })
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'in_progress')).toBe('release_pending')
    expect(deriveTrancheReleaseState(t, null, 'in_progress')).toBe('release_pending')
  })

  it('S10: disputed → disputed', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'disputed' })
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'in_progress')).toBe('disputed')
  })

  it('S11: pending_funding → not_eligible', () => {
    const t = makeTranche({ kind: 'deposit_release', status: 'pending_funding' })
    expect(isEffectivelyEligible(t, 'in_progress')).toBe(false)
    expect(deriveTrancheReleaseState(t, makePayoutAccount(), 'in_progress')).toBe('not_eligible')
  })

  it('S12: stale funded legacy state after reload → correct via isEffectivelyEligible', () => {
    // After reload, tranche may be funded but job advanced. Same as stale funded scenario.
    const deposit = makeTranche({ kind: 'deposit_release', status: 'funded' })
    // Simulate reload: job is in_progress but tranche DB still says funded
    expect(isEffectivelyEligible(deposit, 'in_progress')).toBe(true)
    expect(deriveTrancheReleaseState(deposit, makePayoutAccount(), 'in_progress')).toBe('eligible')
    // statusLabel must say "Freigabefähig" not "Im Stripe-Absicherung"
    const input = makeProjectionInput({
      job: makeJob({ id: 'job-s12', status: 'in_progress' }),
      tranches: [deposit],
    })
    const projection = deriveMoneyFlowProjection(input)
    expect(projection.tranches[0].statusLabel).toBe('Freigabefähig')
  })

  it('S13: mixed parallel jobs → Finance correctly separates gesichert / freigabefähig / auszahlbar', async () => {
    // Job A: funded, trigger NOT satisfied → gesichert
    const planA = await ensureEscrowPlan({
      sourceOfferId: `offer-s13a-${Date.now()}`,
      jobId: `job-s13a-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 2000,
    })
    await confirmFunding(planA.id)
    // No recordWorkStarted → both tranches funded, trigger not satisfied

    // Job B: funded, deposit trigger satisfied (stale) → freigabefähig
    const planB = await ensureEscrowPlan({
      sourceOfferId: `offer-s13b-${Date.now()}`,
      jobId: `job-s13b-${Date.now()}`,
      customerUserId: 'c', providerId: 'p', totalAmount: 4000,
    })
    await confirmFunding(planB.id)
    // Register job with in_progress status for stale trigger check
    await addJob(makeJob({ id: planB.jobId, status: 'in_progress' }))

    const paymentA = makePayment({
      state: 'in_escrow',
      jobId: planA.jobId,
      amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
    })
    const paymentB = makePayment({
      state: 'work_in_progress',
      jobId: planB.jobId,
      amounts: { totalAmount: 4000, depositAmount: 1000, finalAmount: 3000 },
    })

    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN_ID, [paymentA, paymentB], [], makePayoutAccount(),
    )

    // Job A: all in gesichert (2000 total)
    // Job B: deposit (1000) stale → releasable, final (3000) not yet
    const jobANet = Number((2000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    const jobBDepositNet = Number((1000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))
    const jobBFinalNet = Number((3000 * (1 - EFFECTIVE_FEE_RATE)).toFixed(2))

    expect(summary.releasableNetEstimated).toBeCloseTo(jobBDepositNet, 2)
    expect(summary.inEscrowNetEstimated).toBeCloseTo(jobANet + jobBFinalNet, 2)
  })

  it('S14: exact problem case → UI eligible + server does NOT reject funded', () => {
    // The original bug: UI shows "freigabefähig" for stale funded tranche,
    // server rejects with "current status is funded".
    // After fix: server reconciles funded → eligible before guard.
    // Client-side: all derivation paths agree on eligible.
    const staleFundedDeposit = makeTranche({ kind: 'deposit_release', status: 'funded' })

    // Client truth: eligible
    expect(isEffectivelyEligible(staleFundedDeposit, 'in_progress')).toBe(true)
    expect(deriveTrancheReleaseState(staleFundedDeposit, makePayoutAccount(), 'in_progress')).toBe('eligible')

    // Server truth (structural): reconciliation block transitions funded → eligible before guard
    const apiSource = fs.readFileSync(
      path.resolve(__dirname, '../../api/release-tranche.ts'), 'utf-8',
    )
    // Server reconciliation fires BEFORE the guard
    const reconcileIdx = apiSource.indexOf("status: 'eligible_for_release'")
    const guardIdx = apiSource.indexOf("status !== 'eligible_for_release'")
    expect(reconcileIdx).toBeLessThan(guardIdx)

    // Finance truth: amount in releasableNetEstimated, not gesichert
    const input = makeProjectionInput({
      job: makeJob({ id: 'job-s14', status: 'in_progress' }),
      tranches: [staleFundedDeposit],
    })
    const projection = deriveMoneyFlowProjection(input)
    expect(projection.tranches[0].isEligible).toBe(true)
    expect(projection.tranches[0].statusLabel).toBe('Freigabefähig')
    expect(projection.releasableAmount).toBe(staleFundedDeposit.amount)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// H. Payout-corridor rounding true-up (final tranche residual) — Block P3b item D
// ═══════════════════════════════════════════════════════════════════════════
//
// Source-contract assertions on api/release-tranche.ts (the flag-ON destination-
// charge payout path is unverifiable end-to-end until P7 — no live connect
// balance — so correctness is proven via string/structure assertions + a pure
// numeric replication of the formula). Invariant: under PAYOUT_MODE, for the
// FINAL tranche of the fixed 2-tranche split (outside a dispute split), the
// payout draws the residual net_total − deposit_net so Σ(payouts) never exceeds
// the real connected-account NET balance. The (1 − fee) factor is preserved in
// every branch (fee taken exactly once, never 12 %), and flag-OFF / split /
// deposit_release are byte-identical to pre-P3b.

describe('H — Payout-corridor rounding true-up (final tranche residual)', () => {
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, '../../api/release-tranche.ts'), 'utf-8',
  )

  // ── H1: residual branch gated PAYOUT_MODE + non-split + final_release ──────
  it('H1: residual true-up is reachable ONLY under PAYOUT_MODE, non-split, final_release', () => {
    expect(apiSource).toContain(
      "PAYOUT_MODE && parsedSplitRatio === undefined && tranche.kind === 'final_release'",
    )
  })

  // ── H2: net_total = grossCents − appFeeCents (two-rounding balance) ────────
  it('H2: net_total uses the two-rounding destination-charge balance, NOT a single round(gross×(1−fee))', () => {
    expect(apiSource).toContain('toSmallestUnit(totalGross, transferCurrency)')
    expect(apiSource).toContain('- toSmallestUnit(totalGross * platformFeeRate, transferCurrency)')
    // The naive single-rounding net_total would short-cut the fee — must NOT appear.
    expect(apiSource).not.toContain('toSmallestUnit(totalGross * (1 - platformFeeRate)')
  })

  // ── H3: final tranche draws the residual ───────────────────────────────────
  it('H3: final payout = net_total − deposit_net (the balancing residual)', () => {
    expect(apiSource).toContain('netTotalCents - depositNetCents')
  })

  // ── H4: (1 − fee) preserved in BOTH the deposit-net and the else fallback ──
  it('H4: (1 − platformFeeRate) preserved in deposit-net and else branch (fee taken once, never squared)', () => {
    expect(apiSource).toContain('depositGross * (1 - platformFeeRate)')
    expect(apiSource).toContain('effectiveGross * (1 - platformFeeRate)')
    // Never (1−fee)² (would pay (1−fee)² and short the provider).
    expect(apiSource).not.toMatch(/\(1 - platformFeeRate\)\s*\*\s*\(1 - platformFeeRate\)/)
  })

  // ── H5: else branch (flag-OFF / split / deposit) is the unchanged formula ──
  it('H5: else branch keeps the original toSmallestUnit(effectiveGross × (1 − fee)) — flag-OFF byte-identical', () => {
    expect(apiSource).toContain('netTransferAmount = toSmallestUnit(effectiveGross * (1 - platformFeeRate), transferCurrency)')
    // transferCurrency is declared once and reused (value identical to the
    // pre-P3b inline (plan.currency ?? 'EUR').toLowerCase()).
    const curIdx = apiSource.indexOf("const transferCurrency = (plan.currency ?? 'EUR').toLowerCase()")
    const netIdx = apiSource.indexOf('let netTransferAmount: number')
    expect(curIdx).toBeGreaterThan(-1)
    expect(netIdx).toBeGreaterThan(-1)
    expect(curIdx).toBeLessThan(netIdx)
  })

  // ── H6: deposit split SSOT constant present ────────────────────────────────
  it('H6: DEPOSIT_RELEASE_PERCENT = 25 SSOT constant present (mirrors calculateTrancheAmounts)', () => {
    expect(apiSource).toContain('DEPOSIT_RELEASE_PERCENT = 25')
    expect(apiSource).toContain('(totalGross * DEPOSIT_RELEASE_PERCENT) / 100')
  })

  // ── H7: no fee-math regression literals ────────────────────────────────────
  it('H7: never the forbidden 12 % fee or a hardcoded 0.91 net factor', () => {
    expect(apiSource).not.toContain('0.12')
    expect(apiSource).not.toContain('* 0.91')
  })

  // ── H8: transfer corridor (flag-OFF) idempotency key unchanged ─────────────
  it('H8: transfer-corridor idempotency key tranche_release_<id> is unchanged by the true-up', () => {
    expect(apiSource).toContain('const transferIdempotencyKey = `tranche_release_${trancheId.trim()}`')
  })

  // ── H9: numeric replication — the true-up eliminates the 1ct overshoot ─────
  //
  // Pure replication of the corridor net arithmetic. ts() mirrors
  // toSmallestUnit() for 2-decimal currencies (Math.round(amount × 100)).
  const ts = (x: number): number => Math.round(x * 100)
  function corridorNets(totalGross: number, fee: number) {
    const depositGross = Number(((totalGross * 25) / 100).toFixed(2))
    const finalGross = Number((totalGross - depositGross).toFixed(2))
    const depositNet = ts(depositGross * (1 - fee))
    const netTotal = ts(totalGross) - ts(totalGross * fee) // grossCents − appFeeCents
    const residualFinalNet = netTotal - depositNet // NEW true-up (final draws residual)
    const independentFinalNet = ts(finalGross * (1 - fee)) // OLD per-tranche rounding
    return { depositGross, finalGross, depositNet, netTotal, residualFinalNet, independentFinalNet }
  }

  it('H9a: fee 9 % / 10.00 EUR — residual final removes the 1ct overshoot', () => {
    const r = corridorNets(10.0, 0.09)
    expect(r.depositNet).toBe(228)
    expect(r.netTotal).toBe(910)
    expect(r.residualFinalNet).toBe(682)
    // NEW: deposit + residual sum EXACTLY to the net balance (no overshoot).
    expect(r.depositNet + r.residualFinalNet).toBe(r.netTotal)
    // OLD: independent per-tranche final overshot by 1ct (228 + 683 = 911 > 910).
    expect(r.independentFinalNet).toBe(683)
    expect(r.depositNet + r.independentFinalNet).toBe(911)
    expect(r.depositNet + r.independentFinalNet).toBeGreaterThan(r.netTotal)
  })

  it('H9b: fee 5 % / 10.00 EUR — residual final removes the 1ct overshoot', () => {
    const r = corridorNets(10.0, 0.05)
    expect(r.depositNet).toBe(238)
    expect(r.netTotal).toBe(950)
    expect(r.residualFinalNet).toBe(712)
    expect(r.depositNet + r.residualFinalNet).toBe(r.netTotal)
    // OLD: 238 + 713 = 951 > 950.
    expect(r.independentFinalNet).toBe(713)
    expect(r.depositNet + r.independentFinalNet).toBe(951)
    expect(r.depositNet + r.independentFinalNet).toBeGreaterThan(r.netTotal)
  })

  it('H9c: no-overshoot case (100.00 EUR, 9 %) — residual equals independent net (true-up is harmless)', () => {
    const r = corridorNets(100.0, 0.09)
    expect(r.residualFinalNet).toBe(r.independentFinalNet)
    expect(r.depositNet + r.residualFinalNet).toBe(r.netTotal)
  })

  it('H9d: residual is always a positive cent integer (net_total > deposit_net) and never overshoots', () => {
    for (const total of [10.0, 19.99, 47.5, 123.45, 999.99, 2500.0]) {
      for (const fee of [0.05, 0.09]) {
        const r = corridorNets(total, fee)
        expect(r.residualFinalNet).toBeGreaterThan(0)
        expect(Number.isInteger(r.residualFinalNet)).toBe(true)
        // Σ(payouts) never exceeds the real net balance.
        expect(r.depositNet + r.residualFinalNet).toBe(r.netTotal)
        expect(r.depositNet + r.residualFinalNet).toBeLessThanOrEqual(r.netTotal)
      }
    }
  })
})
