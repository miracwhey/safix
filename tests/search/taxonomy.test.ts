/**
 * Search domain – trade taxonomy + query resolution specs (additive, L1).
 *
 * Covers `normalizeTerm` (KEY A fold), `resolveQuery` (exact → compound →
 * OSA-fuzzy) and `expandTrade`. Pure functions, no I/O — fully deterministic.
 *
 * Asserts the customer-facing intent: synonyms / layman terms / industry
 * spellings, umlaut folds, typo tolerance and label-drift all collapse onto the
 * SAME canonical trade, while nonsense resolves to NOTHING (no false
 * cross-match into an unrelated trade).
 */

import { describe, it, expect } from 'vitest'
import { normalizeTerm, resolveQuery, expandTrade, canonicalizeTrade } from '../../src/lib/search/taxonomy'

describe('normalizeTerm — KEY A fold', () => {
  it('folds German umlauts and ß into the ASCII digraph form', () => {
    expect(normalizeTerm('Sanitär')).toBe('sanitaer')
    expect(normalizeTerm('Böden')).toBe('boeden')
    expect(normalizeTerm('Türen')).toBe('tueren')
    expect(normalizeTerm('Straße')).toBe('strasse')
  })

  it('expands "&" to " und " and collapses punctuation to spaces', () => {
    expect(normalizeTerm('Fenster & Türen')).toBe('fenster und tueren')
    expect(normalizeTerm('Heizungs-Wartung')).toBe('heizungs wartung')
  })

  it('returns an empty string for blank / punctuation-only input', () => {
    expect(normalizeTerm('')).toBe('')
    expect(normalizeTerm('   ---  ')).toBe('')
  })
})

describe('resolveQuery — synonym / layman / industry-spelling resolution', () => {
  it('resolves the layman term "Klempner" to Sanitär', () => {
    expect(resolveQuery('Klempner').matchedTrades).toContain('Sanitär')
  })

  it('resolves the industry abbreviation "SHK" to Sanitär', () => {
    // SHK is a legitimate alias of both Sanitär and Heizung — the contract is
    // only that Sanitär is reached, never a spurious unrelated trade.
    expect(resolveQuery('SHK').matchedTrades).toContain('Sanitär')
  })

  it('resolves the layman term "Streichen" to Maler', () => {
    expect(resolveQuery('Streichen').matchedTrades).toContain('Maler')
  })

  it('resolves the synonym "Tischler" to Schreiner', () => {
    expect(resolveQuery('Tischler').matchedTrades).toContain('Schreiner')
  })
})

describe('resolveQuery — umlaut fold', () => {
  it('resolves the digraph spelling "Sanitaer" to Sanitär', () => {
    expect(resolveQuery('Sanitaer').matchedTrades).toContain('Sanitär')
  })

  it('resolves the bare-vowel spelling "sanitar" to Sanitär', () => {
    expect(resolveQuery('sanitar').matchedTrades).toContain('Sanitär')
  })
})

describe('resolveQuery — typo tolerance (Damerau / OSA)', () => {
  it('tolerates the transposition typo "elektirker" → Elektrik', () => {
    expect(resolveQuery('elektirker').matchedTrades).toContain('Elektrik')
  })

  it('tolerates the missing-letter typo "fliesn" → Fliesen', () => {
    expect(resolveQuery('fliesn').matchedTrades).toContain('Fliesen')
  })
})

describe('resolveQuery — label-drift collapse', () => {
  it('collapses the alias "Malerei" onto the exact same canonical as "Maler"', () => {
    const drift = resolveQuery('Malerei').matchedTrades
    const canonical = resolveQuery('Maler').matchedTrades
    expect(drift).toEqual(['Maler'])
    expect(drift).toEqual(canonical)
  })
})

describe('resolveQuery — negative case (no false cross-match)', () => {
  it('resolves a nonsense token to no trade at all', () => {
    expect(resolveQuery('qwxzptlk').matchedTrades).toEqual([])
  })

  it('never bleeds a nonsense token into an unrelated trade', () => {
    const matched = resolveQuery('blarghzxqw').matchedTrades
    expect(matched).not.toContain('Sanitär')
    expect(matched).not.toContain('Elektrik')
    expect(matched).toHaveLength(0)
  })
})

describe('resolveQuery — standalone concepts preempt wrong-trade fuzzy bleed', () => {
  it('resolves the bare token "Decke" to Trockenbau (not Garten via "Hecke")', () => {
    const matched = resolveQuery('Decke').matchedTrades
    expect(matched).toContain('Trockenbau')
    expect(matched).not.toContain('Garten')
  })

  it('resolves the bare token "Gras" to Garten (not Fenster & Türen via "Glas")', () => {
    const matched = resolveQuery('Gras').matchedTrades
    expect(matched).toContain('Garten')
    expect(matched).not.toContain('Fenster & Türen')
  })
})

describe('resolveQuery — high-frequency layman completeness', () => {
  it('resolves "Mischbatterie" to Sanitär', () => {
    expect(resolveQuery('Mischbatterie').matchedTrades).toContain('Sanitär')
  })

  it('resolves "Schimmel" to Maler', () => {
    expect(resolveQuery('Schimmel').matchedTrades).toContain('Maler')
  })

  it('resolves "Wallbox" to Elektrik', () => {
    expect(resolveQuery('Wallbox').matchedTrades).toContain('Elektrik')
  })

  it('resolves "Klimaanlage" to Heizung', () => {
    expect(resolveQuery('Klimaanlage').matchedTrades).toContain('Heizung')
  })
})

describe('resolveQuery — protected near-collision guard (no fuzzy bleed)', () => {
  it('does not fuzz the non-trade word "Fach" onto Dach', () => {
    expect(resolveQuery('Fach').matchedTrades).not.toContain('Dach')
  })

  it('does not fuzz the non-trade word "Bach" onto Dach', () => {
    expect(resolveQuery('Bach').matchedTrades).not.toContain('Dach')
  })

  it('still resolves the real word "Dach" to Dach (exact preempts the guard)', () => {
    expect(resolveQuery('Dach').matchedTrades).toContain('Dach')
  })
})

describe('canonicalizeTrade — candidate-side label-drift folding', () => {
  it('folds the alias "Schreinerei" onto the canonical "Schreiner"', () => {
    expect(canonicalizeTrade('Schreinerei')).toBe('Schreiner')
    expect(canonicalizeTrade('Schreinerei')).toBe(canonicalizeTrade('Schreiner'))
  })

  it('folds the alias "Malerei" onto the canonical "Maler"', () => {
    expect(canonicalizeTrade('Malerei')).toBe('Maler')
  })

  it('returns the input unchanged for an unknown label', () => {
    expect(canonicalizeTrade('völliger Unsinn xyz')).toBe('völliger Unsinn xyz')
  })

  it('returns the input unchanged for an ambiguous label (never guesses)', () => {
    // "SHK" maps to both Sanitär and Heizung → not unambiguous → unchanged.
    expect(canonicalizeTrade('SHK')).toBe('SHK')
  })
})

describe('expandTrade — query-adjacency expansion', () => {
  it('returns the related trades for a known canonical', () => {
    expect(expandTrade('Elektrik')).toContain('Sanitär')
  })

  it('returns an empty list for an unknown canonical', () => {
    expect(expandTrade('Nichtgewerk')).toEqual([])
  })
})
