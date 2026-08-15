/**
 * Tests for src/lib/spatial/canonical/algebra/time.ts (XM-4 audit-fix).
 */
import { describe, it, expect } from 'vitest'

import {
  unixMsToIso,
  isoToUnixMs,
} from '../../../../../src/lib/spatial/canonical/algebra/time.ts'

describe('time · unixMsToIso', () => {
  it('produces a strict ISO-8601 round-trippable string', () => {
    const ms = 1_700_000_000_000
    const iso = unixMsToIso(ms)
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Date.parse(iso)).toBe(ms)
  })

  it('throws on NaN', () => {
    expect(() => unixMsToIso(Number.NaN)).toThrow(/finite/)
  })

  it('throws on Infinity', () => {
    expect(() => unixMsToIso(Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })
})

describe('time · isoToUnixMs', () => {
  it('parses a canonical ISO timestamp', () => {
    expect(isoToUnixMs('2026-05-19T12:34:56.789Z')).toBe(
      Date.UTC(2026, 4, 19, 12, 34, 56, 789),
    )
  })

  it('round-trips through unixMsToIso', () => {
    const ms = 1_700_000_000_123
    expect(isoToUnixMs(unixMsToIso(ms))).toBe(ms)
  })

  it('throws on an unparseable string', () => {
    expect(() => isoToUnixMs('not a date')).toThrow(/invalid ISO/)
  })
})
