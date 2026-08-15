/**
 * generateChangeOrderPdf (Nachtrag PDF) tests — mirrors generateOfferPdf tests.
 * jsPDF runs in Node (pure-JS core path); we decode the Blob and assert on the
 * rendered layout text rather than exact bytes.
 */
import { describe, it, expect } from 'vitest'
import {
  generateChangeOrderPdf,
  changeOrderPdfFilename,
} from '../../../src/lib/changeOrders/pdf/generateChangeOrderPdf'
import type { ChangeOrder } from '../../../src/lib/changeOrders/types'
import type { Offer } from '../../../src/lib/offers/types'

// Production shape: the composer/workflow set grossTotal only — NOT netTotal/vatRate.
const BASE_CO: ChangeOrder = {
  id: '33333333-3333-4333-8333-333333333333',
  jobId: 'job-1',
  sourceOfferId: 'offer-1',
  craftsmanUserId: 'craft-1',
  customerUserId: 'cust-1',
  description: 'Austausch Abflussrohr unter der Wanne\n\nGrund: Rohr korrodiert\n\nTermin: +1 Tag',
  price: '180 €',
  grossTotal: 18_000,
  status: 'pending',
  createdAt: Date.UTC(2026, 5, 21),
  updatedAt: Date.UTC(2026, 5, 21),
  sentAt: Date.UTC(2026, 5, 21),
}

// Full breakdown shape (net + vat present) — the optional richer case.
const FULL_CO: ChangeOrder = { ...BASE_CO, netTotal: 15_126, vatRate: 19 }

const SOURCE_OFFER = {
  craftsmanNameSnapshot: 'Sanitär Krause GmbH',
  offerRef: 'AG-2026-77',
  projectTitleSnapshot: 'Bad-Sanierung',
  locationSnapshot: 'Müllerstr. 18',
  grossTotal: 240_000,
} as Offer

async function blobAsString(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  return new TextDecoder('latin1').decode(buf)
}

describe('generateChangeOrderPdf · contract', () => {
  it('returns an application/pdf Blob with %PDF magic', async () => {
    const blob = await generateChangeOrderPdf(BASE_CO)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
    expect((await blobAsString(blob)).startsWith('%PDF-')).toBe(true)
  })

  it('renders the NACHTRAG header + parsed scope/grund/termin', async () => {
    const str = await blobAsString(await generateChangeOrderPdf(BASE_CO, { sourceOffer: SOURCE_OFFER }))
    expect(str).toMatch(/NACHTRAG/)
    expect(str).toMatch(/Austausch Abflussrohr/)
    expect(str).toMatch(/Rohr korrodiert/)
    expect(str).toMatch(/180,00|180/) // gross amount or fallback
  })

  it('enriches party + reference from the source offer', async () => {
    const str = await blobAsString(await generateChangeOrderPdf(BASE_CO, { sourceOffer: SOURCE_OFFER }))
    expect(str).toMatch(/Sanit/) // craftsmanNameSnapshot (umlaut-safe prefix)
    expect(str).toMatch(/AG-2026-77/) // offer reference
  })

  it('never renders raw user ids — FÜR only appears with a customerName', async () => {
    const without = await blobAsString(await generateChangeOrderPdf(BASE_CO, { sourceOffer: SOURCE_OFFER }))
    expect(without).not.toMatch(/cust-1/)
    expect(without).not.toMatch(/craft-1/)
    const withName = await blobAsString(
      await generateChangeOrderPdf(BASE_CO, { sourceOffer: SOURCE_OFFER, customerName: 'Anna Beispiel' }),
    )
    expect(withName).toMatch(/Anna Beispiel/)
    expect(withName).not.toMatch(/cust-1/)
  })

  it('falls back to the price string when no structured amount is present', async () => {
    const noAmount: ChangeOrder = { ...BASE_CO, grossTotal: undefined }
    const str = await blobAsString(await generateChangeOrderPdf(noAmount))
    expect(str).toMatch(/Nachtragsbetrag/)
    expect(str).toMatch(/180/)
  })

  it('production shape (gross only) shows Nachtragsbetrag WITHOUT an empty Netto/MwSt breakdown', async () => {
    const str = await blobAsString(await generateChangeOrderPdf(BASE_CO))
    expect(str).toMatch(/Nachtragsbetrag/)
    expect(str).toMatch(/180,00/)
    // No "Netto —, MwSt —" em-dash breakdown when net/vat are absent.
    expect(str).not.toMatch(/Nachtrag Netto/)
  })

  it('renders the full Netto/MwSt breakdown only when net + vat are present', async () => {
    const str = await blobAsString(await generateChangeOrderPdf(FULL_CO))
    expect(str).toMatch(/Nachtrag Netto/)
    expect(str).toMatch(/MwSt 19/)
    expect(str).toMatch(/Nachtragsbetrag/)
  })
})

describe('changeOrderPdfFilename', () => {
  it('uses the first 8 chars of the id', () => {
    expect(changeOrderPdfFilename(BASE_CO)).toBe('Nachtrag-33333333.pdf')
  })
})
