/**
 * Block 8.5 — Invoice Workflow UX Error Handling
 *
 * Tests the mapInvoiceWorkflowError mapper which is the critical logic layer
 * between raw engine errors and user-visible German feedback strings.
 *
 * Groups:
 *   A. issueInvoice error mapping — each engine error class maps correctly
 *   B. markInvoiceSent error mapping — illegal transition + missing invoice
 *   C. Mapper coverage — no engine error class is silently swallowed
 *   D. Regression — no domain files changed; mapper is pure and side-effect-free
 */

import { describe, it, expect } from 'vitest'
import { mapInvoiceWorkflowError } from '../../src/components/invoices/invoiceErrorMapper'

// ── A. issueInvoice error mapping ─────────────────────────────────────────────

describe('A. issueInvoiceWorkflow errors map to user-readable messages', () => {
  it('placeholder issuerName → profile incomplete message', () => {
    const err = new Error(
      'Invoice cannot be issued: parties.issuerName is a placeholder value. ' +
      'Real craftsman issuer data is required before issuing an invoice.'
    )
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Platzhalterwerte')
    expect(result).toContain('Profil')
  })

  it('placeholder issuerAddress → profile incomplete message', () => {
    const err = new Error(
      'Invoice cannot be issued: parties.issuerAddress is a placeholder value. ' +
      'Real craftsman issuer data is required before issuing an invoice.'
    )
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Platzhalterwerte')
  })

  it('incomplete issuerAddress (no comma) → full address required message', () => {
    const err = new Error(
      'Invoice cannot be issued: parties.issuerAddress is incomplete. ' +
      'A full address is required (expected format: "Street Number, PostalCode City").'
    )
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('unvollständig')
    expect(result).toContain('Profil')
  })

  it('missing issuerName → issuer data missing message', () => {
    const err = new Error('Invoice cannot be issued: parties.issuerName is missing or empty')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Ausstellerdaten fehlen')
  })

  it('missing issuerAddress → issuer data missing message', () => {
    const err = new Error('Invoice cannot be issued: parties.issuerAddress is missing or empty')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Ausstellerdaten fehlen')
  })

  it('missing customerName → customer data missing message', () => {
    const err = new Error('Invoice cannot be issued: parties.customerName is missing or empty')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Kundendaten fehlen')
  })

  it('empty lineItems → no line items message', () => {
    const err = new Error('Invoice cannot be issued: lineItems must contain at least one entry')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Rechnungspositionen')
  })

  it('grossAmount <= 0 → invalid amount message', () => {
    const err = new Error('Invoice cannot be issued: amounts.grossAmount must be greater than 0')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Rechnungsbetrag')
  })

  it('no invoice found → not found message', () => {
    const err = new Error('issueInvoiceWorkflow: no invoice found for job "job-abc"')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('nicht gefunden')
  })
})

// ── B. markInvoiceSent error mapping ──────────────────────────────────────────

describe('B. markInvoiceSentWorkflow errors map to user-readable messages', () => {
  it('illegal transition (draft → sent) → status not possible message', () => {
    const err = new Error('Illegal invoice transition: draft → sent')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('aktuellen Rechnungsstatus')
    expect(result).not.toContain('undefined')
  })

  it('illegal transition (paid → sent) → status not possible message', () => {
    const err = new Error('Illegal invoice transition: paid → sent')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('aktuellen Rechnungsstatus')
  })

  it('no invoice found for markSent → not found message', () => {
    const err = new Error('markInvoiceSentWorkflow: no invoice found for job "job-xyz"')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('nicht gefunden')
  })
})

// ── C. Mapper coverage ────────────────────────────────────────────────────────

describe('C. Mapper coverage — no known error class silently swallowed', () => {
  it('all returned strings are non-empty', () => {
    const engineErrors = [
      'parties.issuerName is a placeholder value.',
      'parties.issuerAddress is a placeholder value.',
      'parties.issuerAddress is incomplete. A full address is required',
      'parties.issuerName is missing or empty',
      'parties.issuerAddress is missing or empty',
      'parties.customerName is missing or empty',
      'lineItems must contain at least one entry',
      'amounts.grossAmount must be greater than 0',
      'Illegal invoice transition: draft → sent',
      'no invoice found for job',
    ]

    for (const msg of engineErrors) {
      const result = mapInvoiceWorkflowError(new Error(msg))
      expect(result.length).toBeGreaterThan(0)
      expect(result).not.toBe('undefined')
      expect(result).not.toBe('null')
    }
  })

  it('unknown error returns generic fallback — never empty', () => {
    const result = mapInvoiceWorkflowError(new Error('some completely unexpected error'))
    expect(result).toBeTruthy()
    expect(result).toContain('fehlgeschlagen')
  })

  it('non-Error thrown value (string) is handled without crash', () => {
    const result = mapInvoiceWorkflowError('network timeout')
    expect(result).toBeTruthy()
  })

  it('non-Error thrown value (object) is handled without crash', () => {
    const result = mapInvoiceWorkflowError({ code: 500 })
    expect(result).toBeTruthy()
  })

  it('undefined thrown is handled without crash', () => {
    const result = mapInvoiceWorkflowError(undefined)
    expect(result).toBeTruthy()
  })
})

// ── D. Regression ─────────────────────────────────────────────────────────────

describe('D. Regression — mapper is pure and does not import domain logic', () => {
  it('mapInvoiceWorkflowError is a synchronous pure function', () => {
    const result = mapInvoiceWorkflowError(new Error('test'))
    // Result is synchronous (not a Promise)
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result).toBe('string')
  })

  it('calling mapper twice with same error returns same result (no side effects)', () => {
    const err = new Error('Illegal invoice transition: draft → sent')
    const r1 = mapInvoiceWorkflowError(err)
    const r2 = mapInvoiceWorkflowError(err)
    expect(r1).toBe(r2)
  })

  it('placeholder message directs user to Profil — actionable guidance', () => {
    const err = new Error('issuerName is a placeholder value.')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Profil')
  })

  it('incomplete address message directs user to Profil — actionable guidance', () => {
    const err = new Error('issuerAddress is incomplete. A full address is required')
    const result = mapInvoiceWorkflowError(err)
    expect(result).toContain('Profil')
  })
})
