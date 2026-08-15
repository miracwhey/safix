import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createPaymentForJob,
  updatePaymentState,
  getPaymentForJob,
} from '../../src/lib/payments/service'
import { getLedgerRepository } from '../../src/lib/payments/ledger/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository'

describe('Payment Service – ledger entry creation', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  describe('createPaymentForJob', () => {
    it('creates an escrow_created ledger entry', async () => {
      await createPaymentForJob('job-a', 2000)

      const entries = getLedgerRepository().getForJob('job-a')
      const escrowEntry = entries.find((e) => e.type === 'escrow_created')
      expect(escrowEntry).toBeDefined()
      expect(escrowEntry!.amount).toBe(2000)
      expect(escrowEntry!.jobId).toBe('job-a')
    })

    it('is idempotent — does not create duplicate escrow entries', async () => {
      await createPaymentForJob('job-b', 2000)
      await createPaymentForJob('job-b', 2000)

      const entries = getLedgerRepository().getForJob('job-b')
      const escrowEntries = entries.filter((e) => e.type === 'escrow_created')
      expect(escrowEntries).toHaveLength(1)
    })
  })

  describe('updatePaymentState to deposit_paid', () => {
    it('creates a deposit_paid ledger entry', async () => {
      await createPaymentForJob('job-c', 1000)
      await updatePaymentState('job-c', 'deposit_paid')

      const entries = getLedgerRepository().getForJob('job-c')
      const depositEntry = entries.find((e) => e.type === 'deposit_paid')
      expect(depositEntry).toBeDefined()
      expect(depositEntry!.amount).toBe(250) // 25% of 1000
    })
  })

  describe('updatePaymentState to disputed', () => {
    it('creates a dispute_hold ledger entry with totalAmount', async () => {
      await createPaymentForJob('job-d', 1200)
      await updatePaymentState('job-d', 'deposit_paid')
      await updatePaymentState('job-d', 'in_escrow')
      await updatePaymentState('job-d', 'disputed', { disputeId: 'dispute-test-1' })

      const entries = getLedgerRepository().getForJob('job-d')
      const holdEntry = entries.find((e) => e.type === 'dispute_hold')
      expect(holdEntry).toBeDefined()
      expect(holdEntry!.amount).toBe(1200)
      expect(holdEntry!.disputeId).toBe('dispute-test-1')
    })

    it('does not create duplicate dispute_hold entries for the same job', async () => {
      await createPaymentForJob('job-e', 800)
      await updatePaymentState('job-e', 'deposit_paid')
      await updatePaymentState('job-e', 'in_escrow')
      await updatePaymentState('job-e', 'disputed', { disputeId: 'dispute-test-2' })

      // Attempting to transition to disputed again is idempotent (same state)
      const payment = getPaymentForJob('job-e')
      expect(payment?.state).toBe('disputed')

      const entries = getLedgerRepository().getForJob('job-e')
      const holdEntries = entries.filter((e) => e.type === 'dispute_hold')
      expect(holdEntries).toHaveLength(1)
    })
  })

  describe('updatePaymentState to released', () => {
    it('creates final_paid, platform_fee, and payout ledger entries', async () => {
      await createPaymentForJob('job-f', 1000)
      await updatePaymentState('job-f', 'deposit_paid')
      await updatePaymentState('job-f', 'in_escrow')
      await updatePaymentState('job-f', 'work_in_progress')
      await updatePaymentState('job-f', 'release_pending')
      await updatePaymentState('job-f', 'released')

      const entries = getLedgerRepository().getForJob('job-f')
      const types = entries.map((e) => e.type)

      expect(types).toContain('final_paid')
      expect(types).toContain('platform_fee')
      expect(types).toContain('payout')
    })

    it('creates dispute_resolved_release entry when released from dispute', async () => {
      await createPaymentForJob('job-g', 1000)
      await updatePaymentState('job-g', 'deposit_paid')
      await updatePaymentState('job-g', 'in_escrow')
      await updatePaymentState('job-g', 'disputed', { disputeId: 'dispute-test-3' })
      await updatePaymentState('job-g', 'released', { disputeId: 'dispute-test-3' })

      const entries = getLedgerRepository().getForJob('job-g')
      const resolvedEntry = entries.find((e) => e.type === 'dispute_resolved_release')
      expect(resolvedEntry).toBeDefined()
      expect(resolvedEntry!.disputeId).toBe('dispute-test-3')
    })
  })

  describe('updatePaymentState to refunded', () => {
    it('creates a refund ledger entry', async () => {
      await createPaymentForJob('job-h', 500)
      await updatePaymentState('job-h', 'deposit_paid')
      await updatePaymentState('job-h', 'refunded')

      const entries = getLedgerRepository().getForJob('job-h')
      const refundEntry = entries.find((e) => e.type === 'refund')
      expect(refundEntry).toBeDefined()
      expect(refundEntry!.amount).toBe(500)
    })

    it('creates a dispute_resolved_refund entry when refunded from dispute', async () => {
      await createPaymentForJob('job-i', 900)
      await updatePaymentState('job-i', 'deposit_paid')
      await updatePaymentState('job-i', 'in_escrow')
      await updatePaymentState('job-i', 'disputed', { disputeId: 'dispute-test-4' })
      await updatePaymentState('job-i', 'refunded', { disputeId: 'dispute-test-4' })

      const entries = getLedgerRepository().getForJob('job-i')
      const resolvedEntry = entries.find((e) => e.type === 'dispute_resolved_refund')
      expect(resolvedEntry).toBeDefined()
      expect(resolvedEntry!.disputeId).toBe('dispute-test-4')
    })

    it('uses refundedAmount for ledger entry when provided (partial refund)', async () => {
      await createPaymentForJob('job-m', 1000)
      await updatePaymentState('job-m', 'deposit_paid')
      await updatePaymentState('job-m', 'refunded', { refundedAmount: 250 })

      const entries = getLedgerRepository().getForJob('job-m')
      const refundEntry = entries.find((e) => e.type === 'refund')
      expect(refundEntry).toBeDefined()
      expect(refundEntry!.amount).toBe(250)
    })

    it('persists refundedAmount on the payment entity when provided', async () => {
      await createPaymentForJob('job-n', 800)
      await updatePaymentState('job-n', 'deposit_paid')
      await updatePaymentState('job-n', 'refunded', { refundedAmount: 800 })

      const payment = getPaymentRepository().getByJobId('job-n')
      expect(payment).toBeDefined()
      expect(payment!.refundedAmount).toBe(800)
    })

    it('falls back to totalAmount for ledger when refundedAmount is not provided', async () => {
      await createPaymentForJob('job-o', 600)
      await updatePaymentState('job-o', 'deposit_paid')
      await updatePaymentState('job-o', 'refunded')

      const entries = getLedgerRepository().getForJob('job-o')
      const refundEntry = entries.find((e) => e.type === 'refund')
      expect(refundEntry).toBeDefined()
      expect(refundEntry!.amount).toBe(600)
    })

    it('writes dispute_resolved_refund and NOT refund when refunded from dispute', async () => {
      await createPaymentForJob('job-p', 1000)
      await updatePaymentState('job-p', 'deposit_paid')
      await updatePaymentState('job-p', 'in_escrow')
      await updatePaymentState('job-p', 'disputed', { disputeId: 'dispute-classify-5' })
      await updatePaymentState('job-p', 'refunded', { disputeId: 'dispute-classify-5' })

      const entries = getLedgerRepository().getForJob('job-p')
      const types = entries.map((e) => e.type)

      // Dispute path must produce dispute_resolved_refund, never plain refund.
      // Coexistence would cause getRefunds() to double-count.
      expect(types).toContain('dispute_resolved_refund')
      expect(types).not.toContain('refund')
    })

    it('does not produce duplicate refund ledger entries (NON_REPEATING guard)', async () => {
      await createPaymentForJob('job-q', 1000)
      await updatePaymentState('job-q', 'deposit_paid')
      await updatePaymentState('job-q', 'refunded')

      const entries = getLedgerRepository().getForJob('job-q')
      const refundEntries = entries.filter((e) => e.type === 'refund')
      expect(refundEntries).toHaveLength(1)
    })
  })

  describe('updatePaymentState to released with splitRatio', () => {
    it('creates dispute_resolved_release, platform_fee, and dispute_resolved_refund entries', async () => {
      await createPaymentForJob('job-j', 1000)
      await updatePaymentState('job-j', 'deposit_paid')
      await updatePaymentState('job-j', 'in_escrow')
      await updatePaymentState('job-j', 'disputed', { disputeId: 'dispute-split-1' })
      await updatePaymentState('job-j', 'released', { disputeId: 'dispute-split-1', splitRatio: 0.7 })

      const entries = getLedgerRepository().getForJob('job-j')
      const types = entries.map((e) => e.type)

      expect(types).toContain('dispute_resolved_release')
      expect(types).toContain('platform_fee')
      expect(types).toContain('dispute_resolved_refund')
      // Full payout/final_paid entries must NOT appear for a split
      expect(types).not.toContain('payout')
      expect(types).not.toContain('final_paid')
    })

    it('split ledger amounts are proportional: craftsman 70 %, customer 30 %', async () => {
      await createPaymentForJob('job-k', 1000)
      await updatePaymentState('job-k', 'deposit_paid')
      await updatePaymentState('job-k', 'in_escrow')
      await updatePaymentState('job-k', 'disputed', { disputeId: 'dispute-split-2' })
      await updatePaymentState('job-k', 'released', { disputeId: 'dispute-split-2', splitRatio: 0.7 })

      const entries = getLedgerRepository().getForJob('job-k')
      const releaseEntry = entries.find((e) => e.type === 'dispute_resolved_release')
      const feeEntry = entries.find((e) => e.type === 'platform_fee')
      const refundEntry = entries.find((e) => e.type === 'dispute_resolved_refund')

      // Craftsman net = 70 % * 91 % * 1000 = 637 (9 % default fee, no commercialOrigin)
      expect(releaseEntry!.amount).toBeCloseTo(637, 0)
      // Platform fee = 70 % * 9 % * 1000 = 63 (9 % default fee, no commercialOrigin)
      expect(feeEntry!.amount).toBeCloseTo(63, 0)
      // Customer refund = 30 % * 1000 = 300
      expect(refundEntry!.amount).toBeCloseTo(300, 0)
    })

    it('split entries sum equals totalAmount', async () => {
      await createPaymentForJob('job-l', 2000)
      await updatePaymentState('job-l', 'deposit_paid')
      await updatePaymentState('job-l', 'in_escrow')
      await updatePaymentState('job-l', 'disputed', { disputeId: 'dispute-split-3' })
      await updatePaymentState('job-l', 'released', { disputeId: 'dispute-split-3', splitRatio: 0.5 })

      const entries = getLedgerRepository().getForJob('job-l')
      const release = entries.find((e) => e.type === 'dispute_resolved_release')!.amount
      const fee = entries.find((e) => e.type === 'platform_fee')!.amount
      const refund = entries.find((e) => e.type === 'dispute_resolved_refund')!.amount

      expect(release + fee + refund).toBeCloseTo(2000, 1)
    })
  })
})
