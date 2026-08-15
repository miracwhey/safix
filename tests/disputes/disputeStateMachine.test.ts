import { describe, it, expect } from 'vitest'
import {
  canTransitionDispute,
  isDisputeBlocking,
  isTerminalDisputeStatus,
  disputeAllowedTransitions,
  ACTIVE_DISPUTE_STATUSES,
  TERMINAL_DISPUTE_STATUSES,
} from '../../src/lib/disputes/stateMachine'
import type { DisputeStatus } from '../../src/lib/disputes/types'

describe('Dispute State Machine', () => {
  describe('canTransitionDispute', () => {
    it('allows open → customer_waiting', () => {
      expect(canTransitionDispute('open', 'customer_waiting')).toBe(true)
    })

    it('allows open → provider_waiting', () => {
      expect(canTransitionDispute('open', 'provider_waiting')).toBe(true)
    })

    it('allows open → under_review', () => {
      expect(canTransitionDispute('open', 'under_review')).toBe(true)
    })

    it('allows customer_waiting → under_review', () => {
      expect(canTransitionDispute('customer_waiting', 'under_review')).toBe(true)
    })

    it('allows customer_waiting → resolved', () => {
      expect(canTransitionDispute('customer_waiting', 'resolved')).toBe(true)
    })

    it('allows customer_waiting → cancelled', () => {
      expect(canTransitionDispute('customer_waiting', 'cancelled')).toBe(true)
    })

    it('allows provider_waiting → under_review', () => {
      expect(canTransitionDispute('provider_waiting', 'under_review')).toBe(true)
    })

    it('allows provider_waiting → resolved', () => {
      expect(canTransitionDispute('provider_waiting', 'resolved')).toBe(true)
    })

    it('allows under_review → resolved', () => {
      expect(canTransitionDispute('under_review', 'resolved')).toBe(true)
    })

    it('allows under_review → customer_waiting', () => {
      expect(canTransitionDispute('under_review', 'customer_waiting')).toBe(true)
    })

    it('allows under_review → provider_waiting', () => {
      expect(canTransitionDispute('under_review', 'provider_waiting')).toBe(true)
    })

    it('allows under_review → cancelled', () => {
      expect(canTransitionDispute('under_review', 'cancelled')).toBe(true)
    })

    it('allows resolved → closed', () => {
      expect(canTransitionDispute('resolved', 'closed')).toBe(true)
    })

    it('rejects open → resolved (must go through review/waiting)', () => {
      expect(canTransitionDispute('open', 'resolved')).toBe(false)
    })

    it('rejects resolved → anything but closed (terminal-ish)', () => {
      const targets: DisputeStatus[] = [
        'open',
        'customer_waiting',
        'provider_waiting',
        'under_review',
        'resolved',
        'cancelled',
      ]
      for (const target of targets) {
        expect(canTransitionDispute('resolved', target)).toBe(false)
      }
    })

    it('rejects closed → anything (terminal)', () => {
      expect(canTransitionDispute('closed', 'open')).toBe(false)
      expect(canTransitionDispute('closed', 'resolved')).toBe(false)
    })

    it('rejects cancelled → anything (terminal)', () => {
      expect(canTransitionDispute('cancelled', 'under_review')).toBe(false)
      expect(canTransitionDispute('cancelled', 'resolved')).toBe(false)
    })
  })

  describe('isDisputeBlocking', () => {
    it('returns true for open', () => {
      expect(isDisputeBlocking('open')).toBe(true)
    })

    it('returns true for customer_waiting', () => {
      expect(isDisputeBlocking('customer_waiting')).toBe(true)
    })

    it('returns true for provider_waiting', () => {
      expect(isDisputeBlocking('provider_waiting')).toBe(true)
    })

    it('returns true for under_review', () => {
      expect(isDisputeBlocking('under_review')).toBe(true)
    })

    it('returns false for resolved', () => {
      expect(isDisputeBlocking('resolved')).toBe(false)
    })

    it('returns false for closed', () => {
      expect(isDisputeBlocking('closed')).toBe(false)
    })

    it('returns false for cancelled', () => {
      expect(isDisputeBlocking('cancelled')).toBe(false)
    })
  })

  describe('isTerminalDisputeStatus', () => {
    it('returns true for resolved, closed, cancelled', () => {
      expect(isTerminalDisputeStatus('resolved')).toBe(true)
      expect(isTerminalDisputeStatus('closed')).toBe(true)
      expect(isTerminalDisputeStatus('cancelled')).toBe(true)
    })

    it('returns false for active states', () => {
      expect(isTerminalDisputeStatus('open')).toBe(false)
      expect(isTerminalDisputeStatus('customer_waiting')).toBe(false)
      expect(isTerminalDisputeStatus('provider_waiting')).toBe(false)
      expect(isTerminalDisputeStatus('under_review')).toBe(false)
    })
  })

  describe('ACTIVE_DISPUTE_STATUSES / TERMINAL_DISPUTE_STATUSES sets', () => {
    it('ACTIVE_DISPUTE_STATUSES includes all blocking states', () => {
      expect(ACTIVE_DISPUTE_STATUSES.has('open')).toBe(true)
      expect(ACTIVE_DISPUTE_STATUSES.has('customer_waiting')).toBe(true)
      expect(ACTIVE_DISPUTE_STATUSES.has('provider_waiting')).toBe(true)
      expect(ACTIVE_DISPUTE_STATUSES.has('under_review')).toBe(true)
    })

    it('TERMINAL_DISPUTE_STATUSES contains exactly the terminal states', () => {
      expect(TERMINAL_DISPUTE_STATUSES.has('resolved')).toBe(true)
      expect(TERMINAL_DISPUTE_STATUSES.has('closed')).toBe(true)
      expect(TERMINAL_DISPUTE_STATUSES.has('cancelled')).toBe(true)
      expect(TERMINAL_DISPUTE_STATUSES.has('open')).toBe(false)
      expect(TERMINAL_DISPUTE_STATUSES.has('under_review')).toBe(false)
    })
  })

  describe('disputeAllowedTransitions completeness', () => {
    const allStatuses: DisputeStatus[] = [
      'open',
      'customer_waiting',
      'provider_waiting',
      'under_review',
      'resolved',
      'closed',
      'cancelled',
    ]

    it('has an entry for every known DisputeStatus', () => {
      for (const status of allStatuses) {
        expect(disputeAllowedTransitions).toHaveProperty(status)
      }
    })

    it('closed and cancelled are fully terminal (no outgoing transitions)', () => {
      expect(disputeAllowedTransitions.closed).toHaveLength(0)
      expect(disputeAllowedTransitions.cancelled).toHaveLength(0)
    })

    it('resolved transitions only to closed', () => {
      expect(disputeAllowedTransitions.resolved).toEqual(['closed'])
    })
  })
})
