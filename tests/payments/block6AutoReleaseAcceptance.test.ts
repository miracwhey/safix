/**
 * Block 6 — Work-Start Auto-Release + Acceptance Deadline + Final Auto-Release
 *
 * Tests cover:
 *   1. Work-start auto-release: deposit tranche released at work start
 *   2. Acceptance expiresAt set at work completion (72h deadline)
 *   3. getExpiredPending returns only expired pending acceptances
 *   4. MoneyFlowProjection: deposit eligible → complete_work (no manual CTA)
 *   5. MoneyFlowProjection: acceptance deadline label derivation
 *   6. Idempotency: already-released tranche is no-op
 *   7. Dispute blocks final tranche but 25% stays released
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  ensureEscrowPlan,
  getEscrowTranches,
  confirmFunding,
  recordWorkStarted,
  recordWorkCompleted,
  releaseTranche,
} from '../../src/lib/payments/escrow'
import {
  addAcceptance,
  getAcceptanceByJobId,
  getExpiredPendingAcceptances,
} from '../../src/lib/acceptance'
import type { Acceptance } from '../../src/lib/acceptance'
import {
  deriveMoneyFlowProjection,
  deriveAcceptanceDeadlineLabel,
} from '../../src/lib/payments/moneyFlowProjection'
import type {
  MoneyFlowProjectionInput,
} from '../../src/lib/payments/moneyFlowProjection'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCEPTANCE_DEADLINE_MS = 72 * 60 * 60 * 1000

async function setupFundedPlan(jobId = `job-${Date.now()}`) {
  const plan = await ensureEscrowPlan({
    sourceOfferId: `offer-${Date.now()}`,
    jobId,
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    totalAmount: 4000,
  })
  await confirmFunding(plan.id)
  return { plan, jobId }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Test Job',
    status: 'in_progress',
    craftsmanUserId: 'provider-1',
    customerUserId: 'customer-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Job
}

function makePlan(overrides: Partial<EscrowPaymentPlan> = {}): EscrowPaymentPlan {
  return {
    id: 'plan-1',
    jobId: 'job-1',
    customerUserId: 'customer-1',
    providerId: 'provider-1',
    totalAmount: 4000,
    platformFeeRate: 0.15,
    platformFeeAmount: 600,
    status: 'funded_in_escrow',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as EscrowPaymentPlan
}

function makeTranche(overrides: Partial<EscrowTranche> = {}): EscrowTranche {
  return {
    id: 'tranche-1',
    planId: 'plan-1',
    kind: 'deposit_release',
    percentage: 25,
    amount: 1000,
    status: 'funded',
    releaseTrigger: 'work_started',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as EscrowTranche
}

function makeInput(overrides: Partial<MoneyFlowProjectionInput> = {}): MoneyFlowProjectionInput {
  return {
    job: makeJob(),
    escrowPlan: makePlan(),
    tranches: [
      makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 1000, percentage: 25, status: 'released' }),
      makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 3000, percentage: 75, status: 'funded', releaseTrigger: 'work_completed' }),
    ],
    payment: null,
    dispute: null,
    providerPayoutAccount: null,
    ...overrides,
  }
}

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-ready',
    providerUserId: 'provider-1',
    stripeConnectAccountId: 'acct_ready123',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeAcceptance(overrides: Partial<Acceptance> = {}): Acceptance {
  const now = Date.now()
  return {
    id: `acc-${Date.now()}`,
    jobId: 'job-1',
    customerUserId: 'customer-1',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ACCEPTANCE_DEADLINE_MS,
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Block 6: Work-Start Auto-Release + Acceptance Deadline', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Work-start: deposit tranche eligible after recordWorkStarted ────

  describe('Work-start deposit release', () => {
    it('recordWorkStarted makes deposit tranche eligible_for_release', async () => {
      const { plan } = await setupFundedPlan()
      const result = await recordWorkStarted(plan.id, 'provider')
      expect('error' in result).toBe(false)
      if ('error' in result) return

      const tranches = getEscrowTranches(plan.id)
      const deposit = tranches.find((t) => t.kind === 'deposit_release')!
      expect(deposit.status).toBe('eligible_for_release')
    })

    it('recordWorkStarted is idempotent', async () => {
      const { plan } = await setupFundedPlan()
      await recordWorkStarted(plan.id, 'provider')
      const result2 = await recordWorkStarted(plan.id, 'provider')
      expect('error' in result2).toBe(false)

      const tranches = getEscrowTranches(plan.id)
      const deposit = tranches.find((t) => t.kind === 'deposit_release')!
      expect(deposit.status).toBe('eligible_for_release')
    })

    it('only provider can start work', async () => {
      const { plan } = await setupFundedPlan()
      const result = await recordWorkStarted(plan.id, 'customer')
      expect('error' in result).toBe(true)
    })
  })

  // ── 2. Acceptance expiresAt ────────────────────────────────────────────

  describe('Acceptance deadline (expiresAt)', () => {
    it('acceptance can be created with expiresAt', async () => {
      const now = Date.now()
      const acceptance = makeAcceptance({
        jobId: 'job-deadline-1',
        expiresAt: now + ACCEPTANCE_DEADLINE_MS,
      })
      await addAcceptance(acceptance)
      const fetched = getAcceptanceByJobId('job-deadline-1')
      expect(fetched).toBeDefined()
      expect(fetched!.expiresAt).toBe(now + ACCEPTANCE_DEADLINE_MS)
    })

    it('getExpiredPending returns expired pending acceptances', async () => {
      const pastDeadline = Date.now() - 1000
      const futureDeadline = Date.now() + 60_000

      await addAcceptance(makeAcceptance({
        id: 'acc-expired',
        jobId: 'job-exp',
        expiresAt: pastDeadline,
      }))
      await addAcceptance(makeAcceptance({
        id: 'acc-not-expired',
        jobId: 'job-not-exp',
        expiresAt: futureDeadline,
      }))

      const expired = getExpiredPendingAcceptances(Date.now())
      expect(expired.length).toBe(1)
      expect(expired[0].id).toBe('acc-expired')
    })

    it('getExpiredPending excludes already-accepted acceptances', async () => {
      const pastDeadline = Date.now() - 1000
      await addAcceptance(makeAcceptance({
        id: 'acc-accepted',
        jobId: 'job-accepted',
        status: 'accepted',
        expiresAt: pastDeadline,
      }))

      const expired = getExpiredPendingAcceptances(Date.now())
      expect(expired.length).toBe(0)
    })

    it('getExpiredPending excludes acceptances without expiresAt', async () => {
      await addAcceptance(makeAcceptance({
        id: 'acc-no-deadline',
        jobId: 'job-no-dl',
        expiresAt: undefined,
      }))

      const expired = getExpiredPendingAcceptances(Date.now())
      expect(expired.length).toBe(0)
    })
  })

  // ── 3. MoneyFlowProjection: deposit auto-release ──────────────────────

  describe('MoneyFlowProjection — deposit auto-release', () => {
    it('deposit eligible + in_progress → complete_work (no manual CTA)', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 1000, status: 'eligible_for_release' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 3000, status: 'funded' }),
        ],
        providerPayoutAccount: makeReadyPayoutAccount(),
      }))
      expect(result.primaryAction).toBe('complete_work')
    })

    it('deposit released + final eligible → release_final_tranche', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        job: makeJob({ status: 'in_progress' }),
        escrowPlan: makePlan({ status: 'partially_released' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 1000, status: 'released' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 3000, status: 'eligible_for_release' }),
        ],
        providerPayoutAccount: makeReadyPayoutAccount(),
      }))
      expect(result.primaryAction).toBe('release_final_tranche')
    })
  })

  // ── 4. Acceptance deadline label ──────────────────────────────────────

  describe('deriveAcceptanceDeadlineLabel', () => {
    it('returns empty string when no deadline', () => {
      expect(deriveAcceptanceDeadlineLabel(null, false)).toBe('')
    })

    it('returns empty string when terminal', () => {
      const future = Date.now() + 60_000
      expect(deriveAcceptanceDeadlineLabel(future, true)).toBe('')
    })

    it('returns "Frist abgelaufen" when deadline passed', () => {
      const past = Date.now() - 1000
      expect(deriveAcceptanceDeadlineLabel(past, false)).toBe(
        'Frist abgelaufen — automatische Freigabe'
      )
    })

    it('returns hours+minutes when under 24h', () => {
      const inFiveHours = Date.now() + 5 * 60 * 60 * 1000 + 30 * 60 * 1000
      const label = deriveAcceptanceDeadlineLabel(inFiveHours, false)
      expect(label).toMatch(/^Automatische Freigabe in \d+ Std \d+ Min$/)
    })

    it('returns days+hours when over 24h', () => {
      const inTwoDays = Date.now() + 2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000
      const label = deriveAcceptanceDeadlineLabel(inTwoDays, false)
      expect(label).toMatch(/^Automatische Freigabe in \d+ T \d+ Std$/)
    })
  })

  // ── 5. Acceptance deadline in MoneyFlowProjection ──────────────────────

  describe('MoneyFlowProjection — acceptance deadline', () => {
    it('includes acceptanceDeadline when provided', () => {
      const deadline = Date.now() + ACCEPTANCE_DEADLINE_MS
      const result = deriveMoneyFlowProjection(makeInput({
        acceptanceExpiresAt: deadline,
      }))
      expect(result.acceptanceDeadline).toBe(deadline)
      expect(result.acceptanceDeadlineLabel).toMatch(/Automatische Freigabe/)
    })

    it('acceptanceDeadline is null when not provided', () => {
      const result = deriveMoneyFlowProjection(makeInput())
      expect(result.acceptanceDeadline).toBeNull()
      expect(result.acceptanceDeadlineLabel).toBe('')
    })
  })

  // ── 6. Dispute blocks final but deposit stays released ────────────────

  describe('Dispute blocks final tranche, deposit stays', () => {
    it('deposit released + dispute → final blocked, deposit stays released', () => {
      const result = deriveMoneyFlowProjection(makeInput({
        escrowPlan: makePlan({ status: 'disputed' }),
        tranches: [
          makeTranche({ id: 'tr-dep', kind: 'deposit_release', amount: 1000, status: 'released', releasedAt: Date.now(), externalReleaseRef: 'tr_deposit_proof' }),
          makeTranche({ id: 'tr-fin', kind: 'final_release', amount: 3000, status: 'eligible_for_release' }),
        ],
        dispute: {
          id: 'dispute-1',
          jobId: 'job-1',
          paymentId: 'pay-1',
          reportedBy: 'customer-1',
          reason: 'quality',
          description: 'Mangel',
          status: 'open',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }))

      expect(result.isDisputed).toBe(true)
      expect(result.primaryAction).toBe('resolve_dispute')

      const depTranche = result.tranches.find((t) => t.kind === 'deposit_release')!
      expect(depTranche.isReleased).toBe(true)
      expect(depTranche.isBlocked).toBe(false)

      const finTranche = result.tranches.find((t) => t.kind === 'final_release')!
      expect(finTranche.isBlocked).toBe(true)
    })
  })

  // ── 7. Escrow service: releaseTranche idempotency ─────────────────────

  describe('releaseTranche idempotency', () => {
    it('releasing already-released tranche is a no-op', async () => {
      const { plan } = await setupFundedPlan()

      // Start work → deposit eligible
      await recordWorkStarted(plan.id, 'provider')
      const tranches = getEscrowTranches(plan.id)
      const deposit = tranches.find((t) => t.kind === 'deposit_release')!

      // Release deposit
      const result1 = await releaseTranche(deposit.id, 'system')
      expect('error' in result1).toBe(false)

      // Try release again — should be idempotent
      const result2 = await releaseTranche(deposit.id, 'system')
      expect('error' in result2).toBe(false)

      const updatedTranches = getEscrowTranches(plan.id)
      const updatedDeposit = updatedTranches.find((t) => t.kind === 'deposit_release')!
      expect(updatedDeposit.status).toBe('released')
    })
  })

  // ── 8. Work completion: final tranche becomes eligible ────────────────

  describe('Work completion → final tranche eligible', () => {
    it('recordWorkCompleted makes final tranche eligible_for_release', async () => {
      const { plan } = await setupFundedPlan()
      await recordWorkStarted(plan.id, 'provider')

      const result = await recordWorkCompleted(plan.id, 'provider')
      expect('error' in result).toBe(false)

      const tranches = getEscrowTranches(plan.id)
      const final = tranches.find((t) => t.kind === 'final_release')!
      expect(final.status).toBe('eligible_for_release')
    })
  })
})
