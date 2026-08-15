/**
 * Block 7.1B3 — Invoice Tax Model
 *
 * Pure unit tests für `applyTaxDefaults`, `buildTaxBreakdown`, `deriveTaxNote`,
 * `assertTaxConsistency`. Keine I/O, keine DB.
 */

import { describe, it, expect } from 'vitest'
import {
  applyTaxDefaults,
  assertTaxConsistency,
  buildTaxBreakdown,
  deriveTaxNote,
  isAllowedVatRate,
  KLEINUNTERNEHMER_TAX_NOTE,
} from '../../src/lib/invoices/invoiceTaxModel'
import type { InvoiceLineItem } from '../../src/lib/invoices/types'

const baseProvider = {
  isKleinunternehmer: false,
  defaultVatRate: 19,
}

const kleinProvider = {
  isKleinunternehmer: true,
  defaultVatRate: 0,
}

function makeLine(overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem {
  return {
    id: 'li_test',
    label: 'Position',
    quantity: 1,
    unitPrice: 100,
    total: 100,
    ...overrides,
  }
}

describe('isAllowedVatRate', () => {
  it('akzeptiert 0/7/19', () => {
    expect(isAllowedVatRate(0)).toBe(true)
    expect(isAllowedVatRate(7)).toBe(true)
    expect(isAllowedVatRate(19)).toBe(true)
  })
  it('lehnt andere Werte ab', () => {
    expect(isAllowedVatRate(5)).toBe(false)
    expect(isAllowedVatRate(20)).toBe(false)
    expect(isAllowedVatRate(-1)).toBe(false)
  })
})

describe('applyTaxDefaults', () => {
  it('belegt jede Position mit defaultVatRate aus Provider', () => {
    const lines = [makeLine()]
    const out = applyTaxDefaults(lines, baseProvider)
    expect(out[0].vatRate).toBe(19)
    expect(out[0].vatAmount).toBe(19)
    expect(out[0].gross).toBe(119)
    expect(out[0].category).toBe('labor')
  })

  it('erhält manuelle vatRate-Overrides pro Position', () => {
    const lines = [makeLine({ vatRate: 7 })]
    const out = applyTaxDefaults(lines, baseProvider)
    expect(out[0].vatRate).toBe(7)
    expect(out[0].vatAmount).toBeCloseTo(7, 2)
    expect(out[0].gross).toBeCloseTo(107, 2)
  })

  it('zwingt Kleinunternehmer auf 0%, ignoriert manuelle vatRate', () => {
    const lines = [makeLine({ vatRate: 19 })]
    const out = applyTaxDefaults(lines, kleinProvider)
    expect(out[0].vatRate).toBe(0)
    expect(out[0].vatAmount).toBe(0)
    expect(out[0].gross).toBe(100)
  })

  it('setzt category-Default labor, behält explizite Kategorie', () => {
    const lines = [makeLine({ category: 'material' })]
    const out = applyTaxDefaults(lines, baseProvider)
    expect(out[0].category).toBe('material')
  })
})

describe('buildTaxBreakdown', () => {
  it('gruppiert nach vatRate', () => {
    const lines = applyTaxDefaults(
      [
        makeLine({ id: 'a', vatRate: 19, total: 100 }),
        makeLine({ id: 'b', vatRate: 7, total: 50 }),
        makeLine({ id: 'c', vatRate: 19, total: 200 }),
      ],
      baseProvider,
    )
    const breakdown = buildTaxBreakdown(lines)
    expect(breakdown).toHaveLength(2)
    const byRate = Object.fromEntries(breakdown.map((b) => [b.vatRate, b]))
    expect(byRate[19].netAmount).toBe(300)
    expect(byRate[19].taxAmount).toBe(57)
    expect(byRate[19].grossAmount).toBe(357)
    expect(byRate[7].netAmount).toBe(50)
    expect(byRate[7].taxAmount).toBeCloseTo(3.5, 2)
  })
  it('liefert leeres Array bei leeren Lines', () => {
    expect(buildTaxBreakdown([])).toEqual([])
  })
})

describe('deriveTaxNote', () => {
  it('liefert §19-Hinweis für Kleinunternehmer', () => {
    expect(deriveTaxNote(kleinProvider)).toBe(KLEINUNTERNEHMER_TAX_NOTE)
  })
  it('null sonst', () => {
    expect(deriveTaxNote(baseProvider)).toBeNull()
  })
})

describe('assertTaxConsistency', () => {
  it('passt für konsistente Beträge', () => {
    const lines = applyTaxDefaults([makeLine({ total: 100 })], baseProvider)
    const breakdown = buildTaxBreakdown(lines)
    expect(() =>
      assertTaxConsistency(
        lines,
        { netAmount: 100, taxAmount: 19, grossAmount: 119 },
        breakdown,
      ),
    ).not.toThrow()
  })

  it('wirft bei inkonsistenter NET-Summe', () => {
    const lines = applyTaxDefaults([makeLine({ total: 100 })], baseProvider)
    const breakdown = buildTaxBreakdown(lines)
    expect(() =>
      assertTaxConsistency(
        lines,
        { netAmount: 200, taxAmount: 19, grossAmount: 119 },
        breakdown,
      ),
    ).toThrow(/net amount/)
  })

  it('wirft bei inkonsistenter Breakdown-Summe', () => {
    const lines = applyTaxDefaults([makeLine({ total: 100 })], baseProvider)
    const fakeBreakdown = [
      { vatRate: 19, netAmount: 50, taxAmount: 9.5, grossAmount: 59.5 },
    ]
    expect(() =>
      assertTaxConsistency(
        lines,
        { netAmount: 100, taxAmount: 19, grossAmount: 119 },
        fakeBreakdown,
      ),
    ).toThrow(/tax breakdown/)
  })
})
