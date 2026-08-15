/**
 * Sub-block 2.4 — Precondition Validation for draft → issued
 *
 * Verifies:
 *   A. Success — draft → issued with all valid preconditions passes
 *   B. Each missing or invalid required BUSINESS field blocks issuance
 *   C. invoiceNumber is NOT a precondition (it is assigned at issuance by the
 *      repository layer — DB trigger for Supabase, instance counter for InMemory)
 *   D. Non-issued transitions are not affected by precondition validation
 *   E. Engine output — issuedAt is set correctly after successful issuance
 *   F. Error quality — each thrown message is specific and testable
 */

import { describe, it, expect } from 'vitest'

import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import { validateInvoiceIssuancePreconditions } from '../../src/lib/invoices/invoiceValidation'
import type { Invoice } from '../../src/lib/invoices/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Fully valid issuable draft invoice.
 * invoiceNumber is '' — drafts carry no number; the repository assigns it
 * at the moment of the issued transition.
 */
function makeIssuableInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv_job-1',
    jobId: 'job-1',
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Testbetrieb GmbH',
      issuerAddress: 'Musterstraße 1, 12345 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [
      {
        id: 'li_job-1',
        label: 'Sanitärarbeiten',
        quantity: 1,
        unitPrice: 840.34,
        total: 840.34,
      },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 0,
    issuedAtLabel: 'Noch nicht ausgestellt',
    dueAtLabel: 'Noch nicht fällig',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

// ── A. Success case ───────────────────────────────────────────────────────────

describe('Sub-block 2.4 — Precondition Validation for draft → issued', () => {
  describe('A. Success — valid invoice can be issued', () => {
    it('draft → issued with all valid business preconditions succeeds', () => {
      const result = transitionInvoiceStatus(makeIssuableInvoice(), 'issued')
      expect(result.status).toBe('issued')
    })

    it('validateInvoiceIssuancePreconditions does not throw for a valid invoice', () => {
      expect(() =>
        validateInvoiceIssuancePreconditions(makeIssuableInvoice())
      ).not.toThrow()
    })
  })

  // ── B. Missing / invalid required BUSINESS fields ─────────────────────────

  describe('B. Missing or invalid required business fields block issuance', () => {
    it('missing issuerName → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            parties: { issuerName: '', issuerAddress: 'Musterstraße 1, 12345 Berlin', customerName: 'Max' },
          }),
          'issued'
        )
      ).toThrow(/issuerName is missing or empty/)
    })

    it('missing issuerAddress → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            parties: { issuerName: 'Testbetrieb', issuerAddress: '', customerName: 'Max' },
          }),
          'issued'
        )
      ).toThrow(/issuerAddress is missing or empty/)
    })

    it('whitespace-only issuerAddress → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            parties: { issuerName: 'Testbetrieb', issuerAddress: '   ', customerName: 'Max' },
          }),
          'issued'
        )
      ).toThrow(/issuerAddress is missing or empty/)
    })

    it('missing customerName → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            parties: { issuerName: 'Testbetrieb', issuerAddress: 'Musterstraße 1, 12345 Berlin', customerName: '' },
          }),
          'issued'
        )
      ).toThrow(/customerName is missing or empty/)
    })

    it('empty lineItems → throws', () => {
      expect(() =>
        transitionInvoiceStatus(makeIssuableInvoice({ lineItems: [] }), 'issued')
      ).toThrow(/lineItems must contain at least one entry/)
    })

    it('lineItem with empty label → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            lineItems: [{ id: 'li_1', label: '', quantity: 1, unitPrice: 100, total: 100 }],
          }),
          'issued'
        )
      ).toThrow(/has no label/)
    })

    it('lineItem with whitespace-only label → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            lineItems: [{ id: 'li_1', label: '   ', quantity: 1, unitPrice: 100, total: 100 }],
          }),
          'issued'
        )
      ).toThrow(/has no label/)
    })

    it('grossAmount === 0 → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 },
          }),
          'issued'
        )
      ).toThrow(/grossAmount must be greater than 0/)
    })

    it('grossAmount < 0 → throws', () => {
      expect(() =>
        transitionInvoiceStatus(
          makeIssuableInvoice({
            amounts: { netAmount: -100, taxAmount: -19, grossAmount: -119 },
          }),
          'issued'
        )
      ).toThrow(/grossAmount must be greater than 0/)
    })
  })

  // ── C. invoiceNumber is NOT a precondition ────────────────────────────────

  describe('C. invoiceNumber is not a precondition — it is assigned at issuance', () => {
    it('draft invoice with empty invoiceNumber can be issued when business data is valid', () => {
      const invoice = makeIssuableInvoice({ invoiceNumber: '' })
      // Should not throw — invoiceNumber is assigned BY the transition, not before it
      const result = transitionInvoiceStatus(invoice, 'issued')
      expect(result.status).toBe('issued')
    })

    it('validateInvoiceIssuancePreconditions does not check invoiceNumber', () => {
      const invoice = makeIssuableInvoice({ invoiceNumber: '' })
      expect(() => validateInvoiceIssuancePreconditions(invoice)).not.toThrow()
    })

    it('draft invoice with non-empty invoiceNumber also passes (value is irrelevant to validation)', () => {
      const invoice = makeIssuableInvoice({ invoiceNumber: 'FX-2026-0099' })
      expect(() => validateInvoiceIssuancePreconditions(invoice)).not.toThrow()
    })
  })

  // ── D. Non-issued transitions unaffected ──────────────────────────────────

  describe('D. Non-issued transitions skip precondition validation', () => {
    it('draft → cancelled with incomplete data succeeds (no validation)', () => {
      const stripped = makeIssuableInvoice({
        parties: { issuerName: '', issuerAddress: '', customerName: '' },
        lineItems: [],
        amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 },
      })
      const result = transitionInvoiceStatus(stripped, 'cancelled')
      expect(result.status).toBe('cancelled')
    })

    it('issued → sent proceeds without issuance validation', () => {
      const invoice = { ...makeIssuableInvoice(), status: 'issued' as const }
      const result = transitionInvoiceStatus(invoice, 'sent')
      expect(result.status).toBe('sent')
    })

    it('sent → paid proceeds without issuance validation', () => {
      const invoice = { ...makeIssuableInvoice(), status: 'sent' as const }
      const result = transitionInvoiceStatus(invoice, 'paid')
      expect(result.status).toBe('paid')
    })
  })

  // ── E. Engine output after successful issuance ────────────────────────────

  describe('E. Engine sets issuedAt on successful draft → issued', () => {
    it('issuedAt is 0 for a draft invoice', () => {
      const invoice = makeIssuableInvoice()
      expect(invoice.issuedAt).toBe(0)
    })

    it('issuedAt is set to a real timestamp after draft → issued', () => {
      const before = Date.now()
      const result = transitionInvoiceStatus(makeIssuableInvoice(), 'issued')
      expect(result.issuedAt).toBeGreaterThanOrEqual(before)
      expect(result.issuedAt).toBeGreaterThan(0)
    })

    it('issuedAt is not changed when transitioning issued → sent', () => {
      const issuedAt = 1_000_000
      const invoice = {
        ...makeIssuableInvoice(),
        status: 'issued' as const,
        issuedAt,
      }
      const result = transitionInvoiceStatus(invoice, 'sent')
      expect(result.issuedAt).toBe(issuedAt)
    })

    it('issuedAt is not changed when transitioning sent → paid', () => {
      const issuedAt = 1_000_000
      const invoice = {
        ...makeIssuableInvoice(),
        status: 'sent' as const,
        issuedAt,
      }
      const result = transitionInvoiceStatus(invoice, 'paid')
      expect(result.issuedAt).toBe(issuedAt)
    })
  })

  // ── F. Error quality ──────────────────────────────────────────────────────

  describe('F. Error messages are specific and testable', () => {
    it('issuerAddress error mentions the field name', () => {
      expect(() =>
        validateInvoiceIssuancePreconditions(
          makeIssuableInvoice({
            parties: { issuerName: 'X', issuerAddress: '', customerName: 'Y' },
          })
        )
      ).toThrow('issuerAddress')
    })

    it('lineItems error mentions the constraint', () => {
      expect(() =>
        validateInvoiceIssuancePreconditions(makeIssuableInvoice({ lineItems: [] }))
      ).toThrow('lineItems')
    })

    it('grossAmount error mentions the field and constraint', () => {
      expect(() =>
        validateInvoiceIssuancePreconditions(
          makeIssuableInvoice({ amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 } })
        )
      ).toThrow('grossAmount')
    })

    it('all errors start with "Invoice cannot be issued:"', () => {
      const cases: Invoice[] = [
        makeIssuableInvoice({
          parties: { issuerName: '', issuerAddress: 'x', customerName: 'y' },
        }),
        makeIssuableInvoice({
          parties: { issuerName: 'x', issuerAddress: '', customerName: 'y' },
        }),
        makeIssuableInvoice({
          parties: { issuerName: 'x', issuerAddress: 'y', customerName: '' },
        }),
        makeIssuableInvoice({ lineItems: [] }),
        makeIssuableInvoice({ amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 } }),
      ]
      for (const invoice of cases) {
        expect(() => validateInvoiceIssuancePreconditions(invoice)).toThrow(
          'Invoice cannot be issued:'
        )
      }
    })
  })
})
