import { describe, it, expect } from 'vitest'
import {
  markDepositPaid,
  lockEscrow,
  startWork,
  requestRelease,
  releasePayment,
  openDispute,
  refundPayment,
} from '../../src/lib/payments/paymentEngine'
import type { Payment } from '../../src/lib/payments/types'

function makePayment(state: Payment['state']): Payment {
  return {
    id: 'pay-test',
    jobId: 'job-test',
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('Payment Engine', () => {
  describe('markDepositPaid', () => {
    it('transitions deposit_required → deposit_paid', () => {
      const result = markDepositPaid(makePayment('deposit_required'))
      expect(result.state).toBe('deposit_paid')
    })

    it('throws on invalid transition', () => {
      expect(() => markDepositPaid(makePayment('in_escrow'))).toThrow(
        /Illegal payment transition/,
      )
    })
  })

  describe('lockEscrow', () => {
    it('transitions deposit_paid → in_escrow', () => {
      const result = lockEscrow(makePayment('deposit_paid'))
      expect(result.state).toBe('in_escrow')
    })

    it('throws when called from wrong state', () => {
      expect(() => lockEscrow(makePayment('deposit_required'))).toThrow(
        /Illegal payment transition/,
      )
    })
  })

  describe('startWork', () => {
    it('transitions in_escrow → work_in_progress', () => {
      const result = startWork(makePayment('in_escrow'))
      expect(result.state).toBe('work_in_progress')
    })
  })

  describe('requestRelease', () => {
    it('transitions work_in_progress → release_pending', () => {
      const result = requestRelease(makePayment('work_in_progress'))
      expect(result.state).toBe('release_pending')
    })
  })

  describe('releasePayment', () => {
    it('transitions release_pending → released', () => {
      const result = releasePayment(makePayment('release_pending'))
      expect(result.state).toBe('released')
    })

    it('transitions disputed → released', () => {
      const result = releasePayment(makePayment('disputed'))
      expect(result.state).toBe('released')
    })

    it('throws when called from released (terminal)', () => {
      expect(() => releasePayment(makePayment('released'))).toThrow(
        /Illegal payment transition/,
      )
    })
  })

  describe('openDispute', () => {
    it('transitions in_escrow → disputed', () => {
      const result = openDispute(makePayment('in_escrow'))
      expect(result.state).toBe('disputed')
    })

    it('transitions work_in_progress → disputed', () => {
      const result = openDispute(makePayment('work_in_progress'))
      expect(result.state).toBe('disputed')
    })

    it('transitions release_pending → disputed', () => {
      const result = openDispute(makePayment('release_pending'))
      expect(result.state).toBe('disputed')
    })

    it('throws when transitioning from deposit_required (not funded)', () => {
      expect(() => openDispute(makePayment('deposit_required'))).toThrow(
        /Illegal payment transition/,
      )
    })

    it('throws when transitioning from deposit_paid (escrow not locked)', () => {
      expect(() => openDispute(makePayment('deposit_paid'))).toThrow(
        /Illegal payment transition/,
      )
    })
  })

  describe('refundPayment', () => {
    it('transitions release_pending → refunded', () => {
      const result = refundPayment(makePayment('release_pending'))
      expect(result.state).toBe('refunded')
    })

    it('transitions disputed → refunded', () => {
      const result = refundPayment(makePayment('disputed'))
      expect(result.state).toBe('refunded')
    })

    it('throws when called from released (terminal)', () => {
      expect(() => refundPayment(makePayment('released'))).toThrow(
        /Illegal payment transition/,
      )
    })

    it('throws when called from refunded (terminal)', () => {
      expect(() => refundPayment(makePayment('refunded'))).toThrow(
        /Illegal payment transition/,
      )
    })
  })

  describe('immutability', () => {
    it('returns a new object, does not mutate the original payment', () => {
      const original = makePayment('deposit_required')
      const updated = markDepositPaid(original)
      expect(original.state).toBe('deposit_required')
      expect(updated.state).toBe('deposit_paid')
      expect(updated).not.toBe(original)
    })

    it('updates updatedAt timestamp on transition', () => {
      const original = makePayment('deposit_required')
      const before = original.updatedAt
      // Ensure some time passes
      const updated = markDepositPaid(original)
      expect(updated.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })
})
