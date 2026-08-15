import { describe, it, expect } from 'vitest'
import {
  canTransition,
  allowedTransitions,
} from '../../src/lib/payments/stateMachine'
import type { PaymentState } from '../../src/lib/payments/types'

describe('Payment State Machine', () => {
  describe('canTransition', () => {
    it('allows deposit_required → deposit_paid', () => {
      expect(canTransition('deposit_required', 'deposit_paid')).toBe(true)
    })

    it('allows deposit_paid → in_escrow', () => {
      expect(canTransition('deposit_paid', 'in_escrow')).toBe(true)
    })

    it('allows in_escrow → work_in_progress', () => {
      expect(canTransition('in_escrow', 'work_in_progress')).toBe(true)
    })

    it('allows work_in_progress → release_pending', () => {
      expect(canTransition('work_in_progress', 'release_pending')).toBe(true)
    })

    it('allows release_pending → released (escrow deposit → release pending → released)', () => {
      expect(canTransition('in_escrow', 'disputed')).toBe(true)
      expect(canTransition('release_pending', 'released')).toBe(true)
    })

    it('allows in_escrow → disputed (dispute from in_escrow)', () => {
      expect(canTransition('in_escrow', 'disputed')).toBe(true)
    })

    it('allows work_in_progress → disputed', () => {
      expect(canTransition('work_in_progress', 'disputed')).toBe(true)
    })

    it('allows release_pending → disputed', () => {
      expect(canTransition('release_pending', 'disputed')).toBe(true)
    })

    it('allows release_pending → refunded (refund transition)', () => {
      expect(canTransition('release_pending', 'refunded')).toBe(true)
    })

    it('allows deposit_paid → refunded', () => {
      expect(canTransition('deposit_paid', 'refunded')).toBe(true)
    })

    it('allows disputed → released', () => {
      expect(canTransition('disputed', 'released')).toBe(true)
    })

    it('allows disputed → refunded', () => {
      expect(canTransition('disputed', 'refunded')).toBe(true)
    })

    it('rejects invalid transition: deposit_required → in_escrow (skip step)', () => {
      expect(canTransition('deposit_required', 'in_escrow')).toBe(false)
    })

    it('rejects invalid transition: deposit_required → disputed (not funded)', () => {
      expect(canTransition('deposit_required', 'disputed')).toBe(false)
    })

    it('rejects invalid transition: deposit_paid → disputed (not in escrow)', () => {
      expect(canTransition('deposit_paid', 'disputed')).toBe(false)
    })

    it('rejects invalid transition: in_escrow → released (skip release_pending)', () => {
      expect(canTransition('in_escrow', 'released')).toBe(false)
    })

    it('rejects invalid transition: released → refunded (terminal state)', () => {
      expect(canTransition('released', 'refunded')).toBe(false)
    })

    it('rejects invalid transition: refunded → released (terminal state)', () => {
      expect(canTransition('refunded', 'released')).toBe(false)
    })
  })

  describe('allowedTransitions completeness', () => {
    const allStates: PaymentState[] = [
      'deposit_required',
      'deposit_paid',
      'in_escrow',
      'work_in_progress',
      'release_pending',
      'released',
      'disputed',
      'refunded',
    ]

    it('has an entry for every known PaymentState', () => {
      for (const state of allStates) {
        expect(allowedTransitions).toHaveProperty(state)
      }
    })

    it('released and refunded are terminal states (no outgoing transitions)', () => {
      expect(allowedTransitions['released']).toHaveLength(0)
      expect(allowedTransitions['refunded']).toHaveLength(0)
    })
  })
})
