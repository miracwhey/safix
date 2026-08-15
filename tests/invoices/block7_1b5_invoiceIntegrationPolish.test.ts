/**
 * Block 7.1B5 — Invoice Integration Polish.
 *
 * Pins the three audit findings R2 + R3:
 *  - PaidInvoicesSection rendert genau einen PDF-Download-Pfad
 *    (externer onDownload), kein zusätzlicher direct-call.
 *  - Selector `getPrimaryInvoices` filtert Korrekturbelege weg, deckt
 *    gemeinsam mit `getCorrectionInvoices` die Gesamtmenge ab.
 *  - Disjunktheit: keine Invoice landet in beiden Listen, Summe == |all|.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getPrimaryInvoices,
  getCorrectionInvoices,
  type Invoice,
} from '../../src/lib/invoices'

function makeInvoice(
  id: string,
  kind: Invoice['kind'] = 'invoice',
  overrides: Partial<Invoice> = {},
): Invoice {
  return {
    id,
    jobId: `job-${id}`,
    invoiceNumber: `FX-${id}`,
    status: 'issued',
    kind,
    issuedAt: 1_700_000_000_000,
    issuedAtLabel: '2024-01-01',
    parties: {
      issuerName: 'Handwerker GmbH',
      issuerAddress: 'Hauptstr. 1, 10115 Berlin',
      customerName: 'Kunde',
      customerAddress: 'Nebenstr. 2, 10115 Berlin',
    },
    lineItems: [],
    amounts: { netAmount: 100, taxAmount: 19, grossAmount: 119 },
    ...overrides,
  } as Invoice
}

// ── R3: getPrimaryInvoices selector ────────────────────────────────────────────

describe('Block 7.1B5 R3 — getPrimaryInvoices', () => {
  it('returns only kind=invoice (Originalrechnungen)', () => {
    const all: Invoice[] = [
      makeInvoice('a', 'invoice'),
      makeInvoice('b', 'cancellation'),
      makeInvoice('c', 'credit_note'),
      makeInvoice('d', 'invoice'),
    ]
    const primary = getPrimaryInvoices(all)
    expect(primary.map((i) => i.id).sort()).toEqual(['a', 'd'])
  })

  it('treats undefined kind as primary (Legacy-Bestand vor B4)', () => {
    const legacy = makeInvoice('legacy')
    delete (legacy as Partial<Invoice>).kind
    expect(getPrimaryInvoices([legacy])).toHaveLength(1)
  })

  it('disjoint with getCorrectionInvoices and covers full set', () => {
    const all: Invoice[] = [
      makeInvoice('a', 'invoice'),
      makeInvoice('b', 'cancellation'),
      makeInvoice('c', 'credit_note'),
      makeInvoice('d', 'invoice'),
      makeInvoice('e', 'cancellation'),
    ]
    const primary = getPrimaryInvoices(all)
    const corrections = getCorrectionInvoices(all)
    const primaryIds = new Set(primary.map((i) => i.id))
    const correctionIds = new Set(corrections.map((i) => i.id))
    const overlap = [...primaryIds].filter((id) => correctionIds.has(id))
    expect(overlap).toEqual([])
    expect(primary.length + corrections.length).toBe(all.length)
  })
})

// ── R2: PaidInvoicesSection — single PDF button path ───────────────────────────

describe('Block 7.1B5 R2 — PaidInvoicesSection PDF button', () => {
  const componentSource = readFileSync(
    resolve(__dirname, '../../src/components/invoices/PaidInvoicesSection.tsx'),
    'utf-8',
  )

  it('renders exactly one "PDF herunterladen" button', () => {
    const matches = componentSource.match(/PDF herunterladen/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('does not directly import downloadInvoicePdf (uses external onDownload only)', () => {
    expect(componentSource).not.toMatch(/\bdownloadInvoicePdf\b/)
  })

  it('still wires up onDownload prop (external source-of-truth pfad)', () => {
    expect(componentSource).toMatch(/onDownload\?\s*:\s*\(invoice: Invoice\)/)
    expect(componentSource).toMatch(/onClick=\{\(\)\s*=>\s*onDownload\(invoice\)\}/)
  })

  it('still wires up onCreateCorrection (kept side-by-side)', () => {
    expect(componentSource).toMatch(/onCreateCorrection\(invoice\)/)
  })
})
