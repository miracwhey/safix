/**
 * Block 2 — Payout Trust Layer (tranche-scoped).
 *
 * Guards the craftsman-facing visibility contract for the downstream
 * bank-arrival phase. Bank outcome is tracked per Stripe Transfer id
 * (one per released tranche) so a 25 %/75 % job never overstates a
 * single tranche's arrival as "Auf deinem Konto" for the whole job.
 *
 *   released (Transfer getriggert, kein Bank-Signal)
 *     → "Zur Auszahlung übergeben"
 *   25 % completed + 75 % still released (kein Signal)
 *     → "Auszahlung läuft" (mixed state)
 *   alle released Transfers completed + Plan fully_released
 *     → "Auf deinem Konto"
 *   mindestens ein released Transfer failed
 *     → "Auszahlung fehlgeschlagen"
 *
 * Covers:
 *   1. derivePayoutOutcomesByTransfer — tranche-scoped aggregation by
 *      signal id suffix, newest-wins.
 *   2. deriveMoneyFlowProjection — payoutStatus per tranche outcome,
 *      mixed state, plan status gating, defense-in-depth.
 *   3. Notification config — payout_completed / payout_failed routing.
 */

import { describe, it, expect } from 'vitest'

import {
  deriveMoneyFlowProjection,
  type MoneyFlowProjectionInput,
  type PayoutOutcomesByTransfer,
} from '../../src/lib/payments/moneyFlowProjection'
import {
  derivePayoutOutcomesByTransfer,
  buildPayoutOutcomeSignalId,
  extractTransferRefFromPayoutSignal,
} from '../../src/lib/payments/payoutOutcomeSelectors'
import {
  isNotifiableEventType,
  getNotificationPriority,
  getNotificationRoleRelevance,
} from '../../src/lib/notifications/notificationConfig'
import type { EscrowPaymentPlan, EscrowTranche } from '../../src/lib/payments/escrow/escrowTypes'
import type { Job } from '../../src/lib/jobs/types'
import type { ProviderPayoutAccount } from '../../src/lib/payout/types'
import type { ProjectTimelineSignal } from '../../src/lib/timeline'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-payout-1',
    title: 'Badezimmer Renovierung',
    status: 'completed',
    assignedMemberIds: [],
    photoCount: 0,
    notes: [],
    activities: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    paymentState: 'released',
    ...overrides,
  } as Job
}

function makePlan(overrides: Partial<EscrowPaymentPlan> = {}): EscrowPaymentPlan {
  return {
    id: 'plan-payout-1',
    sourceOfferId: 'offer-payout-1',
    jobId: 'job-payout-1',
    customerUserId: 'customer-payout-1',
    providerId: 'provider-payout-1',
    currency: 'EUR',
    totalAmount: 2000,
    fundingMode: 'full_upfront_escrow',
    releaseModel: 'start_25_completion_75',
    status: 'fully_released',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platformFeeRate: 0.09,
    platformFeeAmount: 180,
    ...overrides,
  }
}

function makeReleasedTranche(overrides: Partial<EscrowTranche> = {}): EscrowTranche {
  return {
    id: 'tr-payout-dep',
    planId: 'plan-payout-1',
    kind: 'deposit_release',
    percentage: 25,
    amount: 500,
    releaseTrigger: 'work_started',
    status: 'released',
    externalReleaseRef: 'tr_stripe_123',
    releasedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeReadyPayoutAccount(): ProviderPayoutAccount {
  return {
    id: 'payout-acc-trust',
    providerUserId: 'provider-payout-1',
    stripeConnectAccountId: 'acct_trust',
    onboardingStatus: 'onboarding_complete',
    chargesEnabled: true,
    payoutsEnabled: true,
    onboardingCompletedAt: Date.now(),
    requirementsDue: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const TRANSFER_25 = 'tr_stripe_25pct'
const TRANSFER_75 = 'tr_stripe_75pct'

function makeInput(overrides: Partial<MoneyFlowProjectionInput> = {}): MoneyFlowProjectionInput {
  return {
    job: makeJob(),
    escrowPlan: makePlan(),
    tranches: [
      makeReleasedTranche({
        id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500,
        externalReleaseRef: TRANSFER_25,
      }),
      makeReleasedTranche({
        id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500,
        externalReleaseRef: TRANSFER_75,
      }),
    ],
    payment: null,
    dispute: null,
    providerPayoutAccount: makeReadyPayoutAccount(),
    ...overrides,
  }
}

function outcomes(
  entries: Array<[string, 'completed' | 'failed']>,
): PayoutOutcomesByTransfer {
  return new Map(entries)
}

describe('Payout Trust Layer — signal id contract', () => {
  it('build + extract round-trip', () => {
    const id = buildPayoutOutcomeSignalId('payout_completed', TRANSFER_25)
    expect(id).toBe(`timeline_payout_completed__${TRANSFER_25}`)
    expect(extractTransferRefFromPayoutSignal(id)).toBe(TRANSFER_25)
  })

  it('extract returns null for legacy signal ids without delimiter', () => {
    expect(extractTransferRefFromPayoutSignal('timeline_some_event')).toBeNull()
  })
})

describe('Payout Trust Layer — derivePayoutOutcomesByTransfer', () => {
  const jobId = 'job-payout-1'

  it('returns empty map when no payout outcome signals exist', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: 'timeline_handoff__abc', jobId, type: 'payout_handoff_initiated',
        occurredAt: 1_000,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.size).toBe(0)
  })

  it('maps payout_completed signals to their transfer id', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: buildPayoutOutcomeSignalId('payout_completed', TRANSFER_25),
        jobId, type: 'payout_completed', occurredAt: 2_000,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.get(TRANSFER_25)).toBe('completed')
    expect(map.size).toBe(1)
  })

  it('tracks both completed and failed outcomes for the same job', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: buildPayoutOutcomeSignalId('payout_completed', TRANSFER_25),
        jobId, type: 'payout_completed', occurredAt: 2_000,
      },
      {
        id: buildPayoutOutcomeSignalId('payout_failed', TRANSFER_75),
        jobId, type: 'payout_failed', occurredAt: 2_500,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.get(TRANSFER_25)).toBe('completed')
    expect(map.get(TRANSFER_75)).toBe('failed')
  })

  it('newest-wins when the same transfer has multiple outcomes (retry)', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: buildPayoutOutcomeSignalId('payout_failed', TRANSFER_25),
        jobId, type: 'payout_failed', occurredAt: 1_000,
      },
      {
        id: buildPayoutOutcomeSignalId('payout_completed', TRANSFER_25),
        jobId, type: 'payout_completed', occurredAt: 3_000,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.get(TRANSFER_25)).toBe('completed')
  })

  it('ignores signals for other jobs', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: buildPayoutOutcomeSignalId('payout_completed', TRANSFER_25),
        jobId: 'other-job', type: 'payout_completed', occurredAt: 2_000,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.size).toBe(0)
  })

  it('ignores legacy signals without transfer-id suffix', () => {
    const signals: ProjectTimelineSignal[] = [
      {
        id: 'timeline_payout_completed_legacy_no_delim',
        jobId, type: 'payout_completed', occurredAt: 2_000,
      },
    ]
    const map = derivePayoutOutcomesByTransfer(signals, jobId)
    expect(map.size).toBe(0)
  })
})

describe('Payout Trust Layer — MoneyFlowProjection payoutStatus', () => {
  it('falls back to transfer_triggered when no tranche has an outcome', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      payoutOutcomesByTransfer: outcomes([]),
    }))
    expect(result.payoutStatus).toBe('transfer_triggered')
    expect(result.payoutStatusLabel).toBe('Zur Auszahlung übergeben')
  })

  it('reports payout_completed only when all released tranches completed AND plan fully_released', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'fully_released' }),
      payoutOutcomesByTransfer: outcomes([
        [TRANSFER_25, 'completed'],
        [TRANSFER_75, 'completed'],
      ]),
    }))
    expect(result.payoutStatus).toBe('payout_completed')
    expect(result.payoutStatusLabel).toBe('Auf deinem Konto')
  })

  it('reports mixed state as payout_in_transit when only one tranche completed (plan partially_released)', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'partially_released' }),
      tranches: [
        makeReleasedTranche({
          id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500,
          externalReleaseRef: TRANSFER_25,
        }),
        makeReleasedTranche({
          id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500,
          externalReleaseRef: null,
          status: 'funded',
          releasedAt: null,
        }),
      ],
      payoutOutcomesByTransfer: outcomes([
        [TRANSFER_25, 'completed'],
      ]),
    }))
    // Only the 25 % tranche is released with a transfer — 25 % has paid
    // out to the bank, but the 75 % tranche has not even been released
    // yet, so the projection must NOT claim "Auf deinem Konto".
    expect(result.payoutStatus).toBe('payout_in_transit')
    expect(result.payoutStatusLabel).toBe('Auszahlung läuft')
  })

  it('does NOT claim payout_completed when plan is only partially_released even if the one released tranche is paid', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'partially_released' }),
      tranches: [
        makeReleasedTranche({
          id: 'tr-dep', kind: 'deposit_release', percentage: 25, amount: 500,
          externalReleaseRef: TRANSFER_25,
        }),
        makeReleasedTranche({
          id: 'tr-fin', kind: 'final_release', percentage: 75, amount: 1500,
          externalReleaseRef: null,
          status: 'funded',
          releasedAt: null,
        }),
      ],
      payoutOutcomesByTransfer: outcomes([[TRANSFER_25, 'completed']]),
    }))
    expect(result.payoutStatus).not.toBe('payout_completed')
  })

  it('reports mixed state as payout_in_transit when both tranches released but only 25 % has completed', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'fully_released' }),
      payoutOutcomesByTransfer: outcomes([
        [TRANSFER_25, 'completed'],
      ]),
    }))
    // Both transfers exist, but the 75 % payout signal hasn't arrived yet.
    expect(result.payoutStatus).toBe('payout_in_transit')
  })

  it('reports payout_failed when any released tranche outcome is failed', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'fully_released' }),
      payoutOutcomesByTransfer: outcomes([
        [TRANSFER_25, 'completed'],
        [TRANSFER_75, 'failed'],
      ]),
    }))
    expect(result.payoutStatus).toBe('payout_failed')
    expect(result.payoutStatusLabel).toBe('Auszahlung fehlgeschlagen')
  })

  it('ignores outcomes for transfer ids that do not belong to any released tranche (defense-in-depth)', () => {
    const result = deriveMoneyFlowProjection(makeInput({
      escrowPlan: makePlan({ status: 'funded_in_escrow' }),
      tranches: [
        makeReleasedTranche({
          id: 'tr-dep', kind: 'deposit_release',
          status: 'funded', externalReleaseRef: null, releasedAt: null,
        }),
        makeReleasedTranche({
          id: 'tr-fin', kind: 'final_release',
          status: 'funded', externalReleaseRef: null, releasedAt: null,
        }),
      ],
      // Stray signal from a different transfer id — no released tranche
      // carries this ref, so the outcome map must not dominate the
      // projection.
      payoutOutcomesByTransfer: outcomes([['tr_unknown_ref', 'completed']]),
    }))
    expect(result.payoutStatus).toBe('no_transfer_yet')
    expect(result.payoutStatus).not.toBe('payout_completed')
  })
})

describe('Payout Trust Layer — Notification config', () => {
  it('payout_completed is notifiable, priority=info, routed to craftsman only', () => {
    expect(isNotifiableEventType('payout_completed')).toBe(true)
    expect(getNotificationPriority('payout_completed')).toBe('info')
    const roles = getNotificationRoleRelevance('payout_completed')
    expect(roles).toContain('craftsman')
    expect(roles).not.toContain('customer')
  })

  it('payout_failed is notifiable, priority=alert, routed to craftsman + admin', () => {
    expect(isNotifiableEventType('payout_failed')).toBe(true)
    expect(getNotificationPriority('payout_failed')).toBe('alert')
    const roles = getNotificationRoleRelevance('payout_failed')
    expect(roles).toContain('craftsman')
    expect(roles).toContain('admin')
  })
})
