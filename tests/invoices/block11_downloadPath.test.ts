/**
 * Block 11 — Download / Export Path
 *
 * Tests the platform-aware delivery in downloadInvoicePdf.
 *
 * Covers:
 *   A. Web path: createObjectURL + anchor click, correct filename
 *   B. Web path: revokeObjectURL called after download
 *   C. Web path: never calls Filesystem or Share
 *   D. Native path: writes file to Cache directory
 *   E. Native path: calls Share.share with the written file URI
 *   F. Native path: filename is stable and invoiceNumber-based
 *   G. Native path: never calls URL.createObjectURL
 *   H. Native path: Filesystem write failure propagates as thrown error
 *   I. Native path: Share failure propagates as thrown error
 *   J. Both paths: generateInvoicePdf throws → downloadInvoicePdf throws (no delivery attempt)
 *   K. sent semantics: downloadInvoicePdf does not alter invoice.status or sentAt
 */

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockIsNative } = vi.hoisted(() => ({ mockIsNative: vi.fn<[], boolean>() }))

const { mockGenerateInvoicePdf } = vi.hoisted(() => ({
  mockGenerateInvoicePdf: vi.fn<[unknown], Blob>(),
}))

const { mockFilesystemWriteFile, mockShareShare } = vi.hoisted(() => ({
  mockFilesystemWriteFile: vi.fn(),
  mockShareShare: vi.fn(),
}))

vi.mock('../../src/lib/platform', () => ({
  isNative: () => mockIsNative(),
}))

vi.mock('../../src/lib/invoices/artifactGenerator', () => ({
  generateInvoicePdf: (...args: unknown[]) => mockGenerateInvoicePdf(...args),
  buildInvoiceRenderData: vi.fn(),
}))

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: (...args: unknown[]) => mockFilesystemWriteFile(...args) },
  Directory: { Cache: 'CACHE' },
}))

vi.mock('@capacitor/share', () => ({
  Share: { share: (...args: unknown[]) => mockShareShare(...args) },
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { downloadInvoicePdf } from '../../src/lib/invoices/downloadInvoice'
import type { Invoice } from '../../src/lib/invoices/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_PDF_BLOB = new Blob(['%PDF-1.4 mock'], { type: 'application/pdf' })

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
      { id: 'li_1', label: 'Heizungsinstallation', quantity: 1, unitPrice: 840.34, total: 840.34 },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 1_743_840_000_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
    sentAt: 0,
    createdAt: 1_743_840_000_000,
    updatedAt: 1_743_840_000_000,
    ...overrides,
  }
}

// ── Web DOM stubs ─────────────────────────────────────────────────────────────

const mockCreateObjectURL = vi.fn<[Blob], string>()
const mockRevokeObjectURL = vi.fn()
const mockAnchorClick = vi.fn()
const mockAppendChild = vi.fn()
const mockRemoveChild = vi.fn()

function stubWebGlobals() {
  const mockAnchor = {
    href: '',
    download: '',
    click: mockAnchorClick,
  }
  vi.stubGlobal('URL', {
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
  })
  vi.stubGlobal('document', {
    createElement: vi.fn().mockReturnValue(mockAnchor),
    body: { appendChild: mockAppendChild, removeChild: mockRemoveChild },
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 11 — Download / Export Path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockGenerateInvoicePdf.mockReturnValue(MOCK_PDF_BLOB)
    mockFilesystemWriteFile.mockResolvedValue({ uri: '/cache/Rechnung_FX-2026-0001.pdf' })
    mockShareShare.mockResolvedValue(undefined)
    mockCreateObjectURL.mockReturnValue('blob:mock-url')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  // ── A. Web: createObjectURL + anchor click ────────────────────────────────

  describe('A. Web path: createObjectURL and anchor click', () => {
    it('calls URL.createObjectURL with the generated PDF blob', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockCreateObjectURL).toHaveBeenCalledWith(MOCK_PDF_BLOB)
    })

    it('clicks the anchor element to trigger the download', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockAnchorClick).toHaveBeenCalledTimes(1)
    })

    it('sets anchor.download to the stable invoiceNumber-based filename', async () => {
      mockIsNative.mockReturnValue(false)
      const mockAnchor = { href: '', download: '', click: mockAnchorClick }
      vi.stubGlobal('URL', { createObjectURL: mockCreateObjectURL, revokeObjectURL: mockRevokeObjectURL })
      vi.stubGlobal('document', {
        createElement: vi.fn().mockReturnValue(mockAnchor),
        body: { appendChild: mockAppendChild, removeChild: mockRemoveChild },
      })

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockAnchor.download).toBe('Rechnung_FX-2026-0001.pdf')
    })
  })

  // ── B. Web: revokeObjectURL called after delay ────────────────────────────

  describe('B. Web path: revokeObjectURL called after delay', () => {
    it('revokes the object URL after 250ms', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())
      expect(mockRevokeObjectURL).not.toHaveBeenCalled()

      vi.advanceTimersByTime(250)
      expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    })
  })

  // ── C. Web: never calls Filesystem or Share ───────────────────────────────

  describe('C. Web path: no native plugin calls', () => {
    it('does not call Filesystem.writeFile on web', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockFilesystemWriteFile).not.toHaveBeenCalled()
    })

    it('does not call Share.share on web', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockShareShare).not.toHaveBeenCalled()
    })
  })

  // ── D. Native: writes file to Cache directory ─────────────────────────────

  describe('D. Native path: Filesystem.writeFile', () => {
    it('calls Filesystem.writeFile with Cache directory', async () => {
      mockIsNative.mockReturnValue(true)

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockFilesystemWriteFile).toHaveBeenCalledWith(
        expect.objectContaining({ directory: 'CACHE' }),
      )
    })

    it('calls Filesystem.writeFile with a base64 string as data', async () => {
      mockIsNative.mockReturnValue(true)

      await downloadInvoicePdf(makeIssuedInvoice())

      const call = mockFilesystemWriteFile.mock.calls[0][0]
      expect(typeof call.data).toBe('string')
      // btoa output only contains base64 characters
      expect(call.data).toMatch(/^[A-Za-z0-9+/]+=*$/)
    })

    it('uses the invoiceNumber-based filename for the file path', async () => {
      mockIsNative.mockReturnValue(true)

      await downloadInvoicePdf(makeIssuedInvoice())

      const call = mockFilesystemWriteFile.mock.calls[0][0]
      expect(call.path).toBe('Rechnung_FX-2026-0001.pdf')
    })

    it('falls back to invoice.id in filename when invoiceNumber is empty', async () => {
      mockIsNative.mockReturnValue(true)
      const invoice = makeIssuedInvoice({ invoiceNumber: '', status: 'issued' })
      // Override generateInvoicePdf to not throw (testing filename only)
      mockGenerateInvoicePdf.mockReturnValue(MOCK_PDF_BLOB)

      await downloadInvoicePdf(invoice)

      const call = mockFilesystemWriteFile.mock.calls[0][0]
      expect(call.path).toBe('Rechnung_inv_job-1.pdf')
    })
  })

  // ── E. Native: calls Share.share with the written file URI ───────────────

  describe('E. Native path: Share.share', () => {
    it('calls Share.share after Filesystem.writeFile', async () => {
      mockIsNative.mockReturnValue(true)

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockShareShare).toHaveBeenCalledTimes(1)
    })

    it('passes the URI returned by Filesystem.writeFile to Share.share', async () => {
      mockIsNative.mockReturnValue(true)
      mockFilesystemWriteFile.mockResolvedValue({ uri: '/var/mobile/Containers/Data/cache/Rechnung_FX-2026-0001.pdf' })

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockShareShare).toHaveBeenCalledWith(
        expect.objectContaining({
          files: ['/var/mobile/Containers/Data/cache/Rechnung_FX-2026-0001.pdf'],
        }),
      )
    })
  })

  // ── F. Native: stable invoiceNumber-based filename ────────────────────────

  describe('F. Native path: stable filename', () => {
    it('uses invoiceNumber-based filename in Share.share title', async () => {
      mockIsNative.mockReturnValue(true)

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockShareShare).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Rechnung_FX-2026-0001.pdf' }),
      )
    })
  })

  // ── G. Native: never calls URL.createObjectURL ────────────────────────────

  describe('G. Native path: no URL.createObjectURL call', () => {
    it('does not call URL.createObjectURL on native', async () => {
      mockIsNative.mockReturnValue(true)
      stubWebGlobals()

      await downloadInvoicePdf(makeIssuedInvoice())

      expect(mockCreateObjectURL).not.toHaveBeenCalled()
    })
  })

  // ── H. Native: Filesystem failure propagates ──────────────────────────────

  describe('H. Native path: Filesystem write failure', () => {
    it('throws when Filesystem.writeFile rejects', async () => {
      mockIsNative.mockReturnValue(true)
      mockFilesystemWriteFile.mockRejectedValue(new Error('Disk full'))

      await expect(downloadInvoicePdf(makeIssuedInvoice())).rejects.toThrow('Disk full')
    })

    it('does not call Share.share when Filesystem.writeFile fails', async () => {
      mockIsNative.mockReturnValue(true)
      mockFilesystemWriteFile.mockRejectedValue(new Error('Permission denied'))

      await downloadInvoicePdf(makeIssuedInvoice()).catch(() => {})

      expect(mockShareShare).not.toHaveBeenCalled()
    })
  })

  // ── I. Native: Share failure propagates ───────────────────────────────────

  describe('I. Native path: Share failure', () => {
    it('throws when Share.share rejects', async () => {
      mockIsNative.mockReturnValue(true)
      mockShareShare.mockRejectedValue(new Error('Share cancelled by OS'))

      await expect(downloadInvoicePdf(makeIssuedInvoice())).rejects.toThrow('Share cancelled by OS')
    })
  })

  // ── J. generateInvoicePdf throws → no delivery attempt ───────────────────

  describe('J. Artifact generation failure: no delivery', () => {
    it('throws on web when generateInvoicePdf throws', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()
      mockGenerateInvoicePdf.mockImplementation(() => {
        throw new Error('Invoice is still a draft')
      })

      await expect(downloadInvoicePdf(makeIssuedInvoice())).rejects.toThrow('draft')
    })

    it('does not call Filesystem or Share when generateInvoicePdf throws on native', async () => {
      mockIsNative.mockReturnValue(true)
      mockGenerateInvoicePdf.mockImplementation(() => {
        throw new Error('Invoice is still a draft')
      })

      await downloadInvoicePdf(makeIssuedInvoice()).catch(() => {})

      expect(mockFilesystemWriteFile).not.toHaveBeenCalled()
      expect(mockShareShare).not.toHaveBeenCalled()
    })

    it('does not call URL.createObjectURL when generateInvoicePdf throws on web', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()
      mockGenerateInvoicePdf.mockImplementation(() => {
        throw new Error('placeholder issuer')
      })

      await downloadInvoicePdf(makeIssuedInvoice()).catch(() => {})

      expect(mockCreateObjectURL).not.toHaveBeenCalled()
    })
  })

  // ── K. sent semantics: download does not alter invoice ───────────────────

  describe('K. sent semantics: download does not affect invoice state', () => {
    it('does not change invoice.status after web download', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()
      const invoice = makeIssuedInvoice({ status: 'issued' })

      await downloadInvoicePdf(invoice)

      expect(invoice.status).toBe('issued')
    })

    it('does not set invoice.sentAt after web download', async () => {
      mockIsNative.mockReturnValue(false)
      stubWebGlobals()
      const invoice = makeIssuedInvoice({ sentAt: 0 })

      await downloadInvoicePdf(invoice)

      expect(invoice.sentAt).toBe(0)
    })

    it('does not change invoice.status after native share', async () => {
      mockIsNative.mockReturnValue(true)
      const invoice = makeIssuedInvoice({ status: 'issued' })

      await downloadInvoicePdf(invoice)

      expect(invoice.status).toBe('issued')
    })

    it('does not set invoice.sentAt after native share', async () => {
      mockIsNative.mockReturnValue(true)
      const invoice = makeIssuedInvoice({ sentAt: 0 })

      await downloadInvoicePdf(invoice)

      expect(invoice.sentAt).toBe(0)
    })
  })
})
