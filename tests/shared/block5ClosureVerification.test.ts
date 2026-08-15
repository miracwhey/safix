/**
 * Block 5: Closure Verification — Payment Provider + Reconciliation Hardening.
 *
 * This file provides targeted proof tests for each of the 11 Block 5 closure
 * criteria.  Tests are organized by:
 *   - Idempotency / replay safety
 *   - Reconciliation consistency
 *   - Partial failure recovery
 *   - Downstream alignment
 *   - Observability / operator recovery
 *
 * All tests use in-memory repositories (no external services).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createPaymentForJob,
  getPaymentForJob,
  updatePaymentState,
} from '../../src/lib/payments/service'
import { getJobById } from '../../src/lib/jobs'
import { getProjectByJobId } from '../../src/lib/projects'
import { derivePaymentReconciliationStatus } from '../../src/lib/payments/reconciliation/deriveReconciliationStatus'
import {
  recoverMissedStripeState,
} from '../../src/lib/payments/reconciliation/reconciliationService'
import {
  isValidProviderRecoveryTransition,
} from '../../api/_providerRecoveryTransitions'
import {
  isValidWebhookTransition,
} from '../../api/_webhookHelpers'
import {
  classifyProcessingRow,
} from '../../api/_webhookProcessingRecovery'
import type { StripePaymentSnapshot } from '../../src/lib/payments/reconciliation/types'
import type { PaymentState } from '../../src/lib/shared/coreTypes'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryProjectRepository } from '../../src/lib/projects/repository/InMemoryProjectRepository'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { syncPaymentStateToJobAndProject } from '../../src/lib/workflow/paymentWorkflow'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStripe(status: string): StripePaymentSnapshot {
  return {
    paymentIntentId: 'pi_test_block5',
    stripeStatus: status,
    amountCapturable: 2000,
    amountReceived: 2000,
    currency: 'eur',
  }
}

/**
 * Advance a payment through the LEGAL state machine chain.
 * Respects the allowedTransitions in stateMachine.ts.
 */
async function advanceThrough(jobId: string, states: PaymentState[]) {
  for (const s of states) {
    await updatePaymentState(jobId, s)
  }
}

/** Full legal chain to reach 'released' */
const CHAIN_TO_RELEASED: PaymentState[] = [
  'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending', 'released',
]

/** Full legal chain to reach 'release_pending' */
const CHAIN_TO_RELEASE_PENDING: PaymentState[] = [
  'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending',
]

/** Full legal chain to reach 'refunded' from in_escrow */
const CHAIN_TO_REFUNDED_FROM_ESCROW: PaymentState[] = [
  'deposit_paid', 'in_escrow', 'refunded',
]

function seedJobAndProject(jobId: string, projectId: string): void {
  const jobRepo = new InMemoryJobRepository([
    {
      id: jobId,
      projectId,
      title: 'Test Job',
      description: 'Block 5 test',
      status: 'waiting_payment',
      paymentState: 'deposit_required',
      activities: [],
      assignedMemberIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never,
  ])
  setJobRepository(jobRepo)
  const projectRepo = new InMemoryProjectRepository([
    {
      id: projectId,
      sourceJobId: jobId,
      title: 'Test Project',
      category: 'Elektrik',
      status: 'active',
      paymentState: 'deposit_required',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never,
  ])
  setProjectRepository(projectRepo)
}

beforeEach(() => {
  setupCleanRepositories()
})

// =========================================================================
// SECTION 1: IDEMPOTENCY / REPLAY SAFETY
// =========================================================================

describe('Block 5 — Idempotency / Replay Safety', () => {
  // Criteria 1: External provider events are processed idempotently
  it('duplicate webhook delivery does not duplicate internal effects', async () => {
    await createPaymentForJob('job-idem-1', 1000)
    await advanceThrough('job-idem-1', CHAIN_TO_RELEASE_PENDING)

    // First webhook: advance to released
    const result1 = await recoverMissedStripeState(
      getPaymentForJob('job-idem-1')!,
      makeStripe('succeeded'),
    )
    expect(result1.recovered).toBe(true)
    expect(getPaymentForJob('job-idem-1')!.state).toBe('released')

    // Second webhook (duplicate): should be no-op
    const result2 = await recoverMissedStripeState(
      getPaymentForJob('job-idem-1')!,
      makeStripe('succeeded'),
    )
    expect(result2.recovered).toBe(false)
    expect(result2.status).toBe('aligned')
    expect(getPaymentForJob('job-idem-1')!.state).toBe('released')
  })

  // Criteria 2: Duplicate events cannot create duplicate internal effects
  it('replayed release attempt does not duplicate irreversible outcomes', async () => {
    await createPaymentForJob('job-idem-2', 1000)
    await advanceThrough('job-idem-2', CHAIN_TO_RELEASED)

    // Attempt to release again — updatePaymentState should be no-op
    const payment = getPaymentForJob('job-idem-2')!
    const result = await updatePaymentState('job-idem-2', 'released')
    expect(result).toBeDefined()
    expect(result!.state).toBe('released')
    expect(result!.updatedAt).toBe(payment.updatedAt) // No mutation occurred
  })

  // Criteria 2: Replayed refund is safe
  it('replayed refund attempt does not duplicate refund', async () => {
    await createPaymentForJob('job-idem-3', 1000)
    await advanceThrough('job-idem-3', CHAIN_TO_REFUNDED_FROM_ESCROW)

    const payment = getPaymentForJob('job-idem-3')!
    const result = await updatePaymentState('job-idem-3', 'refunded')
    expect(result).toBeDefined()
    expect(result!.state).toBe('refunded')
    expect(result!.updatedAt).toBe(payment.updatedAt)
  })

  // Criteria 1: Webhook transition validation is idempotent
  it('isValidWebhookTransition is pure and deterministic', () => {
    for (let i = 0; i < 10; i++) {
      expect(isValidWebhookTransition('in_escrow', 'released')).toBe(true)
      expect(isValidWebhookTransition('released', 'released')).toBe(false)
    }
  })
})

// =========================================================================
// SECTION 2: OUT-OF-ORDER / DELAYED EVENT SAFETY
// =========================================================================

describe('Block 5 — Out-of-Order Event Safety', () => {
  // Criteria 3: Out-of-order events cannot move internal truth into illegal state
  it('out-of-order refund after release is rejected', () => {
    expect(isValidWebhookTransition('released', 'refunded')).toBe(false)
  })

  it('out-of-order release after refund is rejected', () => {
    expect(isValidWebhookTransition('refunded', 'released')).toBe(false)
  })

  it('delayed webhook arriving after local state advanced is safe', async () => {
    await createPaymentForJob('job-oo-1', 1000)
    await advanceThrough('job-oo-1', CHAIN_TO_RELEASED)

    // Delayed webhook arrives with succeeded (already in released)
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-oo-1')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('aligned')
  })

  // Criteria 3: Webhook arriving before local flow completes
  it('webhook arriving while local state is behind is recoverable', async () => {
    await createPaymentForJob('job-oo-2', 1000)
    await advanceThrough('job-oo-2', ['deposit_paid', 'in_escrow'])

    // Webhook arrives with succeeded while local state is only at in_escrow
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-oo-2')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('recoverable')
    expect(result.recommendedState).toBe('released')
  })
})

// =========================================================================
// SECTION 3: PROVIDER TRUTH MODEL
// =========================================================================

describe('Block 5 — Provider Truth Model', () => {
  // Criteria 4: Provider truth ahead of DB truth is explicitly modeled
  it('provider ahead: Stripe succeeded, DB at deposit_paid → recoverable', async () => {
    await createPaymentForJob('job-pt-1', 1000)
    await advanceThrough('job-pt-1', ['deposit_paid'])

    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pt-1')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('recoverable')
    expect(result.recommendedState).toBe('released')
  })

  // Criteria 5: DB truth ahead of provider is explicitly modeled
  it('DB ahead: DB at released, Stripe at requires_capture → inconsistent', async () => {
    await createPaymentForJob('job-pt-2', 1000)
    await advanceThrough('job-pt-2', CHAIN_TO_RELEASED)

    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pt-2')!,
      makeStripe('requires_capture'),
    )
    expect(result.status).toBe('inconsistent')
    expect(result.note).toContain('terminal')
  })

  // Criteria 4: Provider truth for work_in_progress → released
  it('provider ahead: Stripe succeeded, DB at work_in_progress → recoverable', async () => {
    await createPaymentForJob('job-pt-3', 1000)
    await advanceThrough('job-pt-3', ['deposit_paid', 'in_escrow', 'work_in_progress'])

    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pt-3')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('recoverable')
    expect(result.recommendedState).toBe('released')
  })
})

// =========================================================================
// SECTION 4: RECONCILIATION CONSISTENCY
// =========================================================================

describe('Block 5 — Reconciliation Consistency', () => {
  // Criteria 7: All reconciliation paths use one consistent truth model
  it('webhook and client-side reconciliation agree on all transitions', () => {
    const allStates = [
      'none', 'deposit_required', 'deposit_paid', 'in_escrow',
      'work_in_progress', 'release_pending', 'disputed', 'released', 'refunded',
    ]

    for (const state of allStates) {
      const webhookRelease = isValidWebhookTransition(state, 'released')
      const recoveryRelease = isValidProviderRecoveryTransition(state, 'released')
      expect(webhookRelease).toBe(recoveryRelease)

      const webhookRefund = isValidWebhookTransition(state, 'refunded')
      const recoveryRefund = isValidProviderRecoveryTransition(state, 'refunded')
      expect(webhookRefund).toBe(recoveryRefund)
    }
  })

  // Criteria 7: Recovery-only transitions are consistent
  it('recovery-only transitions (work_in_progress → released) are allowed in all paths', () => {
    expect(isValidProviderRecoveryTransition('work_in_progress', 'released')).toBe(true)
    expect(isValidWebhookTransition('work_in_progress', 'released')).toBe(true)
  })

  // Criteria 7: derivePaymentReconciliationStatus uses same rules as webhook
  it('derivePaymentReconciliationStatus agrees with webhook for recovery from work_in_progress', async () => {
    await createPaymentForJob('job-cons-1', 1000)
    await advanceThrough('job-cons-1', ['deposit_paid', 'in_escrow', 'work_in_progress'])

    const payment = getPaymentForJob('job-cons-1')!

    // Client-side reconciliation says recoverable
    const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))
    expect(result.status).toBe('recoverable')

    // Webhook transition validation also allows it
    expect(isValidWebhookTransition('work_in_progress', 'released')).toBe(true)
  })
})

// =========================================================================
// SECTION 5: PARTIAL FAILURE RECOVERY
// =========================================================================

describe('Block 5 — Partial Failure Recovery', () => {
  // Criteria 8: Recovery after partial failure is explicit
  it('provider success + DB failure: recoverMissedStripeState can re-advance', async () => {
    await createPaymentForJob('job-pf-1', 1000)
    await advanceThrough('job-pf-1', CHAIN_TO_RELEASE_PENDING)

    // Stripe captured (succeeded) but DB didn't advance to released yet
    const payment = getPaymentForJob('job-pf-1')!
    expect(payment.state).toBe('release_pending')

    // Recovery path
    const result = await recoverMissedStripeState(payment, makeStripe('succeeded'))
    expect(result.recovered).toBe(true)
    expect(getPaymentForJob('job-pf-1')!.state).toBe('released')
  })

  // Criteria 8: DB success + provider uncertainty
  it('DB at released, Stripe says succeeded → aligned (no corrective action needed)', async () => {
    await createPaymentForJob('job-pf-2', 1000)
    await advanceThrough('job-pf-2', CHAIN_TO_RELEASED)

    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pf-2')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('aligned')
  })

  // Criteria 8: Duplicate webhook after reconciliation
  it('duplicate webhook after reconciliation is safe (aligned)', async () => {
    await createPaymentForJob('job-pf-3', 1000)
    await advanceThrough('job-pf-3', CHAIN_TO_RELEASE_PENDING)

    // First reconciliation
    await recoverMissedStripeState(getPaymentForJob('job-pf-3')!, makeStripe('succeeded'))
    expect(getPaymentForJob('job-pf-3')!.state).toBe('released')

    // Duplicate after reconciliation
    const result = await recoverMissedStripeState(
      getPaymentForJob('job-pf-3')!,
      makeStripe('succeeded'),
    )
    expect(result.recovered).toBe(false)
    expect(result.status).toBe('aligned')
  })

  // Criteria 8: Retry against already-advanced provider truth
  it('retry against already-advanced provider truth is safe', async () => {
    await createPaymentForJob('job-pf-4', 1000)
    await advanceThrough('job-pf-4', CHAIN_TO_RELEASE_PENDING)

    // Provider already succeeded but DB is at release_pending
    const result = await recoverMissedStripeState(
      getPaymentForJob('job-pf-4')!,
      makeStripe('succeeded'),
    )
    expect(result.recovered).toBe(true)
    expect(getPaymentForJob('job-pf-4')!.state).toBe('released')

    // Another retry — safe, no-op
    const result2 = await recoverMissedStripeState(
      getPaymentForJob('job-pf-4')!,
      makeStripe('succeeded'),
    )
    expect(result2.recovered).toBe(false)
    expect(result2.status).toBe('aligned')
  })

  // Criteria 4: Provider truth ahead of DB by multiple steps is detectable
  it('provider ahead by multiple steps: in_escrow → released detected as recoverable', async () => {
    await createPaymentForJob('job-pf-4b', 1000)
    await advanceThrough('job-pf-4b', ['deposit_paid', 'in_escrow'])

    // Provider already succeeded but DB is only at in_escrow
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pf-4b')!,
      makeStripe('succeeded'),
    )
    expect(result.status).toBe('recoverable')
    expect(result.recommendedState).toBe('released')
    // Note: actual recovery from in_escrow → released happens on the server side
    // (webhook or cron) which bypasses the client-side state machine
  })

  // Criteria 9: Unresolved divergence is detectable
  it('unresolved divergence is marked as inconsistent, not silently treated as success', async () => {
    await createPaymentForJob('job-pf-5', 1000)
    await advanceThrough('job-pf-5', CHAIN_TO_RELEASED)

    // DB says released, but Stripe says canceled (impossible in normal flow)
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-pf-5')!,
      makeStripe('canceled'),
    )
    expect(result.status).toBe('inconsistent')
    expect(result.note).toContain('terminal')
    expect(result.note).toContain('Manual review')
  })
})

// =========================================================================
// SECTION 6: DOWNSTREAM ALIGNMENT
// =========================================================================

describe('Block 5 — Downstream Alignment', () => {
  // Criteria 10: Downstream domains receive truthful post-provider state
  it('syncPaymentStateToJobAndProject propagates provider-reconciled state', async () => {
    seedJobAndProject('job-ds-1', 'proj-ds-1')
    await createPaymentForJob('job-ds-1', 1000)

    // Simulate provider reconciliation advancing to released
    await syncPaymentStateToJobAndProject('job-ds-1', 'released')

    const job = getJobById('job-ds-1')
    const project = getProjectByJobId('job-ds-1')

    expect(job?.paymentState).toBe('released')
    expect(project?.paymentState).toBe('released')
  })

  it('syncPaymentStateToJobAndProject propagates refunded state', async () => {
    seedJobAndProject('job-ds-2', 'proj-ds-2')
    await createPaymentForJob('job-ds-2', 1000)

    await syncPaymentStateToJobAndProject('job-ds-2', 'refunded')

    const job = getJobById('job-ds-2')
    const project = getProjectByJobId('job-ds-2')

    expect(job?.paymentState).toBe('refunded')
    expect(project?.paymentState).toBe('refunded')
  })

  it('partial sync failure (no project) logs but does not throw', async () => {
    // Job exists but no project — use a separate repo setup
    const jobRepo = new InMemoryJobRepository([
      {
        id: 'job-ds-3',
        title: 'No project',
        description: 'Block 5 test',
        status: 'waiting_payment',
        paymentState: 'deposit_required',
        activities: [],
        assignedMemberIds: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never,
    ])
    setJobRepository(jobRepo)
    await createPaymentForJob('job-ds-3', 1000)

    // Should not throw even though project doesn't exist
    const result = await syncPaymentStateToJobAndProject('job-ds-3', 'released')
    expect(result.jobSynced).toBe(true)
    expect(result.projectNotFound).toBe(true)
  })
})

// =========================================================================
// SECTION 7: OBSERVABILITY / RECOVERY
// =========================================================================

describe('Block 5 — Observability and Recovery', () => {
  // Criteria 9: No provider-related failure leaves system undetectable
  it('classifyProcessingRow detects stale webhook events', () => {
    const tenMinutesAgo = Date.now() - 11 * 60 * 1000
    const row = { outcome: 'processing', processed_at: tenMinutesAgo }
    expect(classifyProcessingRow(row)).toBe('stale')
  })

  it('classifyProcessingRow marks recent processing as active', () => {
    const oneMinuteAgo = Date.now() - 60 * 1000
    const row = { outcome: 'processing', processed_at: oneMinuteAgo }
    expect(classifyProcessingRow(row)).toBe('active')
  })

  it('classifyProcessingRow marks finalized rows correctly', () => {
    const row = { outcome: 'reconciled', processed_at: Date.now() - 20 * 60 * 1000 }
    expect(classifyProcessingRow(row)).toBe('finalized')
  })

  it('reconciliation result always includes reconciledAt timestamp', async () => {
    await createPaymentForJob('job-obs-1', 1000)
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-obs-1')!,
      makeStripe('requires_capture'),
    )
    expect(result.reconciledAt).toBeDefined()
    expect(new Date(result.reconciledAt).getTime()).toBeGreaterThan(0)
  })

  it('reconciliation result includes paymentId, jobId, status, dbState, note', async () => {
    await createPaymentForJob('job-obs-2', 1000)
    const result = derivePaymentReconciliationStatus(
      getPaymentForJob('job-obs-2')!,
      makeStripe('requires_capture'),
    )
    expect(result.paymentId).toBeDefined()
    expect(result.jobId).toBeDefined()
    expect(result.status).toBeDefined()
    expect(result.dbState).toBeDefined()
    expect(result.note).toBeDefined()
  })
})

// =========================================================================
// SECTION 8: EXACTLY-ONCE SAFETY
// =========================================================================

describe('Block 5 — Exactly-Once Safety', () => {
  // Criteria 6: Release/refund/capture paths are exactly-once-safe
  it('updatePaymentState to same state is no-op (returns unchanged payment)', async () => {
    await createPaymentForJob('job-eo-1', 1000)
    await advanceThrough('job-eo-1', ['deposit_paid'])

    const before = getPaymentForJob('job-eo-1')!
    const after = await updatePaymentState('job-eo-1', 'deposit_paid')
    expect(after!.state).toBe(before.state)
    expect(after!.updatedAt).toBe(before.updatedAt)
  })

  it('no transition exists from terminal released', () => {
    expect(isValidProviderRecoveryTransition('released', 'released')).toBe(false)
    expect(isValidProviderRecoveryTransition('released', 'refunded')).toBe(false)
  })

  it('no transition exists from terminal refunded', () => {
    expect(isValidProviderRecoveryTransition('refunded', 'released')).toBe(false)
    expect(isValidProviderRecoveryTransition('refunded', 'refunded')).toBe(false)
  })
})

// =========================================================================
// SECTION 9: COMPREHENSIVE RECOVERY MATRIX
// =========================================================================

describe('Block 5 — Recovery Matrix: All non-terminal × provider states', () => {
  // C2: 'disputed' is deliberately NOT in this matrix — a disputed payment may
  // only be exited via the dispute-resolution workflow, never by
  // provider-authoritative recovery (see explicit pins below).
  const nonTerminalFunded: PaymentState[] = [
    'deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending',
  ]

  /**
   * Legal chains to reach each non-terminal funded state.
   * Respects the allowedTransitions state machine.
   */
  const chainTo: Record<string, PaymentState[]> = {
    deposit_paid: ['deposit_paid'],
    in_escrow: ['deposit_paid', 'in_escrow'],
    work_in_progress: ['deposit_paid', 'in_escrow', 'work_in_progress'],
    release_pending: ['deposit_paid', 'in_escrow', 'work_in_progress', 'release_pending'],
  }

  it.each(nonTerminalFunded)(
    '%s × Stripe succeeded → recoverable to released',
    async (state) => {
      const jobId = `job-rm-${state}-succ`
      await createPaymentForJob(jobId, 1000)

      for (const s of chainTo[state]) {
        await updatePaymentState(jobId, s)
      }

      const payment = getPaymentForJob(jobId)!
      expect(payment.state).toBe(state)

      const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))
      expect(result.status).toBe('recoverable')
      expect(result.recommendedState).toBe('released')
    },
  )

  it.each(nonTerminalFunded)(
    '%s × Stripe canceled → recoverable to refunded',
    async (state) => {
      const jobId = `job-rm-${state}-canc`
      await createPaymentForJob(jobId, 1000)

      for (const s of chainTo[state]) {
        await updatePaymentState(jobId, s)
      }

      const payment = getPaymentForJob(jobId)!
      expect(payment.state).toBe(state)

      const result = derivePaymentReconciliationStatus(payment, makeStripe('canceled'))
      expect(result.status).toBe('recoverable')
      expect(result.recommendedState).toBe('refunded')
    },
  )
})

// =========================================================================
// SECTION 10: DISPUTED IS NOT A PROVIDER-RECOVERY SOURCE (C2)
// =========================================================================

describe('Block 5 — Disputed payments are never auto-recovered from provider truth', () => {
  /** Legal chain to reach 'disputed' (in_escrow → disputed per stateMachine.ts). */
  const CHAIN_TO_DISPUTED: PaymentState[] = ['deposit_paid', 'in_escrow', 'disputed']

  it('disputed × Stripe succeeded → inconsistent (manual review, NOT recoverable)', async () => {
    await createPaymentForJob('job-disp-1', 1000)
    await advanceThrough('job-disp-1', CHAIN_TO_DISPUTED)

    const payment = getPaymentForJob('job-disp-1')!
    expect(payment.state).toBe('disputed')

    const result = derivePaymentReconciliationStatus(payment, makeStripe('succeeded'))
    expect(result.status).toBe('inconsistent')
    expect(result.note.toLowerCase()).toContain('manual review')
  })

  it('disputed × Stripe canceled → inconsistent (manual review, NOT recoverable)', async () => {
    await createPaymentForJob('job-disp-2', 1000)
    await advanceThrough('job-disp-2', CHAIN_TO_DISPUTED)

    const payment = getPaymentForJob('job-disp-2')!
    expect(payment.state).toBe('disputed')

    const result = derivePaymentReconciliationStatus(payment, makeStripe('canceled'))
    expect(result.status).toBe('inconsistent')
    expect(result.note.toLowerCase()).toContain('manual review')
  })

  it('webhook transition validation rejects both exits from disputed', () => {
    expect(isValidWebhookTransition('disputed', 'released')).toBe(false)
    expect(isValidWebhookTransition('disputed', 'refunded')).toBe(false)
    expect(isValidProviderRecoveryTransition('disputed', 'released')).toBe(false)
    expect(isValidProviderRecoveryTransition('disputed', 'refunded')).toBe(false)
  })
})
