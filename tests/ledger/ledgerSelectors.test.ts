import { describe, it, expect } from 'vitest'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'
import {
  getGMV,
  getRevenue,
  getPayouts,
  getRefunds,
  getOpenEscrow,
  getDisputeHoldCount,
  getDisputeSettlementsCount,
  getFinanceKPIs,
} from '../../src/lib/payments/ledger/ledgerSelectors'

function entry(
  overrides: Partial<LedgerEntry> & Pick<LedgerEntry, 'type' | 'amount'>,
): LedgerEntry {
  return {
    id: `ledger-${Math.random().toString(36).slice(2)}`,
    paymentId: 'pay-1',
    jobId: 'job-1',
    currency: 'EUR',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('Ledger Selectors', () => {
  describe('getGMV', () => {
    it('sums all escrow_created amounts', () => {
      const entries = [
        entry({ type: 'escrow_created', amount: 1000 }),
        entry({ type: 'escrow_created', amount: 2000 }),
        entry({ type: 'payout', amount: 500 }),
      ]
      expect(getGMV(entries)).toBe(3000)
    })

    it('returns 0 for empty list', () => {
      expect(getGMV([])).toBe(0)
    })
  })

  describe('getRevenue', () => {
    it('sums all platform_fee amounts', () => {
      const entries = [
        entry({ type: 'platform_fee', amount: 120 }),
        entry({ type: 'platform_fee', amount: 80 }),
        entry({ type: 'payout', amount: 800 }),
      ]
      expect(getRevenue(entries)).toBe(200)
    })
  })

  describe('getPayouts', () => {
    it('sums payout and dispute_resolved_release amounts', () => {
      const entries = [
        entry({ type: 'payout', amount: 880 }),
        entry({ type: 'dispute_resolved_release', amount: 760 }),
        entry({ type: 'refund', amount: 500 }),
      ]
      expect(getPayouts(entries)).toBe(1640)
    })

    it('transfer_reversal (negative) reduces net payouts', () => {
      const entries = [
        entry({ type: 'payout', amount: 750 }),
        entry({ type: 'transfer_reversal', amount: -750 }),
      ]
      expect(getPayouts(entries)).toBe(0)
    })

    it('partial reversal reduces net payouts by reversal amount', () => {
      const entries = [
        entry({ type: 'payout', amount: 250 }),
        entry({ type: 'payout', amount: 750 }),
        entry({ type: 'transfer_reversal', amount: -250 }),
      ]
      expect(getPayouts(entries)).toBe(750)
    })
  })

  describe('getRefunds', () => {
    it('sums refund and dispute_resolved_refund amounts', () => {
      const entries = [
        entry({ type: 'refund', amount: 500 }),
        entry({ type: 'dispute_resolved_refund', amount: 300 }),
        entry({ type: 'payout', amount: 880 }),
      ]
      expect(getRefunds(entries)).toBe(800)
    })

    it('double-count invariant: both refund and dispute_resolved_refund on same payment sums both', () => {
      // Documents that coexistence of both types causes double-count.
      // The webhook reconcileChargeRefunded guard (skip ledger write for disputed source state)
      // is what prevents this scenario in production.
      const entries = [
        entry({ type: 'refund', amount: 1000, paymentId: 'pay-x' }),
        entry({ type: 'dispute_resolved_refund', amount: 1000, paymentId: 'pay-x' }),
      ]
      expect(getRefunds(entries)).toBe(2000)
    })
  })

  describe('getOpenEscrow', () => {
    it('returns escrow_created minus payouts and refunds', () => {
      const entries = [
        entry({ type: 'escrow_created', amount: 3000 }),
        entry({ type: 'payout', amount: 880 }),
        entry({ type: 'platform_fee', amount: 120 }),
      ]
      expect(getOpenEscrow(entries)).toBe(3000 - 880 - 120)
    })

    it('does not go below zero', () => {
      const entries = [
        entry({ type: 'escrow_created', amount: 100 }),
        entry({ type: 'payout', amount: 999 }),
      ]
      expect(getOpenEscrow(entries)).toBe(0)
    })

    it('transfer_reversal (negative) adds funds back to open escrow', () => {
      // payout took 750 out; reversal returns it → openEscrow back to full
      const entries = [
        entry({ type: 'escrow_created', amount: 1000 }),
        entry({ type: 'payout', amount: 750 }),
        entry({ type: 'transfer_reversal', amount: -750 }),
      ]
      expect(getOpenEscrow(entries)).toBe(1000)
    })
  })

  describe('getDisputeHoldCount', () => {
    it('counts dispute_hold entries', () => {
      const entries = [
        entry({ type: 'dispute_hold', amount: 1000 }),
        entry({ type: 'dispute_hold', amount: 500 }),
        entry({ type: 'payout', amount: 880 }),
      ]
      expect(getDisputeHoldCount(entries)).toBe(2)
    })

    it('returns 0 when no dispute_hold entries exist', () => {
      const entries = [entry({ type: 'payout', amount: 880 })]
      expect(getDisputeHoldCount(entries)).toBe(0)
    })
  })

  describe('getDisputeSettlementsCount', () => {
    it('counts dispute_resolved_release and dispute_resolved_refund entries', () => {
      const entries = [
        entry({ type: 'dispute_resolved_release', amount: 880 }),
        entry({ type: 'dispute_resolved_refund', amount: 500 }),
        entry({ type: 'payout', amount: 600 }),
      ]
      expect(getDisputeSettlementsCount(entries)).toBe(2)
    })
  })

  describe('getFinanceKPIs', () => {
    it('returns all KPIs in one call', () => {
      const entries = [
        entry({ type: 'escrow_created', amount: 1000 }),
        entry({ type: 'platform_fee', amount: 120 }),
        entry({ type: 'payout', amount: 880 }),
      ]
      const kpis = getFinanceKPIs(entries)
      expect(kpis.gmv).toBe(1000)
      expect(kpis.revenue).toBe(120)
      expect(kpis.payouts).toBe(880)
      expect(kpis.openEscrow).toBe(1000 - 880 - 120)
      expect(kpis.disputeHoldCount).toBe(0)
      expect(kpis.disputeSettlementsCount).toBe(0)
    })
  })
})
