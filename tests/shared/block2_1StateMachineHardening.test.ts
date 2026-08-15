/**
 * Sub-block 2.1 — Invoice State Machine Hardening + Refund Behaviour
 *
 * Verifies:
 *   A. All allowed transitions succeed
 *   B. All forbidden transitions throw
 *   C. paid and cancelled are terminal states
 *   D. refunded payment state does not auto-cancel a paid invoice:
 *      - mapPaymentStateToInvoiceStatus('refunded') → 'cancelled'
 *      - transitionInvoiceStatus(paidInvoice, 'cancelled') throws
 *      - double protection: engine-level + sync step-order
 *   E. existing payment/invoice bindings still work
 */

import { describe, it, expect } from 'vitest'

import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import { mapPaymentStateToInvoiceStatus } from '../../src/lib/invoices/paymentInvoiceSync'
import type { Invoice, InvoiceStatus } from '../../src/lib/invoices/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeInvoice(status: InvoiceStatus): Invoice {
  return {
    id: 'inv_job-1',
    jobId: 'job-1',
    invoiceNumber: 'FX-2026-0404-TEST',
    status,
    parties: {
      issuerName: 'Testbetrieb GmbH',
      issuerAddress: 'Musterstraße 1, 12345 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [
      { id: 'li_job-1', label: 'Sanitärarbeiten', quantity: 1, unitPrice: 840.34, total: 840.34 },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 0,
    issuedAtLabel: 'Noch nicht ausgestellt',
    dueAtLabel: 'Noch nicht fällig',
    createdAt: 1000,
    updatedAt: 1000,
  }
}

// ── A. Allowed Transitions ────────────────────────────────────────────────────

describe('Sub-block 2.1 — Invoice State Machine Hardening', () => {
  describe('A. Allowed transitions', () => {
    it('draft → issued succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('draft'), 'issued')
      expect(result.status).toBe('issued')
    })

    it('draft → cancelled succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('draft'), 'cancelled')
      expect(result.status).toBe('cancelled')
    })

    it('issued → sent succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('issued'), 'sent')
      expect(result.status).toBe('sent')
    })

    it('issued → paid succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('issued'), 'paid')
      expect(result.status).toBe('paid')
    })

    it('issued → cancelled succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('issued'), 'cancelled')
      expect(result.status).toBe('cancelled')
    })

    it('sent → paid succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('sent'), 'paid')
      expect(result.status).toBe('paid')
    })

    it('sent → cancelled succeeds', () => {
      const result = transitionInvoiceStatus(makeInvoice('sent'), 'cancelled')
      expect(result.status).toBe('cancelled')
    })
  })

  // ── B. Forbidden Transitions ───────────────────────────────────────────────

  describe('B. Forbidden transitions — each throws', () => {
    it('paid → cancelled throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), 'cancelled')
      ).toThrow('Illegal invoice transition: paid → cancelled')
    })

    it('paid → issued throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), 'issued')
      ).toThrow('Illegal invoice transition: paid → issued')
    })

    it('paid → sent throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), 'sent')
      ).toThrow('Illegal invoice transition: paid → sent')
    })

    it('paid → draft throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), 'draft')
      ).toThrow('Illegal invoice transition: paid → draft')
    })

    it('cancelled → issued throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('cancelled'), 'issued')
      ).toThrow('Illegal invoice transition: cancelled → issued')
    })

    it('cancelled → sent throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('cancelled'), 'sent')
      ).toThrow('Illegal invoice transition: cancelled → sent')
    })

    it('cancelled → paid throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('cancelled'), 'paid')
      ).toThrow('Illegal invoice transition: cancelled → paid')
    })

    it('issued → draft throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('issued'), 'draft')
      ).toThrow('Illegal invoice transition: issued → draft')
    })

    it('sent → issued throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('sent'), 'issued')
      ).toThrow('Illegal invoice transition: sent → issued')
    })

    it('sent → draft throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('sent'), 'draft')
      ).toThrow('Illegal invoice transition: sent → draft')
    })

    it('draft → paid throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('draft'), 'paid')
      ).toThrow('Illegal invoice transition: draft → paid')
    })

    it('draft → sent throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeInvoice('draft'), 'sent')
      ).toThrow('Illegal invoice transition: draft → sent')
    })
  })

  // ── C. Terminal States ─────────────────────────────────────────────────────

  describe('C. Terminal states — paid and cancelled have no outbound transitions', () => {
    const statuses: InvoiceStatus[] = ['draft', 'issued', 'sent', 'paid', 'cancelled']

    for (const target of statuses) {
      it(`paid → ${target} throws`, () => {
        expect(() =>
          transitionInvoiceStatus(makeInvoice('paid'), target)
        ).toThrow(/Illegal invoice transition: paid/)
      })
    }

    for (const target of statuses) {
      it(`cancelled → ${target} throws`, () => {
        expect(() =>
          transitionInvoiceStatus(makeInvoice('cancelled'), target)
        ).toThrow(/Illegal invoice transition: cancelled/)
      })
    }
  })

  // ── D. Refund Behaviour ────────────────────────────────────────────────────

  describe('D. Refund behaviour — paid invoice stays paid when payment is refunded', () => {
    it('mapPaymentStateToInvoiceStatus("refunded") returns "cancelled"', () => {
      // The mapping is semantically correct: a refunded payment targets
      // a cancelled invoice. But syncInvoiceWithPayment's step-order
      // excludes 'cancelled', making this a no-op at the service level.
      expect(mapPaymentStateToInvoiceStatus('refunded')).toBe('cancelled')
    })

    it('transitionInvoiceStatus(paid, "cancelled") throws — engine-level block', () => {
      // Even if syncInvoiceWithPayment attempted the transition, the engine
      // would block it. paid is terminal. This is the second layer of protection.
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), 'cancelled')
      ).toThrow('Illegal invoice transition: paid → cancelled')
    })

    it('the refunded path cannot reach "cancelled" from "paid" — double protection', () => {
      // Proof: mapping returns 'cancelled', engine throws on paid → cancelled.
      // Any code path that (1) reads mapPaymentStateToInvoiceStatus('refunded')
      // and (2) attempts transitionInvoiceStatus will be blocked at the engine.
      const targetStatus = mapPaymentStateToInvoiceStatus('refunded')
      expect(targetStatus).toBe('cancelled')
      expect(() =>
        transitionInvoiceStatus(makeInvoice('paid'), targetStatus)
      ).toThrow()
    })

    it('a paid invoice is unchanged when the refunded mapping is applied via transition attempt', () => {
      // Simulate what would happen if someone naively tried to apply the
      // refunded mapping: the invoice object is never mutated.
      const invoice = makeInvoice('paid')
      const targetStatus = mapPaymentStateToInvoiceStatus('refunded')
      let result = invoice
      try {
        result = transitionInvoiceStatus(invoice, targetStatus)
      } catch {
        // expected — engine blocks the transition
      }
      expect(result.status).toBe('paid')
    })
  })

  // ── E. Existing Payment/Invoice Bindings ──────────────────────────────────

  describe('E. Existing payment/invoice bindings still correct', () => {
    it('released → paid mapping is correct', () => {
      expect(mapPaymentStateToInvoiceStatus('released')).toBe('paid')
    })

    it('deposit_required → draft mapping (8.1: auto-issuance guard)', () => {
      // 8.1: deposit_required deliberately maps to 'draft' to prevent payment
      // sync from auto-issuing invoices. Issuance requires explicit craftsman action.
      expect(mapPaymentStateToInvoiceStatus('deposit_required')).toBe('draft')
    })

    it('in_escrow → sent mapping is correct', () => {
      expect(mapPaymentStateToInvoiceStatus('in_escrow')).toBe('sent')
    })

    it('work_in_progress → sent mapping is correct', () => {
      expect(mapPaymentStateToInvoiceStatus('work_in_progress')).toBe('sent')
    })

    it('release_pending → sent mapping is correct', () => {
      expect(mapPaymentStateToInvoiceStatus('release_pending')).toBe('sent')
    })

    it('disputed → sent (no invalid invoice regression)', () => {
      // Disputed payment: invoice stays 'sent', not pushed backwards.
      expect(mapPaymentStateToInvoiceStatus('disputed')).toBe('sent')
      // Verify 'sent' is a valid non-terminal state (can still transition forward)
      const result = transitionInvoiceStatus(makeInvoice('sent'), 'paid')
      expect(result.status).toBe('paid')
    })

    it('released payment leads to valid paid invoice', () => {
      const targetStatus = mapPaymentStateToInvoiceStatus('released')
      const result = transitionInvoiceStatus(makeInvoice('sent'), targetStatus)
      expect(result.status).toBe('paid')
    })
  })

  // ── F. Label Side Effects ─────────────────────────────────────────────────

  describe('F. Label side effects on valid transitions', () => {
    it('draft → issued sets issuedAtLabel to "Heute"', () => {
      const result = transitionInvoiceStatus(makeInvoice('draft'), 'issued')
      expect(result.issuedAtLabel).toBe('Heute')
    })

    it('draft → issued sets dueAtLabel to "In 7 Tagen"', () => {
      const result = transitionInvoiceStatus(makeInvoice('draft'), 'issued')
      expect(result.dueAtLabel).toBe('In 7 Tagen')
    })

    it('sent → paid sets dueAtLabel to "Bezahlt"', () => {
      const result = transitionInvoiceStatus(makeInvoice('sent'), 'paid')
      expect(result.dueAtLabel).toBe('Bezahlt')
    })

    it('issued → paid sets dueAtLabel to "Bezahlt"', () => {
      const result = transitionInvoiceStatus(makeInvoice('issued'), 'paid')
      expect(result.dueAtLabel).toBe('Bezahlt')
    })

    it('transition updates updatedAt', () => {
      const before = Date.now()
      const result = transitionInvoiceStatus(makeInvoice('draft'), 'issued')
      expect(result.updatedAt).toBeGreaterThanOrEqual(before)
    })

    it('transition does not mutate the original invoice', () => {
      const original = makeInvoice('draft')
      const originalStatus = original.status
      transitionInvoiceStatus(original, 'issued')
      expect(original.status).toBe(originalStatus)
    })
  })
})
