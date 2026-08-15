/**
 * Sub-block 2.3 — Offer as Source of Truth for Invoice Amounts and Line Items
 *
 * Verifies:
 *   A. Offer as authoritative commercial source — amounts come from Offer, not job.amount
 *   B. Offer wins over job.amount when both are present
 *   C. Fallback path — job.amount used when no Offer present
 *   D. Hard error paths — no silent zero amounts
 *   E. Offer error path — sourceOfferId present but offer not loadable → throws
 *   F. Line item behaviour — structured, summary fallback, label priority chain
 *   G. Amount conversion — Offer minor units (cents) → Invoice euros
 *   H. Regression protection — 2.1, 2.2, 2.4 behaviour unaffected
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// ── Mocks for ensureInvoiceForJob service tests ───────────────────────────────

vi.mock('../../src/lib/offers', () => ({
  getOfferById: vi.fn(),
  getAcceptedOfferByJobId: vi.fn().mockReturnValue(undefined),
  // #1020 added an isOfferRepositoryHydrated() guard in ensureInvoiceForJob:
  // a missing source offer is a HARD error only while the repo is NOT hydrated
  // (transient — retry); once hydrated it falls back to the accepted offer.
  // The E-section exercises the hard-error (not-hydrated) path, so default false;
  // the E2-section overrides this to true to exercise the hydrated→accepted-offer
  // fallback (counterparty deleted their account → source offer CASCADE-gone, job
  // + escrow plan retained per migration 20260622010000).
  // (The other sections supply a real getOfferById offer and never consult it.)
  isOfferRepositoryHydrated: vi.fn().mockReturnValue(false),
}))

vi.mock('../../src/lib/invoices/invoiceStore', () => ({
  getInvoiceByJobId: vi.fn().mockReturnValue(undefined),
  isInvoiceRepositoryHydrated: vi.fn().mockReturnValue(true),
}))

vi.mock('../../src/lib/invoices/repository', () => ({
  getInvoiceRepository: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../../src/lib/jobs', () => ({
  getJobs: vi.fn().mockReturnValue([]),
}))

vi.mock('../../src/lib/payments', () => ({
  getPaymentForJob: vi.fn().mockReturnValue(undefined),
}))

vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../src/lib/shared/canonicalAmountResolver', () => ({
  resolveCanonicalAmount: vi.fn().mockReturnValue({ amount: null, formatted: '', source: 'none' }),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { createInvoiceFromJob } from '../../src/lib/invoices/invoiceEngine'
import { ensureInvoiceForJob } from '../../src/lib/invoices/invoiceService'
import { getOfferById, getAcceptedOfferByJobId, isOfferRepositoryHydrated } from '../../src/lib/offers'
import { logWarning } from '../../src/lib/observability'
import type { Job } from '../../src/lib/jobs'
import type { Offer, QuoteLineItem } from '../../src/lib/offers/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'heute',
    status: 'in_progress',
    amount: '1.190,00 €',   // = 1190.00 € parsed
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    sourceOfferId: undefined,
    ...overrides,
  } as Job
}

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    conversationId: 'conv-1',
    customerUserId: 'user-customer',
    craftsmanUserId: 'user-craftsman',
    price: '1.190,00 €',
    grossTotal: 119_000,  // 1190.00 € in cents
    netTotal: 100_000,    // 1000.00 € in cents
    vatAmount: 19_000,    // 190.00 € in cents
    vatRate: 19,
    status: 'accepted',
    sentAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

function makeQuoteLineItem(overrides: Partial<QuoteLineItem> = {}): QuoteLineItem {
  return {
    id: 'qli-1',
    label: 'Rohrarbeiten',
    category: 'labor',
    netAmount: 80_000,   // 800.00 € in cents
    quantity: 1,
    ...overrides,
  }
}

// ── A. Offer as authoritative commercial source ───────────────────────────────

describe('Sub-block 2.3 — Offer as Source of Truth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('A. Offer amounts are used when Offer is provided', () => {
    it('grossAmount comes from offer.grossTotal (cents → euros)', () => {
      const offer = makeOffer({ grossTotal: 119_000, netTotal: 100_000 })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.amounts.grossAmount).toBe(1190.0)
    })

    it('netAmount comes from offer.netTotal when available', () => {
      const offer = makeOffer({ grossTotal: 119_000, netTotal: 100_000 })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.amounts.netAmount).toBe(1000.0)
    })

    it('taxAmount is derived from gross - net', () => {
      const offer = makeOffer({ grossTotal: 119_000, netTotal: 100_000 })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.amounts.taxAmount).toBe(190.0)
    })

    it('amounts come from offer even when job.amount has a different value', () => {
      const job = makeJob({ amount: '500 €' })            // would give 500 € gross
      const offer = makeOffer({ grossTotal: 119_000 })    // 1190 €
      const invoice = createInvoiceFromJob(job, offer)
      // Offer wins — job.amount is irrelevant
      expect(invoice.amounts.grossAmount).toBe(1190.0)
    })

    it('vatRate is used when netTotal is absent', () => {
      // No netTotal → derive from vatRate
      const offer = makeOffer({ grossTotal: 119_000, netTotal: undefined, vatRate: 19 })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      // 119000 / 100 = 1190 gross; net = 1190 / 1.19 ≈ 1000
      expect(invoice.amounts.grossAmount).toBe(1190.0)
      expect(invoice.amounts.netAmount).toBe(1000.0)
    })

    it('defaults to 19% VAT when neither netTotal nor vatRate present', () => {
      const offer = makeOffer({ grossTotal: 119_000, netTotal: undefined, vatRate: undefined })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.amounts.grossAmount).toBe(1190.0)
      // net = 1190 / 1.19 = 1000.00
      expect(invoice.amounts.netAmount).toBe(1000.0)
    })
  })

  // ── B. Offer wins over job.amount ─────────────────────────────────────────

  describe('B. Offer always wins over job.amount when both present', () => {
    it('job.amount is completely ignored when offer is provided', () => {
      const job = makeJob({ amount: '9.999,99 €' })
      const offer = makeOffer({ grossTotal: 50_000 })   // 500 €
      const invoice = createInvoiceFromJob(job, offer)
      expect(invoice.amounts.grossAmount).toBe(500.0)
      expect(invoice.amounts.grossAmount).not.toBe(9999.99)
    })
  })

  // ── C. Fallback path — job.amount ─────────────────────────────────────────

  describe('C. Fallback — job.amount used when no Offer provided', () => {
    it('grossAmount comes from job.amount when no offer given', () => {
      const job = makeJob({ amount: '1.190 €' })
      const invoice = createInvoiceFromJob(job)
      expect(invoice.amounts.grossAmount).toBe(1190.0)
    })

    it('fallback computes netAmount as gross / 1.19', () => {
      const job = makeJob({ amount: '1.190 €' })
      const invoice = createInvoiceFromJob(job)
      expect(invoice.amounts.netAmount).toBe(Number((1190 / 1.19).toFixed(2)))
    })

    it('creates a single line item from job.title on fallback', () => {
      const job = makeJob({ title: 'Elektroinstallation', amount: '500 €' })
      const invoice = createInvoiceFromJob(job)
      expect(invoice.lineItems).toHaveLength(1)
      expect(invoice.lineItems[0].label).toBe('Elektroinstallation')
    })
  })

  // ── D. Hard error paths — no silent zero amounts ──────────────────────────

  describe('D. Hard errors — never produce invoices with zero amounts', () => {
    it('offer with grossTotal = 0 throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: 0 }))
      ).toThrow(/offer.*no valid grossTotal/)
    })

    it('offer with missing grossTotal throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: undefined }))
      ).toThrow(/offer.*no valid grossTotal/)
    })

    it('offer with negative grossTotal throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: -100 }))
      ).toThrow(/offer.*no valid grossTotal/)
    })

    it('fallback with unparseable job.amount throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob({ amount: 'keine Angabe' }))
      ).toThrow(/no resolvable amount/)
    })

    it('fallback with empty job.amount throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob({ amount: '' }))
      ).toThrow(/no resolvable amount/)
    })

    it('fallback with zero-value job.amount throws', () => {
      expect(() =>
        createInvoiceFromJob(makeJob({ amount: '0 €' }))
      ).toThrow(/no resolvable amount/)
    })
  })

  // ── E. Offer error path — sourceOfferId present but offer not loadable ────

  describe('E. ensureInvoiceForJob — hard error when offer not loadable', () => {
    it('throws when sourceOfferId is set but getOfferById returns undefined', async () => {
      vi.mocked(getOfferById).mockReturnValue(undefined)

      const job = makeJob({ sourceOfferId: 'offer-missing' })

      await expect(ensureInvoiceForJob(job)).rejects.toThrow(
        /referenced offer.*not loadable/
      )
    })

    it('error message identifies both the job and the missing offer', async () => {
      vi.mocked(getOfferById).mockReturnValue(undefined)

      const job = makeJob({ id: 'job-xyz', sourceOfferId: 'offer-abc' })

      await expect(ensureInvoiceForJob(job)).rejects.toThrow(/job-xyz/)
      await expect(ensureInvoiceForJob(job)).rejects.toThrow(/offer-abc/)
    })

    it('does NOT fall back to job.amount when sourceOfferId is set and offer missing', async () => {
      vi.mocked(getOfferById).mockReturnValue(undefined)

      // job has a valid amount — but since sourceOfferId is set, we must not use it
      const job = makeJob({ amount: '1.000 €', sourceOfferId: 'offer-gone' })

      await expect(ensureInvoiceForJob(job)).rejects.toThrow()
    })

    it('succeeds when sourceOfferId is absent (no offer needed)', async () => {
      const job = makeJob({ sourceOfferId: undefined, amount: '500 €' })

      // Should not throw — fallback to job.amount
      await expect(ensureInvoiceForJob(job)).resolves.toBeDefined()
    })

    it('succeeds when sourceOfferId is set and offer is found', async () => {
      vi.mocked(getOfferById).mockReturnValue(makeOffer({ grossTotal: 50_000 }))

      const job = makeJob({ sourceOfferId: 'offer-1', amount: '1.000 €' })

      const invoice = await ensureInvoiceForJob(job)
      // Offer wins — grossAmount is 500, not 1000 from job.amount
      expect(invoice.amounts.grossAmount).toBe(500.0)
    })
  })

  // ── E2. Hydrated fallback — source offer deleted, accepted offer survives ──

  describe('E2. ensureInvoiceForJob — hydrated fallback to accepted offer', () => {
    it('falls back to the accepted offer (not job.amount) when source offer is gone but repo is hydrated', async () => {
      // Counterparty deleted their account → sourceOffer CASCADE-gone, but the
      // job + a surviving accepted offer remain (migration 20260622010000).
      vi.mocked(getOfferById).mockReturnValue(undefined)
      vi.mocked(isOfferRepositoryHydrated).mockReturnValue(true)
      vi.mocked(getAcceptedOfferByJobId).mockReturnValue(makeOffer({ grossTotal: 70_000 })) // 700 €

      // job.amount differs (1000 €) — must be IGNORED in favour of the accepted offer.
      const job = makeJob({ amount: '1.000 €', sourceOfferId: 'offer-deleted' })

      const invoice = await ensureInvoiceForJob(job)
      expect(invoice.amounts.grossAmount).toBe(700.0)
      expect(getAcceptedOfferByJobId).toHaveBeenCalledWith('job-1')
    })

    it('logs invoice.source_offer_deleted_fallback when falling through', async () => {
      vi.mocked(getOfferById).mockReturnValue(undefined)
      vi.mocked(isOfferRepositoryHydrated).mockReturnValue(true)
      vi.mocked(getAcceptedOfferByJobId).mockReturnValue(makeOffer({ grossTotal: 70_000 }))

      const job = makeJob({ id: 'job-del', sourceOfferId: 'offer-zzz' })
      await ensureInvoiceForJob(job)
      expect(logWarning).toHaveBeenCalledWith('invoice.source_offer_deleted_fallback', {
        jobId: 'job-del',
        sourceOfferId: 'offer-zzz',
      })
    })

    it('does NOT throw the not-hydrated hard error once the repo is hydrated', async () => {
      vi.mocked(getOfferById).mockReturnValue(undefined)
      vi.mocked(isOfferRepositoryHydrated).mockReturnValue(true)
      vi.mocked(getAcceptedOfferByJobId).mockReturnValue(makeOffer({ grossTotal: 70_000 }))

      const job = makeJob({ sourceOfferId: 'offer-deleted' })
      await expect(ensureInvoiceForJob(job)).resolves.toBeDefined()
    })

    // Reset the hydrated override so it cannot leak into later suites; clearAllMocks
    // resets call history but NOT mockReturnValue implementations.
    afterEach(() => {
      vi.mocked(isOfferRepositoryHydrated).mockReturnValue(false)
      vi.mocked(getAcceptedOfferByJobId).mockReturnValue(undefined)
    })
  })

  // ── F. Line item behaviour ────────────────────────────────────────────────

  describe('F. Line items — structured conversion and fallback', () => {
    it('offer.lineItems are converted to InvoiceLineItems', () => {
      const qli = makeQuoteLineItem({ netAmount: 80_000, quantity: 1, label: 'Rohrarbeiten' })
      const offer = makeOffer({ grossTotal: 95_200, lineItems: [qli] })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems).toHaveLength(1)
      expect(invoice.lineItems[0].label).toBe('Rohrarbeiten')
      expect(invoice.lineItems[0].unitPrice).toBe(800.0)
      expect(invoice.lineItems[0].total).toBe(800.0)
    })

    it('multiple offer.lineItems are all converted', () => {
      const qli1 = makeQuoteLineItem({ id: 'qli-1', netAmount: 50_000, label: 'Arbeit' })
      const qli2 = makeQuoteLineItem({ id: 'qli-2', netAmount: 30_000, label: 'Material', category: 'material' })
      const offer = makeOffer({ grossTotal: 95_200, lineItems: [qli1, qli2] })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems).toHaveLength(2)
      expect(invoice.lineItems.map((l) => l.label)).toEqual(['Arbeit', 'Material'])
    })

    it('quantity > 1 is preserved and total is correct', () => {
      const qli = makeQuoteLineItem({ netAmount: 10_000, quantity: 3 })  // 3 × 100 € = 300 €
      const offer = makeOffer({ grossTotal: 35_700, lineItems: [qli] })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems[0].quantity).toBe(3)
      expect(invoice.lineItems[0].total).toBe(300.0)
    })

    it('no offer.lineItems → single summary item created', () => {
      const offer = makeOffer({ grossTotal: 119_000, netTotal: 100_000, lineItems: undefined })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems).toHaveLength(1)
    })

    it('summary item label uses offer.scopeSummary first', () => {
      const offer = makeOffer({
        grossTotal: 100_000,
        lineItems: undefined,
        scopeSummary: 'Badezimmer komplett',
        description: 'Allgemeine Beschreibung',
      })
      const invoice = createInvoiceFromJob(makeJob({ title: 'Job-Titel' }), offer)
      expect(invoice.lineItems[0].label).toBe('Badezimmer komplett')
    })

    it('summary item falls back to offer.description when no scopeSummary', () => {
      const offer = makeOffer({
        grossTotal: 100_000,
        lineItems: undefined,
        scopeSummary: undefined,
        description: 'Allgemeine Beschreibung',
      })
      const invoice = createInvoiceFromJob(makeJob({ title: 'Job-Titel' }), offer)
      expect(invoice.lineItems[0].label).toBe('Allgemeine Beschreibung')
    })

    it('summary item falls back to job.title when offer has no description', () => {
      const offer = makeOffer({
        grossTotal: 100_000,
        lineItems: undefined,
        scopeSummary: undefined,
        description: undefined,
      })
      const invoice = createInvoiceFromJob(makeJob({ title: 'Elektroinstallation' }), offer)
      expect(invoice.lineItems[0].label).toBe('Elektroinstallation')
    })

    it('invoice always has at least one line item when offer has valid grossTotal', () => {
      const offer = makeOffer({ grossTotal: 100_000, lineItems: undefined })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems.length).toBeGreaterThan(0)
    })
  })

  // ── G. Amount conversion ──────────────────────────────────────────────────

  describe('G. Minor unit (cents) → euros conversion', () => {
    it('grossTotal 10000 cents = 100.00 €', () => {
      const invoice = createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: 10_000, netTotal: undefined, vatRate: 0 }))
      expect(invoice.amounts.grossAmount).toBe(100.0)
    })

    it('grossTotal 29000 cents = 290.00 €', () => {
      const invoice = createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: 29_000, netTotal: 24_370 }))
      expect(invoice.amounts.grossAmount).toBe(290.0)
      expect(invoice.amounts.netAmount).toBe(243.70)
    })

    it('QuoteLineItem netAmount 84034 cents = 840.34 €', () => {
      const qli = makeQuoteLineItem({ netAmount: 84_034, quantity: 1 })
      const offer = makeOffer({ grossTotal: 100_000, lineItems: [qli] })
      const invoice = createInvoiceFromJob(makeJob(), offer)
      expect(invoice.lineItems[0].unitPrice).toBe(840.34)
    })
  })

  // ── H. Regression protection ──────────────────────────────────────────────

  describe('H. Regression — 2.1 / 2.2 / 2.4 behaviour unaffected', () => {
    it('createInvoiceFromJob still produces a draft invoice', () => {
      const invoice = createInvoiceFromJob(makeJob({ amount: '500 €' }))
      expect(invoice.status).toBe('draft')
    })

    it('createInvoiceFromJob still produces invoiceNumber = ""', () => {
      const invoice = createInvoiceFromJob(makeJob({ amount: '500 €' }))
      expect(invoice.invoiceNumber).toBe('')
    })

    it('createInvoiceFromJob with offer still produces invoiceNumber = ""', () => {
      const invoice = createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: 50_000 }))
      expect(invoice.invoiceNumber).toBe('')
    })

    it('offer-based invoice has valid amounts for issuance (grossAmount > 0)', () => {
      const invoice = createInvoiceFromJob(makeJob(), makeOffer({ grossTotal: 119_000 }))
      expect(invoice.amounts.grossAmount).toBeGreaterThan(0)
    })
  })
})
