/**
 * Block 11 — Invoice Artifact Generation
 *
 * Tests the artifact generation layer introduced in Block 11.
 * Focus: the pure buildInvoiceRenderData function (no jsPDF, no browser APIs)
 * and the generateInvoicePdf integration (jsPDF mocked).
 *
 * Covers:
 *   A. buildInvoiceRenderData — valid invoice produces correct render data
 *   B. buildInvoiceRenderData — all required fields appear in output
 *   C. buildInvoiceRenderData — draft invoice throws
 *   D. buildInvoiceRenderData — missing invoiceNumber throws
 *   E. buildInvoiceRenderData — placeholder issuerName throws
 *   F. buildInvoiceRenderData — placeholder issuerAddress throws
 *   G. buildInvoiceRenderData — city-only issuerAddress (no comma) throws
 *   H. buildInvoiceRenderData — missing customerName throws
 *   I. buildInvoiceRenderData — no line items throws
 *   J. buildInvoiceRenderData — zero grossAmount throws
 *   K. generateInvoicePdf — valid invoice returns a Blob
 *   L. generateInvoicePdf — draft invoice throws before reaching jsPDF
 *   M. sent semantics — download does not alter invoice.status
 */

// ── jsPDF mock ────────────────────────────────────────────────────────────────
// Mock jsPDF so tests run in Node without a browser canvas.
// We capture calls via module-level spies that the class methods delegate to.

const {
  mockOutput,
  mockText,
  mockSplitTextToSize,
  MockJsPDF,
} = vi.hoisted(() => {
  const mockOutput = vi.fn()
  const mockText = vi.fn()
  const mockLine = vi.fn()
  const mockRect = vi.fn()
  const mockSetFont = vi.fn()
  const mockSetFontSize = vi.fn()
  const mockSetFillColor = vi.fn()
  const mockSetDrawColor = vi.fn()
  const mockSplitTextToSize = vi.fn((text: string) => [text])

  class MockJsPDF {
    _pageCount = 1
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } }
    output(...args: unknown[]) { return mockOutput(...args) }
    text(...args: unknown[]) { return mockText(...args) }
    line(...args: unknown[]) { return mockLine(...args) }
    rect(...args: unknown[]) { return mockRect(...args) }
    setFont(...args: unknown[]) { return mockSetFont(...args) }
    setFontSize(...args: unknown[]) { return mockSetFontSize(...args) }
    setFillColor(...args: unknown[]) { return mockSetFillColor(...args) }
    setDrawColor(...args: unknown[]) { return mockSetDrawColor(...args) }
    splitTextToSize(...args: unknown[]) { return mockSplitTextToSize(...args) }
    addPage() { this._pageCount += 1 }
    getNumberOfPages() { return this._pageCount }
    setPage(..._args: unknown[]) {}
  }

  return {
    mockOutput, mockText, mockLine, mockRect,
    mockSetFont, mockSetFontSize, mockSetFillColor, mockSetDrawColor,
    mockSplitTextToSize, MockJsPDF,
  }
})

vi.mock('jspdf', () => ({ jsPDF: MockJsPDF }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { buildInvoiceRenderData, generateInvoicePdf } from '../../src/lib/invoices/artifactGenerator'
import type { Invoice } from '../../src/lib/invoices/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssuedInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv_job-1',
    jobId: 'job-1',
    invoiceNumber: 'FX-2026-0001',
    status: 'issued',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Julia Neumann',
    },
    lineItems: [
      {
        id: 'li_1',
        label: 'Heizungsinstallation',
        quantity: 1,
        unitPrice: 840.34,
        total: 840.34,
      },
    ],
    amounts: {
      netAmount: 840.34,
      taxAmount: 159.66,
      grossAmount: 1000.0,
    },
    issuedAt: 1_743_840_000_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
    sentAt: 0,
    createdAt: 1_743_840_000_000,
    updatedAt: 1_743_840_000_000,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 11 — Invoice Artifact Generation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOutput.mockReturnValue(new Blob(['%PDF-mock'], { type: 'application/pdf' }))
    mockSplitTextToSize.mockImplementation((text: string, _width: unknown) => [text])
  })

  // ── A. Valid invoice produces render data ─────────────────────────────────

  describe('A. buildInvoiceRenderData: valid invoice', () => {
    it('returns render data without throwing for a valid issued invoice', () => {
      const invoice = makeIssuedInvoice()
      expect(() => buildInvoiceRenderData(invoice)).not.toThrow()
    })

    it('returns render data without throwing for a valid sent invoice', () => {
      const invoice = makeIssuedInvoice({ status: 'sent', sentAt: Date.now() })
      expect(() => buildInvoiceRenderData(invoice)).not.toThrow()
    })

    it('returns render data without throwing for a paid invoice', () => {
      const invoice = makeIssuedInvoice({ status: 'paid' })
      expect(() => buildInvoiceRenderData(invoice)).not.toThrow()
    })
  })

  // ── B. Required fields appear in output ───────────────────────────────────

  describe('B. buildInvoiceRenderData: required fields in output', () => {
    it('includes invoiceNumber in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.invoiceNumber).toBe('FX-2026-0001')
    })

    it('includes issuerName in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.issuerName).toBe('Müller Sanitär GmbH')
    })

    it('includes issuerAddress in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.issuerAddress).toBe('Hauptstraße 5, 10115 Berlin')
    })

    it('includes customerName in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.customerName).toBe('Julia Neumann')
    })

    it('includes formatted grossAmount in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.grossAmount).toContain('1.000')
    })

    it('includes formatted netAmount in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.netAmount).toContain('840')
    })

    it('includes formatted taxAmount in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.taxAmount).toContain('159')
    })

    it('includes line items with label in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.lineItems).toHaveLength(1)
      expect(data.lineItems[0].label).toBe('Heizungsinstallation')
    })

    it('includes line item quantity in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.lineItems[0].quantity).toBe(1)
    })

    it('includes formatted line item unitPrice in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.lineItems[0].unitPrice).toContain('840')
    })

    it('includes formatted line item total in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.lineItems[0].total).toContain('840')
    })

    it('includes issuedAtLabel in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.issuedAtLabel).toBe('Heute')
    })

    it('includes dueAtLabel in render data', () => {
      const data = buildInvoiceRenderData(makeIssuedInvoice())
      expect(data.dueAtLabel).toBe('In 7 Tagen')
    })
  })

  // ── C. Draft invoice throws ───────────────────────────────────────────────

  describe('C. buildInvoiceRenderData: draft invoice', () => {
    it('throws when invoice is still a draft', () => {
      const invoice = makeIssuedInvoice({ status: 'draft', invoiceNumber: '' })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/draft/)
    })
  })

  // ── D. Missing invoiceNumber throws ──────────────────────────────────────

  describe('D. buildInvoiceRenderData: missing invoiceNumber', () => {
    it('throws when invoiceNumber is empty string', () => {
      const invoice = makeIssuedInvoice({ invoiceNumber: '' })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/invoice number/)
    })
  })

  // ── E. Placeholder issuerName throws ─────────────────────────────────────

  describe('E. buildInvoiceRenderData: placeholder issuerName', () => {
    it('throws when issuerName is the known placeholder', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: 'SaFix Partnerbetrieb',
          issuerAddress: 'Hauptstraße 5, 10115 Berlin',
          customerName: 'Julia Neumann',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/placeholder/)
    })

    it('throws when issuerName is empty', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: '',
          issuerAddress: 'Hauptstraße 5, 10115 Berlin',
          customerName: 'Julia Neumann',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/issuerName/)
    })
  })

  // ── F. Placeholder issuerAddress throws ──────────────────────────────────

  describe('F. buildInvoiceRenderData: placeholder issuerAddress', () => {
    it('throws when issuerAddress is the known placeholder', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: 'Müller Sanitär GmbH',
          issuerAddress: 'Handwerkerstraße 12, 80331 München',
          customerName: 'Julia Neumann',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/placeholder/)
    })

    it('throws when issuerAddress is empty', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: 'Müller Sanitär GmbH',
          issuerAddress: '',
          customerName: 'Julia Neumann',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/issuerAddress/)
    })
  })

  // ── G. City-only issuerAddress throws ────────────────────────────────────

  describe('G. buildInvoiceRenderData: incomplete issuerAddress', () => {
    it('throws when issuerAddress has no comma (city-only value)', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: 'Müller Sanitär GmbH',
          issuerAddress: 'Berlin',
          customerName: 'Julia Neumann',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/incomplete|postal code|street/i)
    })
  })

  // ── H. Missing customerName throws ───────────────────────────────────────

  describe('H. buildInvoiceRenderData: missing customerName', () => {
    it('throws when customerName is empty', () => {
      const invoice = makeIssuedInvoice({
        parties: {
          issuerName: 'Müller Sanitär GmbH',
          issuerAddress: 'Hauptstraße 5, 10115 Berlin',
          customerName: '',
        },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/customerName/)
    })
  })

  // ── I. No line items throws ───────────────────────────────────────────────

  describe('I. buildInvoiceRenderData: no line items', () => {
    it('throws when lineItems is empty', () => {
      const invoice = makeIssuedInvoice({ lineItems: [] })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/line items/)
    })
  })

  // ── J. Zero grossAmount throws ────────────────────────────────────────────

  describe('J. buildInvoiceRenderData: zero gross amount', () => {
    it('throws when grossAmount is 0', () => {
      const invoice = makeIssuedInvoice({
        amounts: { netAmount: 0, taxAmount: 0, grossAmount: 0 },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/gross amount/)
    })

    it('throws when grossAmount is negative', () => {
      const invoice = makeIssuedInvoice({
        amounts: { netAmount: -10, taxAmount: -2, grossAmount: -12 },
      })
      expect(() => buildInvoiceRenderData(invoice)).toThrow(/gross amount/)
    })
  })

  // ── K. generateInvoicePdf returns a Blob ─────────────────────────────────

  describe('K. generateInvoicePdf: valid invoice returns Blob', () => {
    it('returns a Blob for a valid issued invoice', async () => {
      const invoice = makeIssuedInvoice()
      const result = await generateInvoicePdf(invoice)
      expect(result).toBeInstanceOf(Blob)
    })

    it('calls jsPDF output with "blob"', async () => {
      await generateInvoicePdf(makeIssuedInvoice())
      expect(mockOutput).toHaveBeenCalledWith('blob')
    })

    it('calls text with invoiceNumber somewhere in the render', async () => {
      await generateInvoicePdf(makeIssuedInvoice())
      const calls = mockText.mock.calls
      const hasInvoiceNumber = calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('FX-2026-0001'),
      )
      expect(hasInvoiceNumber).toBe(true)
    })

    it('calls text with issuerName somewhere in the render', async () => {
      await generateInvoicePdf(makeIssuedInvoice())
      const calls = mockText.mock.calls
      const hasIssuerName = calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('Müller Sanitär GmbH'),
      )
      expect(hasIssuerName).toBe(true)
    })

    it('calls text with customerName somewhere in the render', async () => {
      await generateInvoicePdf(makeIssuedInvoice())
      const calls = mockText.mock.calls
      const hasCustomerName = calls.some(
        (args) => typeof args[0] === 'string' && args[0].includes('Julia Neumann'),
      )
      expect(hasCustomerName).toBe(true)
    })
  })

  // ── L. generateInvoicePdf: draft throws before jsPDF ─────────────────────

  describe('L. generateInvoicePdf: draft invoice throws without instantiating jsPDF', () => {
    it('throws for draft invoice — guard fires before PDF construction', async () => {
      // The draft guard in buildInvoiceRenderData fires before the dynamic jsPDF
      // import and new jsPDF(...) are ever reached. We verify via the output
      // mock: if jsPDF was constructed, output() would have been set up and
      // callable.
      mockOutput.mockClear()
      const invoice = makeIssuedInvoice({ status: 'draft', invoiceNumber: '' })
      await expect(generateInvoicePdf(invoice)).rejects.toThrow(/draft/)
      expect(mockOutput).not.toHaveBeenCalled()
    })
  })

  // ── M. Sent semantics: download does not alter invoice.status ─────────────

  describe('M. Download does not affect sent status', () => {
    it('buildInvoiceRenderData does not mutate the invoice', () => {
      const invoice = makeIssuedInvoice({ status: 'issued' })
      buildInvoiceRenderData(invoice)
      // Status must remain 'issued' — download is not a state transition
      expect(invoice.status).toBe('issued')
    })

    it('generateInvoicePdf does not mutate the invoice', async () => {
      const invoice = makeIssuedInvoice({ status: 'issued' })
      await generateInvoicePdf(invoice)
      expect(invoice.status).toBe('issued')
      expect(invoice.sentAt).toBe(0)
    })
  })
})
