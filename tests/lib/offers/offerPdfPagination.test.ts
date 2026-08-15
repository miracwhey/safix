/**
 * Offer-PDF Pagination-Polish.
 *
 * Der Offer-Renderer war bereits paginiert (`newPageIfNeeded`), stempelte den
 * Footer aber nur EINMAL am Ende → auf einem mehrseitigen Angebot trug nur die
 * letzte Seite eine (falsche) Seitenzahl, und der POSITIONEN-Spaltenkopf
 * erschien auf Folgeseiten nicht. Beides ist jetzt über die shared
 * `renderPageFooters`/`ensureSpace`-Primitive gelöst.
 *
 * Echtes jsPDF, PDF-Struktur direkt geprüft.
 */

import { describe, it, expect } from 'vitest'
import { generateOfferPdf } from '../../../src/lib/offers/pdf/generateOfferPdf'
import type { Offer } from '../../../src/lib/offers/types'

async function blobAsString(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  return new TextDecoder('latin1').decode(buf)
}

function countMatches(str: string, re: RegExp): number {
  return (str.match(re) ?? []).length
}

function makeOffer(itemCount: number): Offer {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: null,
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    craftsmanNameSnapshot: 'Mustermann Bau GmbH',
    price: '900',
    status: 'pending',
    documentType: 'binding_offer',
    grossTotal: 90_000,
    netTotal: 75_630,
    vatAmount: 14_370,
    vatRate: 19,
    lineItems: Array.from({ length: itemCount }, (_, i) => ({
      id: `li-${i + 1}`,
      label: `Position ${i + 1} — Leistung`,
      category: 'labor' as const,
      netAmount: 1_000,
      quantity: 1,
      unit: 'Stk',
    })),
    isStale: false,
    createdAt: Date.UTC(2026, 4, 23),
    updatedAt: Date.UTC(2026, 4, 23),
    sentAt: Date.UTC(2026, 4, 23),
  } as Offer
}

describe('generateOfferPdf · Pagination-Polish', () => {
  it('viele Positionen → mehrere Seiten', async () => {
    const str = await blobAsString(await generateOfferPdf(makeOffer(90)))
    expect(countMatches(str, /\/MediaBox/g)).toBeGreaterThanOrEqual(2)
  })

  it('Footer „Seite X von Y" auf jeder Seite (nicht nur der letzten)', async () => {
    const str = await blobAsString(await generateOfferPdf(makeOffer(90)))
    expect(str).toMatch(/Seite 1 von/)
    expect(str).toMatch(/Seite 2 von/)
  })

  it('POSITIONEN-Spaltenkopf wird auf Folgeseiten wiederholt', async () => {
    const str = await blobAsString(await generateOfferPdf(makeOffer(90)))
    expect(countMatches(str, /Beschreibung/g)).toBeGreaterThanOrEqual(2)
  })

  it('einseitiges Angebot → genau 1 Seite (kein Regress)', async () => {
    const str = await blobAsString(await generateOfferPdf(makeOffer(3)))
    expect(countMatches(str, /\/MediaBox/g)).toBe(1)
    expect(str).toMatch(/Gesamtbetrag/)
  })
})
