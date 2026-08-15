import { describe, it, expect } from 'vitest'
import { TOS_REACCEPT_AFTER, isTosAcceptanceStale } from '../../src/lib/legal/legalVersion'

describe('legalVersion · ToS re-acceptance gate', () => {
  // ── Dormancy guard: the shipped constant MUST be null ──────────────────────
  // This path has no env-flag insulation and runs on every authenticated render;
  // a non-null value here forces every existing user to re-accept LIVE. Ship null;
  // set the flip date only at activation (with the Textform notice period).
  it('ships DORMANT — TOS_REACCEPT_AFTER is null', () => {
    expect(TOS_REACCEPT_AFTER).toBeNull()
  })

  // ── Dormant: byte-identical (never stale) for every input ──────────────────
  // With the default (null) cutoff the derivation returns the raw value unchanged,
  // so session.ts tosAcceptedAt is exactly profile.tos_accepted_at as before.
  describe('dormant (cutoff = TOS_REACCEPT_AFTER = null)', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['valid ISO', '2025-01-01T00:00:00.000Z'],
      ['recent ISO', '2026-06-15T10:00:00.000Z'],
      ['malformed', 'not-a-date'],
      ['empty string', ''],
    ])('never stale for %s input', (_label, input) => {
      expect(isTosAcceptanceStale(input as string | null | undefined)).toBe(false)
    })
  })

  // ── Active (explicit cutoff): re-consent enforced for old acceptances only ──
  describe('active (explicit cutoff)', () => {
    const cutoff = new Date('2026-06-15T00:00:00.000Z')

    it('stale when acceptance predates the cutoff', () => {
      expect(isTosAcceptanceStale('2026-06-14T23:59:59.000Z', cutoff)).toBe(true)
      expect(isTosAcceptanceStale('2024-01-01T00:00:00.000Z', cutoff)).toBe(true)
    })

    it('NOT stale when acceptance is at or after the cutoff', () => {
      expect(isTosAcceptanceStale('2026-06-15T00:00:00.000Z', cutoff)).toBe(false) // exactly at cutoff (< is strict)
      expect(isTosAcceptanceStale('2026-06-15T00:00:01.000Z', cutoff)).toBe(false)
      expect(isTosAcceptanceStale('2027-01-01T00:00:00.000Z', cutoff)).toBe(false)
    })

    it('NOT stale (fail-open) for null / undefined / malformed timestamps — never lock out on bad data', () => {
      expect(isTosAcceptanceStale(null, cutoff)).toBe(false)
      expect(isTosAcceptanceStale(undefined, cutoff)).toBe(false)
      expect(isTosAcceptanceStale('not-a-date', cutoff)).toBe(false)
      expect(isTosAcceptanceStale('', cutoff)).toBe(false)
    })

    it('timezone-stable: same instant in different offsets compares identically', () => {
      // 2026-06-14T23:00:00Z == 2026-06-15T01:00:00+02:00 — both are BEFORE the
      // 2026-06-15T00:00:00Z cutoff and must both be stale, regardless of notation.
      expect(isTosAcceptanceStale('2026-06-14T23:00:00.000Z', cutoff)).toBe(true)
      expect(isTosAcceptanceStale('2026-06-15T01:00:00.000+02:00', cutoff)).toBe(true)
      // And the same instant just after the cutoff is NOT stale in either notation.
      expect(isTosAcceptanceStale('2026-06-15T00:00:01.000Z', cutoff)).toBe(false)
      expect(isTosAcceptanceStale('2026-06-15T02:00:01.000+02:00', cutoff)).toBe(false)
    })
  })
})
