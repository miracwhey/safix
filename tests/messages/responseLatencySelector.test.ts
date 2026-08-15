import { describe, expect, it } from 'vitest'
import {
  deriveProviderResponseLatency,
  formatResponseLatencyLabel,
} from '../../src/lib/messages/responseLatencySelector'

describe('deriveProviderResponseLatency', () => {
  it('liefert „< 4 h", wenn Provider verifiziert UND ratingCount >= 5', () => {
    expect(
      deriveProviderResponseLatency({
        craftsmanUserId: 'p1',
        ratingCount: 7,
        verified: true,
      }),
    ).toBe('< 4 h')
  })

  it('liefert „< 1 d", wenn nur ratingCount >= 1 (egal ob verifiziert)', () => {
    expect(
      deriveProviderResponseLatency({
        craftsmanUserId: 'p2',
        ratingCount: 2,
        verified: false,
      }),
    ).toBe('< 1 d')
  })

  it('liefert „< 1 d", wenn verifiziert aber zu wenig Bewertungen', () => {
    expect(
      deriveProviderResponseLatency({
        craftsmanUserId: 'p3',
        ratingCount: 3,
        verified: true,
      }),
    ).toBe('< 1 d')
  })

  it('liefert null, wenn Provider keine Bewertungen hat', () => {
    expect(
      deriveProviderResponseLatency({
        craftsmanUserId: 'p4',
        ratingCount: 0,
        verified: true,
      }),
    ).toBeNull()
  })
})

describe('formatResponseLatencyLabel', () => {
  it('gibt formatiertes Label zurück', () => {
    expect(formatResponseLatencyLabel('< 4 h')).toBe('Antwort meist < 4 h')
    expect(formatResponseLatencyLabel('< 1 d')).toBe('Antwort meist < 1 d')
    expect(formatResponseLatencyLabel('1-2 d')).toBe('Antwort meist 1-2 d')
  })

  it('gibt null zurück, wenn kein Label verfügbar', () => {
    expect(formatResponseLatencyLabel(null)).toBeNull()
  })
})
