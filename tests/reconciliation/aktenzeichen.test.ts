import { describe, it, expect } from 'vitest'
import {
  aktenzeichenFromUrlSlug,
  aktenzeichenToUrlSlug,
  findDisputeByAktenzeichen,
  formatAktenzeichen,
  parseAktenzeichen,
} from '../../src/lib/reconciliation/aktenzeichen'

describe('aktenzeichen', () => {
  describe('formatAktenzeichen', () => {
    it('produces a deterministic R-NNNN/MM-YYYY string for valid input', () => {
      const akz = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        '2026-04-18T14:32:00.000Z',
      )
      expect(akz).not.toBeNull()
      expect(akz).toMatch(/^R-\d{4}\/04-2026$/)
    })

    it('returns the same value across repeated calls', () => {
      const a = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        '2026-04-18T14:32:00.000Z',
      )
      const b = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        '2026-04-18T14:32:00.000Z',
      )
      expect(a).toBe(b)
    })

    it('produces different sequences for different UUIDs in the same month', () => {
      const a = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        '2026-04-18T14:32:00.000Z',
      )
      const b = formatAktenzeichen(
        '11111111-2222-3333-4444-555555555555',
        '2026-04-19T08:00:00.000Z',
      )
      expect(a).not.toBe(b)
    })

    it('returns null for an unparseable createdAt', () => {
      const akz = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        'not-a-date',
      )
      expect(akz).toBeNull()
    })

    it('returns null for an empty disputeId', () => {
      const akz = formatAktenzeichen('', '2026-04-18T14:32:00.000Z')
      expect(akz).toBeNull()
    })

    it('uses UTC month for the month component', () => {
      // 2026-01-31T23:30:00Z is still January in UTC; should bucket to 01-2026
      const akz = formatAktenzeichen(
        '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
        '2026-01-31T23:30:00.000Z',
      )
      expect(akz).toMatch(/^R-\d{4}\/01-2026$/)
    })
  })

  describe('url slug roundtrip', () => {
    it('replaces the slash with an underscore for URL safety', () => {
      expect(aktenzeichenToUrlSlug('R-2042/04-2026')).toBe('R-2042_04-2026')
    })

    it('restores the canonical display form', () => {
      expect(aktenzeichenFromUrlSlug('R-2042_04-2026')).toBe('R-2042/04-2026')
    })

    it('parses both display and URL forms identically', () => {
      const display = parseAktenzeichen('R-2042/04-2026')
      const slug = parseAktenzeichen('R-2042_04-2026')
      expect(slug).toEqual(display)
    })
  })

  describe('parseAktenzeichen', () => {
    it('parses a well-formed Aktenzeichen', () => {
      const parsed = parseAktenzeichen('R-2042/04-2026')
      expect(parsed).toEqual({ sequence: 2042, month: 4, year: 2026 })
    })

    it('rejects an Aktenzeichen with a missing prefix', () => {
      expect(parseAktenzeichen('2042/04-2026')).toBeNull()
    })

    it('rejects an Aktenzeichen with too many digits in the sequence', () => {
      expect(parseAktenzeichen('R-20422/04-2026')).toBeNull()
    })

    it('rejects an out-of-range month', () => {
      expect(parseAktenzeichen('R-2042/13-2026')).toBeNull()
    })

    it('returns null for empty input', () => {
      expect(parseAktenzeichen('')).toBeNull()
    })
  })

  describe('findDisputeByAktenzeichen', () => {
    const disputes = [
      { id: '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22', createdAt: '2026-04-18T14:32:00.000Z' },
      { id: '11111111-2222-3333-4444-555555555555', createdAt: '2026-04-19T08:00:00.000Z' },
      { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: '2026-03-12T10:00:00.000Z' },
    ]

    it('finds the dispute matching a formatted Aktenzeichen', () => {
      const akz = formatAktenzeichen(disputes[0].id, disputes[0].createdAt)
      expect(akz).not.toBeNull()
      const found = findDisputeByAktenzeichen(akz as string, disputes)
      expect(found?.id).toBe(disputes[0].id)
    })

    it('returns null for an Aktenzeichen that does not match any candidate', () => {
      const found = findDisputeByAktenzeichen('R-9999/12-1999', disputes)
      expect(found).toBeNull()
    })

    it('returns null for an unparseable Aktenzeichen', () => {
      expect(findDisputeByAktenzeichen('garbage', disputes)).toBeNull()
    })
  })
})
