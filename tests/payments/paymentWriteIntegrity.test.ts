/**
 * Block 3 — Payment Write Integrity Tests
 *
 * Validates the canonical payment write integrity contract:
 *
 * 1. Failed payment persistence does NOT leave advanced local payment state.
 * 2. Successful persistence still updates local state correctly.
 * 3. Rollback restores the exact prior local truth on failure.
 * 4. Callers can distinguish real success from failed persistence.
 * 5. No regression to Block 2 propagation hardening.
 * 6. No regression to Block 1 hydration semantics.
 *
 * FAILURE CLASS TARGETED:
 * - Optimistic update then persistence failure → phantom success
 * - Local payment state moved to deposit_paid but DB write failed
 * - Local payment state moved to in_escrow but repository write partially failed
 * - Local payment state remains advanced after thrown persistence error
 *
 * CONTRACT:
 * - PaymentRepository.add() and .update() return Promise<void>
 * - On persistence failure, local cache is rolled back and error is thrown
 * - No phantom-success payment truth remains in memory after failed persistence
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createPaymentForJob,
  updatePaymentState,
  getPaymentForJob,
  ensurePaymentForJob,
} from '../../src/lib/payments/service'
import {
  getPaymentRepository,
  setPaymentRepository,
} from '../../src/lib/payments/repository/registry'
import { InMemoryPaymentRepository } from '../../src/lib/payments/repository/InMemoryPaymentRepository'
import type { PaymentRepository } from '../../src/lib/payments/repository/PaymentRepository'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a PaymentRepository wrapper that delegates to InMemoryPaymentRepository
 * but can be configured to fail on add() or update() to simulate persistence errors.
 */
function createFailableRepository(): PaymentRepository & {
  failOnAdd: boolean
  failOnUpdate: boolean
  inner: InMemoryPaymentRepository
} {
  const inner = new InMemoryPaymentRepository([])
  const wrapper = {
    inner,
    failOnAdd: false,
    failOnUpdate: false,

    initialize: () => inner.initialize(),
    isHydrated: () => inner.isHydrated(),
    getAll: () => inner.getAll(),
    getByJobId: (jobId: string) => inner.getByJobId(jobId),
    subscribe: (listener: () => void) => inner.subscribe(listener),

    async add(payment: Payment): Promise<void> {
      // Optimistic local update (mirroring SupabasePaymentRepository)
      await inner.add(payment)

      // Simulate persistence failure after local update
      if (wrapper.failOnAdd) {
        // Rollback — remove the just-added payment from inner
        // This mirrors what SupabasePaymentRepository does:
        // this.payments = this.payments.filter((p) => p.id !== payment.id)
        const remaining = inner.getAll().filter((p) => p.id !== payment.id)
        // Reset inner to clean state with remaining payments
        const replacement = new InMemoryPaymentRepository(remaining)
        // Swap inner methods to point at replacement
        inner.getAll = () => replacement.getAll()
        inner.getByJobId = (jid: string) => replacement.getByJobId(jid)
        inner.add = (p: Payment) => replacement.add(p)
        inner.update = (pid: string, u: (p: Payment) => Payment) => replacement.update(pid, u)
        throw new Error('Simulated persistence failure on add')
      }
    },

    async update(paymentId: string, updater: (payment: Payment) => Payment): Promise<void> {
      // Capture previous state before update
      const previous = inner.getByJobId(
        inner.getAll().find((p) => p.id === paymentId)?.jobId ?? ''
      )

      // Optimistic local update
      await inner.update(paymentId, updater)

      // Simulate persistence failure after local update
      if (wrapper.failOnUpdate) {
        // Rollback — restore previous state
        if (previous) {
          await inner.update(paymentId, () => previous)
        }
        throw new Error('Simulated persistence failure on update')
      }
    },
  }
  return wrapper
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Block 3 — Payment Write Integrity', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // -------------------------------------------------------------------------
  // PART 1: Interface contract — add() and update() return Promise<void>
  // -------------------------------------------------------------------------

  describe('PaymentRepository interface contract', () => {
    it('add() returns a Promise', async () => {
      const repo = getPaymentRepository()
      const payment: Payment = {
        id: 'pay-1',
        jobId: 'job-1',
        state: 'deposit_required',
        amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const result = repo.add(payment)
      expect(result).toBeInstanceOf(Promise)
      await result
    })

    it('update() returns a Promise', async () => {
      const repo = getPaymentRepository()
      const payment: Payment = {
        id: 'pay-2',
        jobId: 'job-2',
        state: 'deposit_required',
        amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await repo.add(payment)
      const result = repo.update('pay-2', (p) => ({ ...p, updatedAt: Date.now() }))
      expect(result).toBeInstanceOf(Promise)
      await result
    })
  })

  // -------------------------------------------------------------------------
  // PART 2: Successful persistence updates local state correctly
  // -------------------------------------------------------------------------

  describe('successful persistence', () => {
    it('createPaymentForJob stores payment in repository on success', async () => {
      const payment = await createPaymentForJob('job-ok', 2000)
      expect(payment).toBeDefined()
      expect(payment.jobId).toBe('job-ok')
      expect(payment.state).toBe('deposit_required')

      const stored = getPaymentForJob('job-ok')
      expect(stored).toBeDefined()
      expect(stored!.id).toBe(payment.id)
    })

    it('updatePaymentState transitions state correctly on success', async () => {
      await createPaymentForJob('job-ok2', 2000)
      const updated = await updatePaymentState('job-ok2', 'deposit_paid')
      expect(updated).toBeDefined()
      expect(updated!.state).toBe('deposit_paid')

      const stored = getPaymentForJob('job-ok2')
      expect(stored!.state).toBe('deposit_paid')
    })

    it('ensurePaymentForJob is idempotent', async () => {
      const first = await ensurePaymentForJob('job-idem', 2000)
      const second = await ensurePaymentForJob('job-idem', 2000)
      expect(first.id).toBe(second.id)
      expect(first.state).toBe(second.state)
    })
  })

  // -------------------------------------------------------------------------
  // PART 3: Failed persistence does NOT leave phantom success state
  // -------------------------------------------------------------------------

  describe('failed persistence — no phantom success', () => {
    it('failed add() does not leave payment in repository', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      failableRepo.failOnAdd = true

      await expect(
        createPaymentForJob('job-fail-add', 2000)
      ).rejects.toThrow('Simulated persistence failure on add')

      // The payment must NOT exist in the repository
      const stored = getPaymentForJob('job-fail-add')
      expect(stored).toBeUndefined()
    })

    it('failed update() restores prior state in repository', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      // First, successfully create a payment
      await createPaymentForJob('job-fail-update', 2000)
      const before = getPaymentForJob('job-fail-update')
      expect(before).toBeDefined()
      expect(before!.state).toBe('deposit_required')

      // Now fail the update
      failableRepo.failOnUpdate = true

      await expect(
        updatePaymentState('job-fail-update', 'deposit_paid')
      ).rejects.toThrow('Simulated persistence failure on update')

      // The payment state must be rolled back to deposit_required
      const after = getPaymentForJob('job-fail-update')
      expect(after).toBeDefined()
      expect(after!.state).toBe('deposit_required')
    })

    it('repeated failures do not accumulate phantom state', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-repeat', 2000)
      failableRepo.failOnUpdate = true

      // Attempt transition multiple times
      for (let i = 0; i < 3; i++) {
        await expect(
          updatePaymentState('job-repeat', 'deposit_paid')
        ).rejects.toThrow()
      }

      // State must still be deposit_required after all failures
      const stored = getPaymentForJob('job-repeat')
      expect(stored!.state).toBe('deposit_required')
    })

    it('successful retry after failure correctly updates state', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-retry', 2000)

      // First attempt fails
      failableRepo.failOnUpdate = true
      await expect(
        updatePaymentState('job-retry', 'deposit_paid')
      ).rejects.toThrow()

      // State is still deposit_required
      expect(getPaymentForJob('job-retry')!.state).toBe('deposit_required')

      // Retry succeeds
      failableRepo.failOnUpdate = false
      const updated = await updatePaymentState('job-retry', 'deposit_paid')
      expect(updated!.state).toBe('deposit_paid')
      expect(getPaymentForJob('job-retry')!.state).toBe('deposit_paid')
    })
  })

  // -------------------------------------------------------------------------
  // PART 4: Callers can distinguish success from failure
  // -------------------------------------------------------------------------

  describe('failure is explicit and observable', () => {
    it('callers receive thrown error from failed add', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)
      failableRepo.failOnAdd = true

      let caughtError: unknown = null
      try {
        await createPaymentForJob('job-err', 2000)
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).not.toBeNull()
      expect(caughtError).toBeInstanceOf(Error)
    })

    it('callers receive thrown error from failed update', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-err2', 2000)
      failableRepo.failOnUpdate = true

      let caughtError: unknown = null
      try {
        await updatePaymentState('job-err2', 'deposit_paid')
      } catch (err) {
        caughtError = err
      }

      expect(caughtError).not.toBeNull()
      expect(caughtError).toBeInstanceOf(Error)
    })

    it('successful write returns updated payment (not undefined)', async () => {
      await createPaymentForJob('job-success', 2000)
      const result = await updatePaymentState('job-success', 'deposit_paid')
      expect(result).toBeDefined()
      expect(result!.state).toBe('deposit_paid')
    })
  })

  // -------------------------------------------------------------------------
  // PART 5: No phantom deposit_paid / in_escrow after failed write
  // -------------------------------------------------------------------------

  describe('no phantom payment states after failed writes', () => {
    it('no phantom deposit_paid after failed deposit transition', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-phantom-dp', 2000)
      failableRepo.failOnUpdate = true

      await expect(
        updatePaymentState('job-phantom-dp', 'deposit_paid')
      ).rejects.toThrow()

      // deposit_paid must NOT be observable
      const payment = getPaymentForJob('job-phantom-dp')
      expect(payment!.state).not.toBe('deposit_paid')
      expect(payment!.state).toBe('deposit_required')
    })

    it('no phantom in_escrow after failed escrow lock', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-phantom-ie', 2000)

      // First advance to deposit_paid successfully
      const afterDeposit = await updatePaymentState('job-phantom-ie', 'deposit_paid')
      expect(afterDeposit!.state).toBe('deposit_paid')

      // Now fail the in_escrow transition
      failableRepo.failOnUpdate = true
      await expect(
        updatePaymentState('job-phantom-ie', 'in_escrow')
      ).rejects.toThrow()

      // in_escrow must NOT be observable — state rolled back to deposit_paid
      const payment = getPaymentForJob('job-phantom-ie')
      expect(payment!.state).not.toBe('in_escrow')
      expect(payment!.state).toBe('deposit_paid')
    })

    it('no phantom work_in_progress after failed transition', async () => {
      const failableRepo = createFailableRepository()
      setPaymentRepository(failableRepo)

      await createPaymentForJob('job-phantom-wip', 2000)
      await updatePaymentState('job-phantom-wip', 'deposit_paid')
      await updatePaymentState('job-phantom-wip', 'in_escrow')

      // State is now in_escrow
      expect(getPaymentForJob('job-phantom-wip')!.state).toBe('in_escrow')

      failableRepo.failOnUpdate = true
      await expect(
        updatePaymentState('job-phantom-wip', 'work_in_progress')
      ).rejects.toThrow()

      // work_in_progress must NOT be observable
      const payment = getPaymentForJob('job-phantom-wip')
      expect(payment!.state).toBe('in_escrow')
    })
  })

  // -------------------------------------------------------------------------
  // PART 6: No regression to Block 2 downstream propagation
  // -------------------------------------------------------------------------

  describe('no regression to Block 2 propagation', () => {
    it('successful payment state change still allows downstream sync', async () => {
      await createPaymentForJob('job-b2', 2000)
      const updated = await updatePaymentState('job-b2', 'deposit_paid')

      // The updated payment is returned, enabling downstream sync
      expect(updated).toBeDefined()
      expect(updated!.state).toBe('deposit_paid')
      expect(updated!.jobId).toBe('job-b2')
    })
  })

  // -------------------------------------------------------------------------
  // PART 7: No regression to Block 1 hydration semantics
  // -------------------------------------------------------------------------

  describe('no regression to Block 1 hydration semantics', () => {
    it('InMemoryPaymentRepository isHydrated() returns true', () => {
      const repo = new InMemoryPaymentRepository([])
      expect(repo.isHydrated()).toBe(true)
    })

    it('add/update on InMemoryPaymentRepository are trivially async', async () => {
      const repo = new InMemoryPaymentRepository([])
      const payment: Payment = {
        id: 'pay-h1',
        jobId: 'job-h1',
        state: 'deposit_required',
        amounts: { totalAmount: 2000, depositAmount: 500, finalAmount: 1500 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // add returns Promise<void>
      await expect(repo.add(payment)).resolves.toBeUndefined()

      // update returns Promise<void>
      await expect(
        repo.update('pay-h1', (p) => ({ ...p, state: 'deposit_paid' as const }))
      ).resolves.toBeUndefined()

      expect(repo.getByJobId('job-h1')!.state).toBe('deposit_paid')
    })
  })
})
