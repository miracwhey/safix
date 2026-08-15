import { describe, it, expect } from 'vitest'
import {
  TYPE_LABEL,
  FOOTER_LABEL,
  THEME,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  STATUS_TONE_CLASS,
  tone,
} from '../../src/components/chat/artifactCardVocab'

/**
 * Block-2 invoice thread-artifact vocab + tone contract. Pure-data assertions
 * over the shared artifact-card vocabulary — no rendering needed.
 */

describe('artifactCardVocab — Invoice icon key wiring', () => {
  it('TYPE_LABEL.Invoice === "Rechnung"', () => {
    expect(TYPE_LABEL.Invoice).toBe('Rechnung')
  })

  it('FOOTER_LABEL.Invoice === "Rechnung öffnen"', () => {
    expect(FOOTER_LABEL.Invoice).toBe('Rechnung öffnen')
  })

  it('THEME.Invoice is defined with non-empty label/iconBg/icon strings', () => {
    const theme = THEME.Invoice
    expect(theme).toBeDefined()
    expect(typeof theme.label).toBe('string')
    expect(theme.label.length).toBeGreaterThan(0)
    expect(typeof theme.iconBg).toBe('string')
    expect(theme.iconBg.length).toBeGreaterThan(0)
    expect(typeof theme.icon).toBe('string')
    expect(theme.icon.length).toBeGreaterThan(0)
  })
})

describe('artifactCardVocab — INVOICE_STATUS_LABEL (FSM: draft→issued→sent→paid→cancelled)', () => {
  it.each([
    ['draft', 'Entwurf'],
    ['issued', 'Gestellt'],
    ['sent', 'Versendet'],
    ['paid', 'Bezahlt'],
    ['cancelled', 'Storniert'],
  ])('%s → %s', (status, label) => {
    expect(INVOICE_STATUS_LABEL[status]).toBe(label)
  })

  it('covers exactly the 5 invoice lifecycle statuses', () => {
    expect(Object.keys(INVOICE_STATUS_LABEL).sort()).toEqual(
      ['cancelled', 'draft', 'issued', 'paid', 'sent'],
    )
  })
})

describe('artifactCardVocab — INVOICE_STATUS_TONE', () => {
  it.each([
    ['draft', 'expired'],
    ['issued', 'pending'],
    ['sent', 'active'],
    ['paid', 'accepted'],
    ['cancelled', 'declined'],
  ] as const)('%s → %s', (status, expectedTone) => {
    expect(INVOICE_STATUS_TONE[status]).toBe(expectedTone)
  })

  // CRITICAL regression guard: a paid invoice must read emerald ('accepted'),
  // not amber ('pending'). The shared tone() helper has no 'paid' case, so it
  // falls through to 'pending' — the dedicated INVOICE_STATUS_TONE map exists
  // precisely to correct this. Documenting WHY the map exists.
  it('paid → "accepted" (emerald), NOT the shared tone("paid") fallthrough', () => {
    expect(INVOICE_STATUS_TONE.paid).toBe('accepted')
    expect(tone('paid')).toBe('pending')
    expect(tone('paid')).not.toBe(INVOICE_STATUS_TONE.paid)
  })

  // Every tone the map emits must resolve to a pill class, so a status pill is
  // never rendered classless.
  it('every value is a valid STATUS_TONE_CLASS key (pill always has a class)', () => {
    for (const t of Object.values(INVOICE_STATUS_TONE)) {
      expect(STATUS_TONE_CLASS[t]).toBeDefined()
      expect(typeof STATUS_TONE_CLASS[t]).toBe('string')
      expect(STATUS_TONE_CLASS[t].length).toBeGreaterThan(0)
    }
  })
})

describe('artifactCardVocab — ZAG Treuhand/Escrow guard', () => {
  it('no "Treuhand"/"Escrow" substring in any invoice label/footer/status', () => {
    const haystack = [
      TYPE_LABEL.Invoice,
      FOOTER_LABEL.Invoice,
      ...Object.values(INVOICE_STATUS_LABEL),
    ].join(' | ')
    expect(haystack).not.toMatch(/Treuhand/i)
    expect(haystack).not.toMatch(/Escrow/i)
  })
})
