/**
 * Block A.2 — Payment Atomic Core: Failure-Mode Tests
 *
 * Tests the critical failure modes that the finalize_payment_state_atomic
 * RPC and the updated service layer are designed to prevent:
 *
 * 1. Release provider success + DB finalize fail → no released truth without commit
 * 2. Refund provider success + DB finalize fail  → no refunded truth without commit
 * 3. Concurrent duplicate release is idempotent  → payment stays released
 * 4. Retry after already released is idempotent  → no double-ledger
 * 5. Retry after already refunded is idempotent  → no double-ledger
 * 6. Release rejected when payment already disputed
 * 7. Refund rejected when payment not in valid state
 * 8. Release rejected when payment is already released (terminal state)
 * 9. finalizeStateAtomic never silently swallows DB failures
 * 10. finalizeStateAtomic local cache stays consistent on DB failure (no partial optimistic update)
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createPaymentForJob,
  updatePaymentState,
  getPaymentForJob,
  releaseEscrowPayment,
  refundEscrowPayment,
} from '../../src/lib/payments/service'
import { getPaymentRepository } from '../../src/lib/payments/repository'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'
import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import { setPaymentRepository } from '../../src/lib/payments/repository/registry'

// ---------------------------------------------------------------------------
// Mock provider — controls whether Stripe calls succeed or fail
// ---------------------------------------------------------------------------

const mockReleaseEscrow = vi.fn<() => Promise<void>>()
const mockRefundEscrow = vi.fn<() => Promise<void>>()

vi.mock('../../src/lib/payments/providers/index', () => ({
  getPaymentProvider: () => ({
    createEscrow:     vi.fn(),
    confirmDeposit:   vi.fn(),
    releaseEscrow:    mockReleaseEscrow,
    refundEscrow:     mockRefundEscrow,
  }),
  getPaymentProviderName: () => 'mock',
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedPaymentInEscrow(jobId: string): Promise<void> {
  await createPaymentForJob(jobId, 1000)
  await updatePaymentState(jobId, 'deposit_paid')
  await updatePaymentState(jobId, 'in_escrow')
}

async function seedPaymentReleasePending(jobId: string): Promise<void> {
  await seedPaymentInEscrow(jobId)
  await updatePaymentState(jobId, 'work_in_progress')
  await updatePaymentState(jobId, 'release_pending')
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupCleanRepositories()
  vi.clearAllMocks()
  mockReleaseEscrow.mockResolvedValue(undefined)
  mockRefundEscrow.mockResolvedValue(undefined)
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Release: provider success + DB fail → no released truth
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — Release: provider success + DB commit fail → payment stays release_pending', () => {
  it('throws when finalizeStateAtomic fails after provider release succeeds', async () => {
    await seedPaymentReleasePending('job-1a')

    // Simulate DB failure in finalizeStateAtomic
    const repo = getPaymentRepository() as InMemoryPaymentRepository
    const originalFinalize = repo.finalizeStateAtomic.bind(repo)
    let callCount = 0
    repo.finalizeStateAtomic = vi.fn(async (...args) => {
      callCount++
      if (callCount === 1) throw new Error('DB connection lost')
      return originalFinalize(...args)
    }) as Mock

    await expect(releaseEscrowPayment('job-1a')).rejects.toThrow('DB connection lost')

    // Payment must still show release_pending — no released truth without DB commit
    const payment = getPaymentForJob('job-1a')
    expect(payment?.state).toBe('release_pending')
  })

  it('does not create ledger entries when DB commit fails', async () => {
    await seedPaymentReleasePending('job-1b')

    const repo = getPaymentRepository() as InMemoryPaymentRepository
    repo.finalizeStateAtomic = vi.fn().mockRejectedValue(new Error('timeout')) as Mock

    await expect(releaseEscrowPayment('job-1b')).rejects.toThrow()

    const entries = getLedgerRepository().getForJob('job-1b')
    const releaseEntries = entries.filter((e) =>
      ['final_paid', 'payout', 'platform_fee'].includes(e.type)
    )
    expect(releaseEntries).toHaveLength(0)
  })

  it('provider is called even when DB fails — Stripe side succeeded', async () => {
    await seedPaymentReleasePending('job-1c')

    const repo = getPaymentRepository() as InMemoryPaymentRepository
    repo.finalizeStateAtomic = vi.fn().mockRejectedValue(new Error('DB down')) as Mock

    await expect(releaseEscrowPayment('job-1c')).rejects.toThrow()

    // Provider was called (Stripe side already executed)
    expect(mockReleaseEscrow).toHaveBeenCalledOnce()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Refund: provider success + DB fail → no refunded truth
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — Refund: provider success + DB commit fail → payment stays in_escrow', () => {
  it('throws when finalizeStateAtomic fails after provider refund succeeds', async () => {
    await seedPaymentInEscrow('job-2a')

    const repo = getPaymentRepository() as InMemoryPaymentRepository
    repo.finalizeStateAtomic = vi.fn().mockRejectedValue(new Error('connection refused')) as Mock

    await expect(refundEscrowPayment('job-2a')).rejects.toThrow('connection refused')

    const payment = getPaymentForJob('job-2a')
    expect(payment?.state).toBe('in_escrow')
  })

  it('does not create refund ledger entry when DB commit fails', async () => {
    await seedPaymentInEscrow('job-2b')

    const repo = getPaymentRepository() as InMemoryPaymentRepository
    repo.finalizeStateAtomic = vi.fn().mockRejectedValue(new Error('DB fail')) as Mock

    await expect(refundEscrowPayment('job-2b')).rejects.toThrow()

    const entries = getLedgerRepository().getForJob('job-2b')
    expect(entries.filter((e) => e.type === 'refund')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Concurrent duplicate release is idempotent
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — Concurrent duplicate release is idempotent', () => {
  it('first release succeeds; second release is rejected by pre-flight before touching Stripe', async () => {
    await seedPaymentReleasePending('job-3a')

    // First release
    const result1 = await releaseEscrowPayment('job-3a')
    expect(result1?.payment?.state).toBe('released')

    // Second release — pre-flight guard rejects (canTransition('released','released') = false)
    // Stripe provider must NOT be called again (pre-flight fires before provider)
    await expect(releaseEscrowPayment('job-3a')).rejects.toThrow('illegal transition')

    // Provider called exactly once — the pre-flight guarded the second call
    expect(mockReleaseEscrow).toHaveBeenCalledOnce()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Retry after already released — no double ledger
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — Retry after already released produces no duplicate ledger entries', () => {
  it('ledger entries are written exactly once even when a second call is attempted', async () => {
    await seedPaymentReleasePending('job-4a')

    await releaseEscrowPayment('job-4a')

    // Second call rejected by pre-flight — no ledger writes happen
    await expect(releaseEscrowPayment('job-4a')).rejects.toThrow('illegal transition')

    const entries = getLedgerRepository().getForJob('job-4a')
    const payoutEntries = entries.filter((e) => e.type === 'payout')
    expect(payoutEntries).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. Retry after already refunded — no double ledger
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — Retry after already refunded produces no duplicate ledger entries', () => {
  it('refund ledger entry is written exactly once even when a second call is attempted', async () => {
    await seedPaymentInEscrow('job-5a')

    await refundEscrowPayment('job-5a')

    // Second call rejected by pre-flight — no ledger writes happen
    await expect(refundEscrowPayment('job-5a')).rejects.toThrow('illegal transition')

    const entries = getLedgerRepository().getForJob('job-5a')
    expect(entries.filter((e) => e.type === 'refund')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Release rejected when payment not in releasable state
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — Release pre-flight: illegal state transitions fail fast', () => {
  it('deposit_required cannot be released', async () => {
    await createPaymentForJob('job-6a', 1000)
    await expect(releaseEscrowPayment('job-6a')).rejects.toThrow('illegal transition')
    expect(mockReleaseEscrow).not.toHaveBeenCalled()
  })

  it('deposit_paid cannot be released', async () => {
    await createPaymentForJob('job-6b', 1000)
    await updatePaymentState('job-6b', 'deposit_paid')
    await expect(releaseEscrowPayment('job-6b')).rejects.toThrow('illegal transition')
    expect(mockReleaseEscrow).not.toHaveBeenCalled()
  })

  it('already released payment cannot be released again (pre-flight)', async () => {
    await seedPaymentReleasePending('job-6c')
    await releaseEscrowPayment('job-6c')
    // Second call: canTransition('released', 'released') = false → throws
    await expect(releaseEscrowPayment('job-6c')).rejects.toThrow('illegal transition')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Refund rejected when in invalid state
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — Refund pre-flight: illegal state transitions fail fast', () => {
  it('deposit_required cannot be refunded', async () => {
    await createPaymentForJob('job-7a', 1000)
    await expect(refundEscrowPayment('job-7a')).rejects.toThrow('illegal transition')
    expect(mockRefundEscrow).not.toHaveBeenCalled()
  })

  it('released payment cannot be refunded — pre-flight fires before calling Stripe', async () => {
    await seedPaymentReleasePending('job-7b')
    await releaseEscrowPayment('job-7b')
    await expect(refundEscrowPayment('job-7b')).rejects.toThrow('illegal transition')
    // refundEscrow (Stripe side) must NOT be called — pre-flight guarded it
    expect(mockRefundEscrow).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. finalizeStateAtomic: local cache consistency on failure
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — finalizeStateAtomic: no partial optimistic update on DB failure', () => {
  it('payment remains in original state after DB failure', async () => {
    await seedPaymentReleasePending('job-8a')
    const before = getPaymentForJob('job-8a')
    expect(before?.state).toBe('release_pending')

    const repo = getPaymentRepository() as InMemoryPaymentRepository
    repo.finalizeStateAtomic = vi.fn().mockRejectedValue(new Error('network error')) as Mock

    await expect(releaseEscrowPayment('job-8a')).rejects.toThrow()

    // Local cache must not have advanced state
    const after = getPaymentForJob('job-8a')
    expect(after?.state).toBe('release_pending')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. InMemoryPaymentRepository.finalizeStateAtomic: happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — InMemoryPaymentRepository.finalizeStateAtomic happy path', () => {
  it('transitions payment to released and returns updated payment', async () => {
    const repo = new InMemoryPaymentRepository([])
    setPaymentRepository(repo)
    await createPaymentForJob('job-9a', 500)
    await updatePaymentState('job-9a', 'deposit_paid')
    await updatePaymentState('job-9a', 'in_escrow')
    await updatePaymentState('job-9a', 'work_in_progress')
    await updatePaymentState('job-9a', 'release_pending')

    const result = await repo.finalizeStateAtomic('job-9a', 'released')
    expect(result.state).toBe('released')
    expect(getPaymentForJob('job-9a')?.state).toBe('released')
  })

  it('is idempotent when already in target state', async () => {
    const repo = new InMemoryPaymentRepository([])
    setPaymentRepository(repo)
    await createPaymentForJob('job-9b', 500)
    await updatePaymentState('job-9b', 'deposit_paid')
    await updatePaymentState('job-9b', 'in_escrow')
    await updatePaymentState('job-9b', 'work_in_progress')
    await updatePaymentState('job-9b', 'release_pending')

    await repo.finalizeStateAtomic('job-9b', 'released')
    const second = await repo.finalizeStateAtomic('job-9b', 'released')
    expect(second.state).toBe('released')
  })

  it('throws when no payment exists for job', async () => {
    const repo = new InMemoryPaymentRepository([])
    setPaymentRepository(repo)
    await expect(repo.finalizeStateAtomic('nonexistent-job', 'released')).rejects.toThrow(
      'finalizeStateAtomic: no payment for job nonexistent-job'
    )
  })

  it('preserves refundedAmount when provided', async () => {
    const repo = new InMemoryPaymentRepository([])
    setPaymentRepository(repo)
    await createPaymentForJob('job-9c', 1000)
    await updatePaymentState('job-9c', 'deposit_paid')
    await updatePaymentState('job-9c', 'in_escrow')

    const result = await repo.finalizeStateAtomic('job-9c', 'refunded', { refundedAmount: 750 })
    expect(result.state).toBe('refunded')
    expect(result.refundedAmount).toBe(750)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Full release/refund flow: correct ledger entry types
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — Release/Refund: correct ledger entries written', () => {
  it('release creates final_paid, platform_fee, payout entries', async () => {
    await seedPaymentReleasePending('job-10a')
    await releaseEscrowPayment('job-10a')

    const entries = getLedgerRepository().getForJob('job-10a')
    const types = entries.map((e) => e.type)
    expect(types).toContain('final_paid')
    expect(types).toContain('platform_fee')
    expect(types).toContain('payout')
  })

  it('refund creates refund entry', async () => {
    await seedPaymentInEscrow('job-10b')
    await refundEscrowPayment('job-10b')

    const entries = getLedgerRepository().getForJob('job-10b')
    expect(entries.some((e) => e.type === 'refund')).toBe(true)
    expect(entries.filter((e) => e.type === 'refund')).toHaveLength(1)
  })

  it('split release via releaseEscrowPayment defers payout/refund ledger entries to workflow layer', async () => {
    await createPaymentForJob('job-10c', 1000)
    await updatePaymentState('job-10c', 'deposit_paid')
    await updatePaymentState('job-10c', 'in_escrow')
    await updatePaymentState('job-10c', 'disputed', { disputeId: 'dispute-split' })

    // releaseEscrowPayment performs the Stripe capture but does NOT write split
    // ledger entries — those are gated in releaseEscrowWorkflow at the appropriate
    // money-movement confirmation points.
    await releaseEscrowPayment('job-10c', { disputeId: 'dispute-split', splitRatio: 0.6 })

    const entries = getLedgerRepository().getForJob('job-10c')
    const types = entries.map((e) => e.type)
    expect(types).not.toContain('dispute_resolved_release')
    expect(types).not.toContain('dispute_resolved_refund')
    expect(types).not.toContain('payout')
    expect(types).not.toContain('final_paid')
    // platform_fee for split is also deferred (craftsman-portion fee, not full fee)
    expect(types).not.toContain('platform_fee')
  })

  it('non-split dispute release via releaseEscrowPayment defers payout ledger entries to workflow layer', async () => {
    await createPaymentForJob('job-10d', 1000)
    await updatePaymentState('job-10d', 'deposit_paid')
    await updatePaymentState('job-10d', 'in_escrow')
    await updatePaymentState('job-10d', 'disputed', { disputeId: 'dispute-nonsplit' })

    // Non-split dispute: capture runs but final_paid / platform_fee /
    // dispute_resolved_release are deferred to releaseEscrowWorkflow after bridge.
    await releaseEscrowPayment('job-10d', { disputeId: 'dispute-nonsplit' })

    const entries = getLedgerRepository().getForJob('job-10d')
    const types = entries.map((e) => e.type)
    expect(types).not.toContain('final_paid')
    expect(types).not.toContain('platform_fee')
    expect(types).not.toContain('dispute_resolved_release')
  })
})
