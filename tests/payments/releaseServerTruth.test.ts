/**
 * Release Server-Truth Cleanup Tests
 *
 * Validates that the release path is server-authoritative:
 *  1. requestServerTrancheRelease client service function exists with correct type shape
 *  2. CraftsmanJobOperationsCard no longer imports releaseEligibleTranche directly
 *  3. releaseEligibleTranche still works for server-side/test orchestration (no regression)
 *  4. Blocked reasons still surface correctly
 *  5. Partial/full release state derivation remains correct
 *  6. Tranche release state selectors remain intact
 *  7. No regression to existing release execution
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  ensureEscrowPlan,
  confirmFunding,
  getEscrowTranches,
  recordWorkStarted,
  recordWorkCompleted,
} from '../../src/lib/payments/escrow'
import {
  releaseEligibleTranche,
  deriveTrancheReleaseState,
  deriveTrancheBlockedReason,
} from '../../src/lib/workflow/releaseOperations'
import { requestServerTrancheRelease } from '../../src/lib/payments/releaseClient'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-ready',
    providerUserId: 'craftsman-srv',
    stripeConnectAccountId: 'acct_ready',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeIncompletePayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-incomplete',
    providerUserId: 'craftsman-srv',
    stripeConnectAccountId: 'acct_incomplete',
    onboardingStatus: 'onboarding_in_progress',
    chargesEnabled: false,
    payoutsEnabled: false,
    onboardingCompletedAt: null,
    requirementsDue: 'Bankverbindung',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function setupFundedPlanWithWorkStarted() {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-srv-${Date.now()}-${Math.random()}`,
    jobId: `job-srv-${Date.now()}-${Math.random()}`,
    customerUserId: 'customer-srv',
    providerId: 'provider-srv',
    totalAmount: 4000,
  })
  await confirmFunding(plan.id)
  await recordWorkStarted(plan.id, 'provider')
  const tranches = getEscrowTranches(plan.id)
  const depositTranche = tranches.find((t) => t.kind === 'deposit_release')!
  const finalTranche = tranches.find((t) => t.kind === 'final_release')!
  return { plan, depositTranche, finalTranche }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Client service function shape
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — requestServerTrancheRelease service function', () => {
  it('exists and is a function', () => {
    expect(typeof requestServerTrancheRelease).toBe('function')
  })

  it('returns a promise (async function)', () => {
    // Calling without a server will fail, but should return a Promise
    const result = requestServerTrancheRelease('fake-tranche', 'fake-plan')
    expect(result).toBeInstanceOf(Promise)
    // Suppress unhandled rejection
    result.catch(() => {})
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CraftsmanJobOperationsCard uses server API, not local releaseEligibleTranche
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — CraftsmanJobOperationsCard does not call releaseEligibleTranche directly', () => {
  it('does not import releaseEligibleTranche from releaseOperations', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Must NOT contain a direct import of releaseEligibleTranche
    expect(content).not.toMatch(/import\s+\{[^}]*releaseEligibleTranche[^}]*\}\s+from/)
    // Must NOT call releaseEligibleTranche directly
    expect(content).not.toContain('releaseEligibleTranche(')
  })

  it('routes release through releaseTrancheWorkflow (workflow layer, not direct releaseClient call)', () => {
    // The component must delegate to releaseTrancheWorkflow in paymentWorkflow.ts.
    // releaseTrancheWorkflow is the canonical orchestration entry for UI-triggered
    // releases: it enforces dispute guards, calls requestServerTrancheRelease (server
    // authoritative write), reloads the local repo, and applies local side effects.
    // The component must NOT bypass this by calling requestServerTrancheRelease directly.
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Component must use releaseTrancheWorkflow, not the raw server client directly
    expect(content).toContain('releaseTrancheWorkflow')
    expect(content).not.toContain('requestServerTrancheRelease')

    // Verify the workflow function exists in paymentWorkflow.ts and delegates
    // to the server endpoint from there
    const workflowPath = path.resolve(
      __dirname,
      '../../src/lib/workflow/paymentWorkflow.ts',
    )
    const workflowContent = fs.readFileSync(workflowPath, 'utf-8')
    expect(workflowContent).toContain('releaseTrancheWorkflow')
    expect(workflowContent).toContain('requestServerTrancheRelease')
    expect(workflowContent).toContain('applyLocalSideEffectsAfterServerRelease')
  })

  it('calls initializeEscrowPlanRepository for repo refresh operations', () => {
    const componentPath = path.resolve(
      __dirname,
      '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
    )
    const content = fs.readFileSync(componentPath, 'utf-8')

    // initializeEscrowPlanRepository is still used (e.g. for request_funding)
    expect(content).toContain('initializeEscrowPlanRepository')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. releaseEligibleTranche still works for server-side/test use (no regression)
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — releaseEligibleTranche still works for server-side orchestration', () => {
  beforeEach(() => setupCleanRepositories())

  it('releases eligible tranche with payout-ready account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const result = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tranche.status).toBe('released')
    }
  })

  it('returns idempotent success for already-released tranche', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    const second = await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data.tranche.status).toBe('released')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Blocked reasons still surface correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — blocked reasons still surface correctly', () => {
  beforeEach(() => setupCleanRepositories())

  it('deriveTrancheBlockedReason returns payout reason for incomplete account', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const reason = deriveTrancheBlockedReason(depositTranche, makeIncompletePayoutAccount())
    expect(reason).toBeTruthy()
    expect(typeof reason).toBe('string')
  })

  it('deriveTrancheBlockedReason returns null for released tranche', async () => {
    const { depositTranche, plan } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    const updated = getEscrowTranches(plan.id).find(t => t.id === depositTranche.id)
    expect(updated).toBeDefined()
    const reason = deriveTrancheBlockedReason(updated!, makeReadyPayoutAccount())
    expect(reason).toBeNull()
  })

  it('deriveTrancheBlockedReason returns not-eligible for funded tranche', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-br-${Date.now()}`,
      jobId: `job-br-${Date.now()}`,
      customerUserId: 'customer-br',
      providerId: 'provider-br',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    // Don't start work — tranche stays funded (not eligible)
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    const reason = deriveTrancheBlockedReason(deposit, makeReadyPayoutAccount())
    expect(reason).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Partial/full release state derivation remains correct
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — partial/full release state derivation', () => {
  beforeEach(() => setupCleanRepositories())

  it('single tranche released → plan is partially_released', async () => {
    const { depositTranche, plan } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    const updatedTranches = getEscrowTranches(plan.id)
    const released = updatedTranches.filter(t => t.status === 'released')
    expect(released).toHaveLength(1)
  })

  it('both tranches released → plan is fully_released', async () => {
    const { depositTranche, finalTranche, plan } = await setupFundedPlanWithWorkStarted()
    await recordWorkCompleted(plan.id, 'provider')
    const account = makeReadyPayoutAccount()
    await releaseEligibleTranche(depositTranche.id, account)
    await releaseEligibleTranche(finalTranche.id, account)
    const updatedTranches = getEscrowTranches(plan.id)
    const released = updatedTranches.filter(t => t.status === 'released')
    expect(released).toHaveLength(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Tranche release state selectors remain intact
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — tranche release state selectors', () => {
  beforeEach(() => setupCleanRepositories())

  it('eligible tranche with ready account → eligible', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeReadyPayoutAccount())
    expect(state).toBe('eligible')
  })

  it('eligible tranche with incomplete account → payout_blocked', async () => {
    const { depositTranche } = await setupFundedPlanWithWorkStarted()
    const state = deriveTrancheReleaseState(depositTranche, makeIncompletePayoutAccount())
    expect(state).toBe('payout_blocked')
  })

  it('released tranche → released', async () => {
    const { depositTranche, plan } = await setupFundedPlanWithWorkStarted()
    await releaseEligibleTranche(depositTranche.id, makeReadyPayoutAccount())
    const updated = getEscrowTranches(plan.id).find(t => t.id === depositTranche.id)
    expect(updated).toBeDefined()
    const state = deriveTrancheReleaseState(updated!, makeReadyPayoutAccount())
    expect(state).toBe('released')
  })

  it('funded tranche (not yet eligible) → not_eligible', async () => {
    const plan = await ensureEscrowPlan({
      sourceOfferId: `offer-sel-${Date.now()}`,
      jobId: `job-sel-${Date.now()}`,
      customerUserId: 'customer-sel',
      providerId: 'provider-sel',
      totalAmount: 4000,
    })
    await confirmFunding(plan.id)
    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find(t => t.kind === 'deposit_release')!
    const state = deriveTrancheReleaseState(deposit, makeReadyPayoutAccount())
    expect(state).toBe('not_eligible')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. api/release-tranche.ts supports dual auth
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — api/release-tranche.ts supports dual auth', () => {
  it('API endpoint imports authenticateRequest for client auth', () => {
    const apiPath = path.resolve(__dirname, '../../api/release-tranche.ts')
    const content = fs.readFileSync(apiPath, 'utf-8')

    expect(content).toContain('authenticateRequest')
    expect(content).toContain('Authorization')
  })

  it('API endpoint still supports server secret auth', () => {
    const apiPath = path.resolve(__dirname, '../../api/release-tranche.ts')
    const content = fs.readFileSync(apiPath, 'utf-8')

    expect(content).toContain('RELEASE_CONFIRM_SECRET')
    expect(content).toContain('x-release-confirm-secret')
  })
})
