/**
 * Spatial C-10 · C10.8 · generateOfferPdf tests.
 *
 * Verifies the generator produces a non-empty PDF Blob (`application/pdf`),
 * includes the documentType-aware header text in the rendered stream, and
 * surfaces the Spatial-Origin badge for Spatial-Offers. Filename helper
 * formatting is also checked.
 *
 * jsPDF generates a deterministic binary stream — testing exact bytes is
 * brittle; instead we decode the Blob's underlying string and assert key
 * substrings (the layout-text the consumer cares about). jsPDF runs in the
 * Node environment because its core path is pure JS — no DOM needed.
 */
import { describe, it, expect } from 'vitest'
import {
  generateOfferPdf,
  offerPdfFilename,
} from '../../../src/lib/offers/pdf/generateOfferPdf'
import type { Offer } from '../../../src/lib/offers/types'

const BASE_OFFER: Offer = {
  id: '22222222-2222-4222-8222-222222222222',
  conversationId: null,
  customerUserId: 'cust-1',
  craftsmanUserId: 'craft-1',
  craftsmanNameSnapshot: 'Mustermann Bau GmbH',
  price: '500',
  status: 'pending',
  documentType: 'binding_offer',
  grossTotal: 50_000,
  netTotal: 42_017,
  vatAmount: 7_983,
  vatRate: 19,
  lineItems: [
    {
      id: 'li-1',
      label: 'Bodenfliesen',
      category: 'material',
      netAmount: 30_000,
      quantity: 12,
      unit: 'm2',
    },
    {
      id: 'li-2',
      label: 'Verlegearbeiten',
      category: 'labor',
      netAmount: 12_017,
      quantity: 8,
      unit: 'h',
    },
  ],
  sourceSpatialSceneId: 'scene-spatial-1',
  isStale: false,
  createdAt: Date.UTC(2026, 4, 23),
  updatedAt: Date.UTC(2026, 4, 23),
  sentAt: Date.UTC(2026, 4, 23),
} as Offer

async function blobAsString(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  return new TextDecoder('latin1').decode(buf)
}

describe('generateOfferPdf · contract', () => {
  it('returns an application/pdf Blob with non-zero size', async () => {
    const blob = await generateOfferPdf(BASE_OFFER)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
  })

  it('PDF stream begins with the %PDF- magic bytes', async () => {
    const blob = await generateOfferPdf(BASE_OFFER)
    const str = await blobAsString(blob)
    expect(str.startsWith('%PDF-')).toBe(true)
  })
})

describe('generateOfferPdf · parties', () => {
  it('never renders the raw customer user id — FÜR is omitted without a name', async () => {
    const str = await blobAsString(await generateOfferPdf(BASE_OFFER))
    expect(str).not.toMatch(/cust-1/)
    expect(str).not.toMatch(/FÜR/)
  })

  it('renders the recipient name when customerName is provided', async () => {
    const str = await blobAsString(
      await generateOfferPdf(BASE_OFFER, { customerName: 'Anna Beispiel' }),
    )
    expect(str).toMatch(/Anna Beispiel/)
    expect(str).not.toMatch(/cust-1/)
  })
})

describe('generateOfferPdf · documentType-aware header', () => {
  it('renders ANGEBOT for binding_offer', async () => {
    const blob = await generateOfferPdf({ ...BASE_OFFER, documentType: 'binding_offer' })
    const str = await blobAsString(blob)
    expect(str).toMatch(/ANGEBOT/)
  })

  it('renders KOSTENVORANSCHLAG for cost_estimate', async () => {
    const blob = await generateOfferPdf({ ...BASE_OFFER, documentType: 'cost_estimate' })
    const str = await blobAsString(blob)
    expect(str).toMatch(/KOSTENVORANSCHLAG/)
  })
})

describe('generateOfferPdf · Spatial-Origin badge', () => {
  it('emits "Vom 3D-Aufmaß erstellt" for a Spatial-Offer', async () => {
    const blob = await generateOfferPdf(BASE_OFFER)
    const str = await blobAsString(blob)
    // jsPDF may encode the umlaut differently — assert on the safe prefix.
    expect(str).toMatch(/Vom 3D-Aufma/)
  })

  it('omits the Spatial badge for a non-spatial offer', async () => {
    const nonSpatial: Offer = { ...BASE_OFFER, sourceSpatialSceneId: undefined }
    const blob = await generateOfferPdf(nonSpatial)
    const str = await blobAsString(blob)
    expect(str).not.toMatch(/Vom 3D-Aufma/)
  })
})

describe('generateOfferPdf · line items + totals', () => {
  it('renders line-item labels + totals in the PDF stream', async () => {
    const blob = await generateOfferPdf(BASE_OFFER)
    const str = await blobAsString(blob)
    expect(str).toMatch(/Bodenfliesen/)
    expect(str).toMatch(/Verlegearbeiten/)
    // German EUR formatting may include thin spaces — assert on the digits.
    expect(str).toMatch(/500,00/)
  })
})

describe('generateOfferPdf · spatial aufmaß section', () => {
  const AUFMASS_OFFER: Offer = {
    ...BASE_OFFER,
    spatialMetadata: {
      lineItems: [],
      aufmass: {
        floorPolygon: [
          { xPct: 12, yPct: 12 },
          { xPct: 88, yPct: 12 },
          { xPct: 88, yPct: 88 },
          { xPct: 12, yPct: 88 },
        ],
        areaM2: 16,
        volumeM3: 40,
        ceilingHeightM: 2.5,
        wallCount: 4,
        perimeterM: 16,
        measurements: [
          { label: 'Bodenflaeche', kind: 'floor', unit: 'm2', value: 16 },
          { label: 'Sockelleiste', kind: 'skirting', unit: 'lfm', value: 15.1 },
          { label: 'Wand Nord', kind: 'wall', unit: 'm2', value: 8.11, grossM2: 10, openingsM2: 1.89 },
        ],
      },
    },
  } as Offer

  it('renders the AUFMASS heading + measurement labels', async () => {
    const str = await blobAsString(await generateOfferPdf(AUFMASS_OFFER))
    expect(str).toMatch(/AUFMASS/)
    expect(str).toMatch(/Sockelleiste/)
    expect(str).toMatch(/Wand Nord/)
  })

  it('omits the AUFMASS section when no snapshot is present', async () => {
    const str = await blobAsString(await generateOfferPdf(BASE_OFFER))
    expect(str).not.toMatch(/AUFMASS/)
  })

  it('still produces a valid PDF Blob with the aufmaß section', async () => {
    const blob = await generateOfferPdf(AUFMASS_OFFER)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
  })
})

describe('offerPdfFilename', () => {
  it('uses offerRef when available', () => {
    expect(offerPdfFilename({ ...BASE_OFFER, offerRef: 'KV-2026-A3F2' })).toBe('Angebot-KV-2026-A3F2.pdf')
  })

  it('falls back to first 8 chars of id when offerRef missing', () => {
    expect(offerPdfFilename(BASE_OFFER)).toBe('Angebot-22222222.pdf')
  })
})
