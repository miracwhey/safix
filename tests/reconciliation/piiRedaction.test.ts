import { describe, it, expect } from 'vitest'
import { redactPII, redactPIIList } from '../../src/lib/reconciliation/piiRedaction'

describe('piiRedaction', () => {
  it('returns an empty string for null/undefined/empty input', () => {
    expect(redactPII(null)).toBe('')
    expect(redactPII(undefined)).toBe('')
    expect(redactPII('')).toBe('')
  })

  it('redacts a plain email address', () => {
    expect(redactPII('Schreib mir an a.musterfrau@example.com bitte.')).toBe(
      'Schreib mir an [geschwärzt] bitte.',
    )
  })

  it('redacts multiple emails in the same string', () => {
    const out = redactPII('Mails: a@b.de und x.y@example.org sind aktiv.')
    expect(out).toBe('Mails: [geschwärzt] und [geschwärzt] sind aktiv.')
  })

  it('redacts a German mobile number with country code', () => {
    expect(redactPII('Tel +49 151 1234567 oder besser per Mail.')).toContain('[geschwärzt]')
  })

  it('redacts a German landline 0301234567', () => {
    expect(redactPII('Festnetz: 030 1234567')).toContain('[geschwärzt]')
  })

  it('does not redact an ordinary 4-digit number', () => {
    expect(redactPII('Betrag 2140 EUR vereinbart.')).toBe('Betrag 2140 EUR vereinbart.')
  })

  it('redacts an IBAN-like string', () => {
    expect(redactPII('IBAN: DE89 3704 0044 0532 0130 00')).toContain('[geschwärzt]')
  })

  it('redacts a postal code + city pattern', () => {
    expect(redactPII('Adresse: 10115 Berlin, weitere Details')).toContain('[geschwärzt]')
  })

  it('redacts a counterparty display name when supplied', () => {
    const out = redactPII('Ich war bei Mustermann GmbH vor Ort.', {
      counterpartyNames: ['Mustermann GmbH'],
    })
    expect(out).toBe('Ich war bei [geschwärzt] vor Ort.')
  })

  it('redacts a counterparty email when supplied', () => {
    const out = redactPII('Kontakt: lena.bergmann@example.com', {
      counterpartyEmails: ['lena.bergmann@example.com'],
    })
    expect(out).toBe('Kontakt: [geschwärzt]')
  })

  it('redacts a partial counterparty name match case-insensitively', () => {
    const out = redactPII('Frau bergmann hat zugestimmt.', {
      counterpartyNames: ['Bergmann'],
    })
    expect(out).toBe('Frau [geschwärzt] hat zugestimmt.')
  })

  it('leaves benign technical text alone', () => {
    const text = 'Status: under_review · splitRatio 0.6 · refundedAt 2026-04-18'
    expect(redactPII(text)).toBe(text)
  })

  it('redacts a list of strings via redactPIIList', () => {
    const out = redactPIIList(['mail: a@b.de', null, 'IBAN DE89 3704 0044 0532 0130 00'])
    expect(out[0]).toContain('[geschwärzt]')
    expect(out[1]).toBe('')
    expect(out[2]).toContain('[geschwärzt]')
  })

  it('skips counterparty names shorter than 3 characters to avoid over-redaction', () => {
    const out = redactPII('Hi there', { counterpartyNames: ['Hi'] })
    expect(out).toBe('Hi there')
  })
})
