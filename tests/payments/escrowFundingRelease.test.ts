/**
 * Escrow Funding + Release Execution — Tests
 *
 * Validates the full escrow funding and release lifecycle:
 *   1. Full-upfront escrow funding model (100% into escrow)
 *   2. 25/75 as release tranches, not customer payment split
 *   3. Persistent funding state transitions
 *   4. Persistent tranche release state transitions
 *   5. Role-safe work_started / work_completed triggers
 *   6. Idempotency of all state transitions
 *   7. Amount rounding safety
 *   8. Tranche release with plan status rollup
 *   9. Forward compatibility (external refs, idempotency keys)
 *  10. No regression to quote lifecycle
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { addConversation } from '../../src/lib/messages'
import { getOfferById } from '../../src/lib/offers'
import {
  getEscrowPlanByOfferId,
  getEscrowPlanByJobId,
  getEscrowTranches,
  ensureEscrowPlan,
  getEscrowPlanStatusLabel,
  getEscrowTrancheStatusLabel,
  calculateTrancheAmounts,
  initiateFunding,
  confirmFunding,
  failFunding,
  recordWorkStarted,
  recordWorkCompleted,
  releaseTranche,
  deriveEscrowPlanSummary,
} from '../../src/lib/payments/escrow'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ────────────────────────────────────────────────────────────────

let convCounter = 1000

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  convCounter += 1
  return {
    id: `conv-funding-${convCounter}`,
    projectId: `project_funding_${convCounter}`,
    customerName: 'Test Kunde',
    customerUserId: 'customer-funding',
    craftsmanUserId: 'craftsman-funding',
    projectTitle: 'Test Projekt',
    projectLocation: 'München',
    messages: [
      {
        id: `msg-funding-${convCounter}`,
        sender: 'user',
        text: 'Anfrage',
        sentAt: Date.now() - 60_000,
        createdAtLabel: 'Vor 1 Min',
      },
    ],
    ...overrides,
  }
}

async function createAcceptedOffer(price = '4.000 €') {
  const conv = makeConversation()
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: 'customer-funding',
    craftsmanUserId: 'craftsman-funding',
    price,
  })

  const accepted = await acceptOfferWorkflow(offer.id)
  return { conv, offer: accepted }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Full-upfront escrow funding model
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — full-upfront escrow funding model', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1000
  })

  it('accepted quote creates plan with full_upfront_escrow funding mode', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)

    expect(plan).toBeDefined()
    expect(plan!.fundingMode).toBe('full_upfront_escrow')
    expect(plan!.totalAmount).toBe(4000)
    expect(plan!.status).toBe('awaiting_customer_funding')
  })

  it('customer funds 100% of accepted amount, not just 25%', async () => {
    const { offer } = await createAcceptedOffer('2.000 €')
    const plan = getEscrowPlanByOfferId(offer.id)

    // Full amount is the funding obligation
    expect(plan!.totalAmount).toBe(2000)

    // Tranches sum to total
    const tranches = getEscrowTranches(plan!.id)
    const total = tranches.reduce((sum, t) => sum + t.amount, 0)
    expect(total).toBe(2000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. 25/75 as release tranches, not payment split
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — 25/75 is release logic, not customer payment split', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1100
  })

  it('tranches are release_trigger based, not payment-due based', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)

    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!

    expect(deposit.releaseTrigger).toBe('work_started')
    expect(deposit.percentage).toBe(25)
    expect(final.releaseTrigger).toBe('work_completed')
    expect(final.percentage).toBe(75)
  })

  it('exactly two tranches exist and sum to accepted amount', async () => {
    const { offer } = await createAcceptedOffer('3.000 €')
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)

    expect(tranches).toHaveLength(2)
    const sum = tranches.reduce((s, t) => s + t.amount, 0)
    expect(sum).toBe(3000)
  })

  it('release model is start_25_completion_75', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!
    expect(plan.releaseModel).toBe('start_25_completion_75')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Persistent funding state transitions
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — persistent funding state transitions', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1200
  })

  it('initiateFunding transitions from awaiting to funding_initiated', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    const updated = await initiateFunding(plan.id, {
      externalFundingRef: 'pi_test_123',
      fundingIdempotencyKey: 'idem_key_1',
    })

    expect(updated).toBeDefined()
    expect(updated!.status).toBe('funding_initiated')
    expect(updated!.fundingInitiatedAt).toBeDefined()
    expect(updated!.externalFundingRef).toBe('pi_test_123')
    expect(updated!.fundingIdempotencyKey).toBe('idem_key_1')
  })

  it('confirmFunding transitions to funded_in_escrow and updates tranches', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    const funded = await confirmFunding(plan.id, { externalFundingRef: 'pi_funded_456' })

    expect(funded).toBeDefined()
    expect(funded!.status).toBe('funded_in_escrow')
    expect(funded!.fundedAt).toBeDefined()
    expect(funded!.externalFundingRef).toBe('pi_funded_456')

    // All tranches should now be 'funded'
    const tranches = getEscrowTranches(plan.id)
    for (const t of tranches) {
      expect(t.status).toBe('funded')
    }
  })

  it('failFunding transitions to funding_failed', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    const failed = await failFunding(plan.id)

    expect(failed).toBeDefined()
    expect(failed!.status).toBe('funding_failed')
  })

  it('can retry funding after failure', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await failFunding(plan.id)
    const retried = await initiateFunding(plan.id)

    expect(retried).toBeDefined()
    expect(retried!.status).toBe('funding_initiated')
  })

  it('funding timestamps are persisted', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const reloaded = getEscrowPlanByOfferId(offer.id)!
    expect(reloaded.fundingInitiatedAt).toBeGreaterThan(0)
    expect(reloaded.fundedAt).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Role-safe work_started / work_completed triggers
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — role-safe execution triggers', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1300
  })

  it('provider can record work_started', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const result = await recordWorkStarted(plan.id, 'provider')
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.tranche.status).toBe('eligible_for_release')
      expect(result.tranche.eligibleAt).toBeDefined()
      expect(result.tranche.triggeredBy).toBe('provider')
    }
  })

  it('customer cannot record work_started', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const result = await recordWorkStarted(plan.id, 'customer')
    expect('error' in result).toBe(true)
  })

  it('system cannot record work_started', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const result = await recordWorkStarted(plan.id, 'system')
    expect('error' in result).toBe(true)
  })

  it('provider can record work_completed', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const result = await recordWorkCompleted(plan.id, 'provider')
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.tranche.status).toBe('eligible_for_release')
      expect(result.tranche.kind).toBe('final_release')
    }
  })

  it('customer cannot record work_completed', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    const result = await recordWorkCompleted(plan.id, 'customer')
    expect('error' in result).toBe(true)
  })

  it('cannot record work_started when plan is not funded', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    const result = await recordWorkStarted(plan.id, 'provider')
    expect('error' in result).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Tranche release with plan status rollup
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — tranche release with plan status rollup', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1400
  })

  it('customer can release an eligible tranche', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const result = await releaseTranche(deposit.id, 'customer')
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.tranche.status).toBe('released')
      expect(result.tranche.releasedAt).toBeDefined()
      expect(result.plan.status).toBe('partially_released')
    }
  })

  it('provider cannot release tranches', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const result = await releaseTranche(deposit.id, 'provider')
    expect('error' in result).toBe(true)
  })

  it('releasing all tranches sets plan to fully_released', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')
    await recordWorkCompleted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!
    const final = tranches.find((t) => t.kind === 'final_release')!

    await releaseTranche(deposit.id, 'customer')
    const result = await releaseTranche(final.id, 'customer')

    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.plan.status).toBe('fully_released')
    }
  })

  it('system can release tranches (for webhook/automated flows)', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    const result = await releaseTranche(deposit.id, 'system')
    expect('error' in result).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Idempotency of state transitions
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — idempotency of state transitions', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1500
  })

  it('repeated ensureEscrowPlan returns same plan', async () => {
    const { offer } = await createAcceptedOffer()
    const plan1 = getEscrowPlanByOfferId(offer.id)!

    const accepted = getOfferById(offer.id)!
    await ensureEscrowPlan({
      sourceOfferId: offer.id,
      jobId: accepted.createdJobId!,
      customerUserId: 'customer-funding',
      providerId: 'craftsman-funding',
      totalAmount: 4000,
    })

    const plan2 = getEscrowPlanByOfferId(offer.id)!
    expect(plan2.id).toBe(plan1.id)

    // No duplicate tranches
    const tranches = getEscrowTranches(plan1.id)
    expect(tranches).toHaveLength(2)
  })

  it('repeated initiateFunding is idempotent when already past awaiting', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    // Second initiate should no-op
    const result = await initiateFunding(plan.id)
    expect(result!.status).toBe('funded_in_escrow')
  })

  it('repeated confirmFunding is idempotent', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    const second = await confirmFunding(plan.id)

    expect(second!.status).toBe('funded_in_escrow')
  })

  it('repeated recordWorkStarted is idempotent', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)

    await recordWorkStarted(plan.id, 'provider')
    const result = await recordWorkStarted(plan.id, 'provider')
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.tranche.status).toBe('eligible_for_release')
    }
  })

  it('repeated releaseTranche is idempotent', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    await initiateFunding(plan.id)
    await confirmFunding(plan.id)
    await recordWorkStarted(plan.id, 'provider')

    const tranches = getEscrowTranches(plan.id)
    const deposit = tranches.find((t) => t.kind === 'deposit_release')!

    await releaseTranche(deposit.id, 'customer')
    const result = await releaseTranche(deposit.id, 'customer')
    expect('error' in result).toBe(false)
    if (!('error' in result)) {
      expect(result.tranche.status).toBe('released')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Amount rounding safety
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — amount rounding safety', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1600
  })

  it('calculateTrancheAmounts always sums to total', () => {
    const testAmounts = [100, 1000, 2300, 4999.99, 10000, 33.33, 777.77, 1, 0.01]

    for (const total of testAmounts) {
      const { depositAmount, finalAmount } = calculateTrancheAmounts(total)
      const sum = Number((depositAmount + finalAmount).toFixed(2))
      expect(sum).toBe(total)
    }
  })

  it('tranche amounts from accepted offer sum exactly', async () => {
    const { offer } = await createAcceptedOffer('3.333 €')
    const plan = getEscrowPlanByOfferId(offer.id)!
    const tranches = getEscrowTranches(plan.id)

    const sum = Number((tranches[0].amount + tranches[1].amount).toFixed(2))
    expect(sum).toBe(3333)
  })

  it('25% is calculated and rounded correctly', () => {
    const { depositAmount, finalAmount } = calculateTrancheAmounts(1000)
    expect(depositAmount).toBe(250)
    expect(finalAmount).toBe(750)
  })

  it('handles odd amounts without cent drift', () => {
    const { depositAmount, finalAmount } = calculateTrancheAmounts(1111.11)
    expect(depositAmount + finalAmount).toBeCloseTo(1111.11, 2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Full lifecycle — happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — full lifecycle happy path', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1700
  })

  it('complete lifecycle: accept → fund → work_started → work_completed → release', async () => {
    // 1. Accept quote
    const { offer } = await createAcceptedOffer('5.000 €')
    const plan = getEscrowPlanByOfferId(offer.id)!
    expect(plan.status).toBe('awaiting_customer_funding')

    // 2. Fund escrow
    await initiateFunding(plan.id, { externalFundingRef: 'pi_happy_path' })
    expect(getEscrowPlanByOfferId(offer.id)!.status).toBe('funding_initiated')

    await confirmFunding(plan.id)
    expect(getEscrowPlanByOfferId(offer.id)!.status).toBe('funded_in_escrow')

    // 3. Work started — release 25%
    const startResult = await recordWorkStarted(plan.id, 'provider')
    expect('error' in startResult).toBe(false)

    const depositTranche = getEscrowTranches(plan.id).find((t) => t.kind === 'deposit_release')!
    expect(depositTranche.status).toBe('eligible_for_release')
    expect(depositTranche.amount).toBe(1250)

    const depositRelease = await releaseTranche(depositTranche.id, 'customer')
    expect('error' in depositRelease).toBe(false)
    expect(getEscrowPlanByOfferId(offer.id)!.status).toBe('partially_released')

    // 4. Work completed — release 75%
    const completeResult = await recordWorkCompleted(plan.id, 'provider')
    expect('error' in completeResult).toBe(false)

    const finalTranche = getEscrowTranches(plan.id).find((t) => t.kind === 'final_release')!
    expect(finalTranche.status).toBe('eligible_for_release')
    expect(finalTranche.amount).toBe(3750)

    const finalRelease = await releaseTranche(finalTranche.id, 'customer')
    expect('error' in finalRelease).toBe(false)
    expect(getEscrowPlanByOfferId(offer.id)!.status).toBe('fully_released')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Status labels and deriveEscrowPlanSummary
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — status labels and plan summary', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1800
  })

  it('all plan status labels return non-empty strings', () => {
    const statuses = [
      'awaiting_customer_funding',
      'funding_initiated',
      'funded_in_escrow',
      'partially_released',
      'fully_released',
      'funding_failed',
      'disputed',
      'refunded',
      'cancelled',
    ] as const

    for (const s of statuses) {
      const label = getEscrowPlanStatusLabel(s)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('all tranche status labels return non-empty strings', () => {
    const statuses = [
      'pending_funding',
      'funded',
      'locked',
      'eligible_for_release',
      'release_pending',
      'released',
      'blocked',
      'disputed',
      'refunded',
      'cancelled',
    ] as const

    for (const s of statuses) {
      const label = getEscrowTrancheStatusLabel(s)
      expect(label.length).toBeGreaterThan(0)
    }
  })

  it('deriveEscrowPlanSummary returns structured plan data', async () => {
    const { offer } = await createAcceptedOffer()
    const summary = deriveEscrowPlanSummary(offer.id)

    expect(summary).toBeDefined()
    expect(summary!.plan).toBeDefined()
    expect(summary!.tranches).toHaveLength(2)
    expect(summary!.depositTranche).toBeDefined()
    expect(summary!.finalTranche).toBeDefined()
    expect(summary!.depositTranche!.kind).toBe('deposit_release')
    expect(summary!.finalTranche!.kind).toBe('final_release')
  })

  it('deriveEscrowPlanSummary returns null for unknown offer', () => {
    const summary = deriveEscrowPlanSummary('nonexistent')
    expect(summary).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. No regression to quote lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — no regression to quote lifecycle', () => {
  beforeEach(async () => {
    await setupCleanRepositories()
    convCounter = 1900
  })

  it('offer is accepted and locked after acceptance', async () => {
    const { offer } = await createAcceptedOffer()
    const reloaded = getOfferById(offer.id)!

    expect(reloaded.status).toBe('accepted')
    expect(reloaded.lockedAt).toBeDefined()
    expect(reloaded.acceptedAt).toBeDefined()
  })

  it('escrow plan links back to correct offer and job', async () => {
    const { offer } = await createAcceptedOffer()
    const accepted = getOfferById(offer.id)!
    const plan = getEscrowPlanByOfferId(offer.id)!

    expect(plan.sourceOfferId).toBe(offer.id)
    expect(plan.jobId).toBe(accepted.createdJobId)

    // Also verify lookup by job ID
    const planByJob = getEscrowPlanByJobId(accepted.createdJobId!)!
    expect(planByJob.id).toBe(plan.id)
  })

  it('external reference fields start undefined', async () => {
    const { offer } = await createAcceptedOffer()
    const plan = getEscrowPlanByOfferId(offer.id)!

    expect(plan.externalFundingRef).toBeUndefined()
    expect(plan.fundingIdempotencyKey).toBeUndefined()
    expect(plan.fundingInitiatedAt).toBeUndefined()
    expect(plan.fundedAt).toBeUndefined()

    const tranches = getEscrowTranches(plan.id)
    for (const t of tranches) {
      expect(t.eligibleAt).toBeUndefined()
      expect(t.releasedAt).toBeUndefined()
      expect(t.externalReleaseRef).toBeUndefined()
      expect(t.triggeredBy).toBeUndefined()
    }
  })
})
