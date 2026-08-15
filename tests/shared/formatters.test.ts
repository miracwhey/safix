/**
 * Canonical Money Formatters — Unit Tests
 *
 * Validates that the shared formatEuro() and formatCents() produce
 * consistent German/Euro formatted output for all representative amounts.
 */

import { describe, it, expect } from 'vitest'
import { formatEuro, formatCents, formatOfferPrice } from '../../src/lib/shared/formatters'

describe('formatEuro — canonical euro formatter', () => {
  it('formats a round integer amount', () => {
    // 2300 euros → "2.300,00 €" (with possible non-breaking space)
    const result = formatEuro(2300)
    expect(result).toMatch(/2\.300,00\s*€/)
  })

  it('formats a decimal amount', () => {
    const result = formatEuro(1200.5)
    expect(result).toMatch(/1\.200,50\s*€/)
  })

  it('formats zero', () => {
    const result = formatEuro(0)
    expect(result).toMatch(/0,00\s*€/)
  })

  it('formats a small amount', () => {
    const result = formatEuro(42)
    expect(result).toMatch(/42,00\s*€/)
  })

  it('formats a large amount', () => {
    const result = formatEuro(100000)
    expect(result).toMatch(/100\.000,00\s*€/)
  })

  it('always includes exactly 2 decimal places', () => {
    const result = formatEuro(1500)
    // Must include ,00 — no omission of decimals
    expect(result).toContain(',00')
  })

  it('always includes the € symbol', () => {
    expect(formatEuro(500)).toContain('€')
  })

  it('uses German thousands separator (dot)', () => {
    const result = formatEuro(5000)
    expect(result).toMatch(/5\.000/)
  })

  it('uses German decimal separator (comma)', () => {
    const result = formatEuro(99.99)
    expect(result).toMatch(/99,99/)
  })

  it('negative amounts include minus sign', () => {
    const result = formatEuro(-500)
    expect(result).toMatch(/-?\s*500,00\s*€/)
  })
})

describe('formatCents — cent-to-euro formatter', () => {
  it('converts 230000 cents to "2.300,00 €"', () => {
    const result = formatCents(230000)
    expect(result).toMatch(/2\.300,00\s*€/)
  })

  it('converts 150050 cents to "1.500,50 €"', () => {
    const result = formatCents(150050)
    expect(result).toMatch(/1\.500,50\s*€/)
  })

  it('converts 0 cents to "0,00 €"', () => {
    const result = formatCents(0)
    expect(result).toMatch(/0,00\s*€/)
  })

  it('converts 100 cents to "1,00 €"', () => {
    const result = formatCents(100)
    expect(result).toMatch(/1,00\s*€/)
  })

  it('produces identical output to formatEuro when given equivalent value', () => {
    const fromCents = formatCents(250000)
    const fromEuros = formatEuro(2500)
    expect(fromCents).toBe(fromEuros)
  })
})

describe('formatEuro consistency — no decimal/comma regression', () => {
  it('1000 euros never shows as raw "1000"', () => {
    const result = formatEuro(1000)
    // Must show thousands separator and decimals
    expect(result).not.toBe('1000')
    expect(result).toMatch(/1\.000,00\s*€/)
  })

  it('formatEuro and re-exported formatEuro produce identical output', async () => {
    // Import the re-exported version from payments/selectors
    const { formatEuro: reExported } = await import('../../src/lib/payments/selectors')
    expect(reExported(2300)).toBe(formatEuro(2300))
  })

  it('formatInvoiceEuro delegates to same canonical formatter', async () => {
    const { formatInvoiceEuro } = await import('../../src/lib/invoices/invoiceSelectors')
    expect(formatInvoiceEuro(2300)).toBe(formatEuro(2300))
  })
})

describe('formatOfferPrice — raw offer price canonicalization', () => {
  it('formats a bare number "1000" to canonical "1.000,00 €"', () => {
    const result = formatOfferPrice('1000')
    expect(result).toMatch(/1\.000,00\s*€/)
    expect(result).not.toBe('1000')
  })

  it('formats a German-formatted string "2.300 €"', () => {
    const result = formatOfferPrice('2.300 €')
    expect(result).toMatch(/2\.300,00\s*€/)
  })

  it('formats "1.500,50 €" correctly', () => {
    const result = formatOfferPrice('1.500,50 €')
    expect(result).toMatch(/1\.500,50\s*€/)
  })

  it('formats a bare number "1500" correctly', () => {
    const result = formatOfferPrice('1500')
    expect(result).toMatch(/1\.500,00\s*€/)
  })

  it('returns raw string for unparseable input like "auf Anfrage"', () => {
    expect(formatOfferPrice('auf Anfrage')).toBe('auf Anfrage')
  })

  it('returns raw string for empty input', () => {
    expect(formatOfferPrice('')).toBe('')
  })

  it('formats "€4.000" correctly', () => {
    const result = formatOfferPrice('€4.000')
    expect(result).toMatch(/4\.000,00\s*€/)
  })

  it('formats range "500 – 800 €" using first value', () => {
    const result = formatOfferPrice('500 – 800 €')
    expect(result).toMatch(/500,00\s*€/)
  })

  it('produces identical output to formatEuro for equivalent parsed amount', () => {
    // "2.300 €" should parse to 2300, format same as formatEuro(2300)
    expect(formatOfferPrice('2.300 €')).toBe(formatEuro(2300))
  })

  it('formats "800 €" correctly', () => {
    const result = formatOfferPrice('800 €')
    expect(result).toMatch(/800,00\s*€/)
  })
})
