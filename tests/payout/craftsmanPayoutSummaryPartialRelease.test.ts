/**
 * CraftsmanPayoutSummary — Partial Tranche Release Aggregation
 *
 * Covers Fix A: when a payment is in `release_pending` (or active escrow) and
 * one or more escrow tranches carry proof of a Stripe Transfer
 * (status='released' AND externalReleaseRef set), that portion must be lifted
 * out of the "gesichert / pending" bucket and counted in the released bucket.
 *
 * This guards the Finance hero against showing a transferred portion as
 * still in escrow after a partial release (1 of 2 tranches released).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { deriveCraftsmanPayoutSummary } from '../../src/lib/payout/craftsmanPayoutSummary'

import type { Payment } from '../../src/lib/payments/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type {
  EscrowPaymentPlan,
  EscrowTranche,
} from '../../src/lib/payments/escrow/escrowTypes'

import { InMemoryEscrowPlanRepository } from '../../src/lib/payments/escrow/InMemoryEscrowPlanRepository'
import { setEscrowPlanRepository } from '../../src/lib/payments/escrow/escrowRegistry'

const CRAFTSMAN = 'craftsman-a'
const JOB_ID = 'job-partial-release'
const PLAN_ID = 'plan-partial-release'
const PAYMENT_ID = 'pay-partial-release'

// 9 % is the safe default fee rate when no commercial origin is set.
const FEE_RATE = 0.09
const NET_RATE = 1 - FEE_RATE

function makePayment(overrides?: Partial<Payment>): Payment {
  return {
    id: PAYMENT_ID,
    jobId: JOB_ID,
    craftsmanUserId: CRAFTSMAN,
    state: 'release_pending',
    amounts: {
      totalAmount: 1000,
      depositAmount: 250,
      finalAmount: 750,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Payment
}

function makePlan(overrides?: Partial<EscrowPaymentPlan>): EscrowPaymentPlan {
  return {
    id: PLAN_ID,
    sourceOfferId: 'offer-x',
    jobId: JOB_ID,
    customerUserId: 'customer-x',
    providerId: 'provider-x',
    currency: 'EUR',
    totalAmount: 1000,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'partially_released',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeTranche(overrides: Partial<EscrowTranche> & { id: string }): EscrowTranche {
  return {
    id: overrides.id,
    planId: PLAN_ID,
    kind: 'deposit_release',
    percentage: 25,
    amount: 250,
    releaseTrigger: 'work_started',
    status: 'funded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as EscrowTranche
}

function makeReadyAccount(): ProviderPayoutAccount {
  return {
    id: 'acc-1',
    providerUserId: CRAFTSMAN,
    stripeConnectAccountId: 'acct_test',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function seedEscrow(plan: EscrowPaymentPlan, tranches: EscrowTranche[]): void {
  const repo = new InMemoryEscrowPlanRepository([plan], tranches)
  setEscrowPlanRepository(repo)
}

describe('CraftsmanPayoutSummary — Partial Tranche Release', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('release_pending payment with 1 of 4 tranches released-with-transfer-ref splits buckets correctly', () => {
    // Plan totals €1000 across 4 hypothetical tranches modelled here as 1×€250
    // released and 3 still in escrow (€750 remaining, mapped to one final
    // tranche for projection simplicity).
    seedEscrow(
      makePlan(),
      [
        makeTranche({
          id: 'tr-deposit',
          kind: 'deposit_release',
          percentage: 25,
          amount: 250,
          status: 'released',
          externalReleaseRef: 'tr_stripe_transfer_id',
          releasedAt: Date.now(),
        }),
        makeTranche({
          id: 'tr-final',
          kind: 'final_release',
          percentage: 75,
          amount: 750,
          status: 'funded',
          releaseTrigger: 'work_completed',
        }),
      ],
    )

    const payment = makePayment({ state: 'release_pending' })
    const ledger: LedgerEntry[] = []
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [payment], ledger, makeReadyAccount(),
    )

    // Released portion of €250 gross → net = 250 × 0.91 = 227.50 in eligible bucket
    expect(summary.releasedPayoutEligible).toBeCloseTo(250 * NET_RATE, 2)
    expect(summary.releasedPayoutBlocked).toBe(0)

    // Pending portion: €1000 − €250 = €750 gross → net = 750 × 0.91 = 682.50
    expect(summary.releasePendingGross).toBe(750)
    expect(summary.releasePendingNetEstimated).toBeCloseTo(750 * NET_RATE, 2)

    // Bucket sum invariant: released + pending net ≈ total net
    expect(
      summary.releasedPayoutEligible + summary.releasePendingNetEstimated,
    ).toBeCloseTo(1000 * NET_RATE, 2)

    // Fee bookkeeping: collected for transferred portion, estimated for rest
    expect(summary.platformFeeCollected).toBeCloseTo(250 * FEE_RATE, 2)
    expect(summary.platformFeeEstimated).toBeCloseTo(750 * FEE_RATE, 2)
  })

  it('release_pending without proof (released status but no externalReleaseRef) keeps full amount in pending bucket', () => {
    seedEscrow(
      makePlan(),
      [
        makeTranche({
          id: 'tr-deposit',
          kind: 'deposit_release',
          amount: 250,
          status: 'released',
          // externalReleaseRef intentionally omitted — no transfer proof
          releasedAt: Date.now(),
        }),
        makeTranche({
          id: 'tr-final',
          kind: 'final_release',
          percentage: 75,
          amount: 750,
          status: 'funded',
          releaseTrigger: 'work_completed',
        }),
      ],
    )

    const payment = makePayment({ state: 'release_pending' })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [payment], [], makeReadyAccount(),
    )

    // Without proof of transfer, nothing is lifted into the released bucket.
    expect(summary.releasedPayoutEligible).toBe(0)
    expect(summary.releasePendingGross).toBe(1000)
    expect(summary.releasePendingNetEstimated).toBeCloseTo(1000 * NET_RATE, 2)
  })

  it('release_pending with no escrow plan falls back to legacy whole-payment treatment', () => {
    // No escrow plan in repo — splitTrancheGrossByReleaseProof returns
    // releasedGross=0, so the entire payment lands in the pending bucket.
    const payment = makePayment({ state: 'release_pending' })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [payment], [], makeReadyAccount(),
    )

    expect(summary.releasedPayoutEligible).toBe(0)
    expect(summary.releasePendingGross).toBe(1000)
    expect(summary.releasePendingNetEstimated).toBeCloseTo(1000 * NET_RATE, 2)
  })

  it('release_pending with payout-blocked account routes the released portion into releasedPayoutBlocked', () => {
    seedEscrow(
      makePlan(),
      [
        makeTranche({
          id: 'tr-deposit',
          kind: 'deposit_release',
          amount: 250,
          status: 'released',
          externalReleaseRef: 'tr_proof',
          releasedAt: Date.now(),
        }),
        makeTranche({
          id: 'tr-final',
          kind: 'final_release',
          percentage: 75,
          amount: 750,
          status: 'funded',
          releaseTrigger: 'work_completed',
        }),
      ],
    )

    const blockedAccount: ProviderPayoutAccount = {
      ...makeReadyAccount(),
      payoutsEnabled: false,
      onboardingStatus: 'payout_blocked',
    }

    const payment = makePayment({ state: 'release_pending' })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [payment], [], blockedAccount,
    )

    expect(summary.releasedPayoutEligible).toBe(0)
    expect(summary.releasedPayoutBlocked).toBeCloseTo(250 * NET_RATE, 2)
    expect(summary.releasePendingNetEstimated).toBeCloseTo(750 * NET_RATE, 2)
  })

  it('active escrow (in_escrow) with one already-released tranche also lifts that portion out of inEscrow', () => {
    // Edge case: payment.state still 'in_escrow' (local sync hasn't run yet)
    // but the escrow_tranches row is already 'released' with a transfer ref.
    // The aggregator must not double-book the released portion as escrowed.
    seedEscrow(
      makePlan({ status: 'partially_released' }),
      [
        makeTranche({
          id: 'tr-deposit',
          kind: 'deposit_release',
          amount: 250,
          status: 'released',
          externalReleaseRef: 'tr_proof',
          releasedAt: Date.now(),
        }),
        makeTranche({
          id: 'tr-final',
          kind: 'final_release',
          percentage: 75,
          amount: 750,
          status: 'funded',
          releaseTrigger: 'work_completed',
        }),
      ],
    )

    const payment = makePayment({ state: 'in_escrow' })
    const summary = deriveCraftsmanPayoutSummary(
      CRAFTSMAN, [payment], [], makeReadyAccount(),
    )

    expect(summary.releasedPayoutEligible).toBeCloseTo(250 * NET_RATE, 2)
    // Remaining €750 stays in escrow (final tranche is funded but the work
    // trigger is not satisfied for an unrelated job, so it counts as
    // non-releasable escrow).
    expect(summary.inEscrowGross).toBe(750)
  })
})
