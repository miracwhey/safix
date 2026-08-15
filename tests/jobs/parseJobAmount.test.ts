import { describe, it, expect } from 'vitest'
import { parseJobAmount } from '../../src/lib/jobs/paymentPrepSelectors'

describe('parseJobAmount', () => {
  // ── Numeric inputs (offer.price from Supabase is numeric) ──────────────
  it('returns a positive number as-is', () => {
    expect(parseJobAmount(1500)).toBe(1500)
  })

  it('returns a decimal number as-is', () => {
    expect(parseJobAmount(640.5)).toBe(640.5)
  })

  it('returns null for zero', () => {
    expect(parseJobAmount(0)).toBeNull()
  })

  it('returns null for negative numbers', () => {
    expect(parseJobAmount(-100)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(parseJobAmount(NaN)).toBeNull()
  })

  it('returns null for Infinity', () => {
    expect(parseJobAmount(Infinity)).toBeNull()
  })

  // ── String inputs (German-formatted amounts) ──────────────────────────
  it('parses simple euro string "640 €"', () => {
    expect(parseJobAmount('640 €')).toBe(640)
  })

  it('parses German thousands separator "2.300 €"', () => {
    expect(parseJobAmount('2.300 €')).toBe(2300)
  })

  it('parses German decimal separator "1.200,50 €"', () => {
    expect(parseJobAmount('1.200,50 €')).toBe(1200.5)
  })

  it('parses budget range "500 – 800 €" taking first value', () => {
    expect(parseJobAmount('500 – 800 €')).toBe(500)
  })

  it('returns null for empty string', () => {
    expect(parseJobAmount('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseJobAmount('   ')).toBeNull()
  })

  // ── Null / undefined ──────────────────────────────────────────────────
  it('returns null for undefined', () => {
    expect(parseJobAmount(undefined)).toBeNull()
  })

  it('returns null for null', () => {
    expect(parseJobAmount(null)).toBeNull()
  })

  // ── No .trim() crash on non-string ────────────────────────────────────
  it('does not throw when called with a number (the offer.price runtime bug)', () => {
    expect(() => parseJobAmount(1500 as unknown as string)).not.toThrow()
  })

  it('does not throw when called with null', () => {
    expect(() => parseJobAmount(null)).not.toThrow()
  })
})
