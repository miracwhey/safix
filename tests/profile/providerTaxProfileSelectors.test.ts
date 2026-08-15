/**
 * Provider Tax Profile Selectors — Unit Tests (Block 7.1B1)
 *
 * Validiert die reine Logik in `src/lib/providers/taxProfileSelectors.ts`:
 *   - Format-Checks für Steuernummer, USt-IdNr., IBAN, BIC.
 *   - Vollständigkeitskriterien (`isTaxProfileComplete`).
 *   - Form-Validation (`validateTaxProfileForm`) inkl. Kleinunternehmer-Edge.
 *
 * KEINE I/O, kein Supabase — pure Functions.
 */

import { describe, it, expect } from 'vitest'
import {
  ALLOWED_DEFAULT_VAT_RATES,
  isAllowedDefaultVatRate,
  isValidTaxNumberFormat,
  isValidVatIdFormat,
  isValidIbanFormat,
  isValidBicFormat,
  isValidLegalForm,
  validateTaxProfileForm,
  isTaxProfileComplete,
  hasBankingDetails,
} from '../../src/lib/providers/taxProfileSelectors'
import type {
  ProviderTaxProfile,
  ProviderTaxProfileForm,
} from '../../src/lib/providers/providerProfileService'

function makeForm(
  overrides: Partial<ProviderTaxProfileForm> = {},
): ProviderTaxProfileForm {
  return {
    taxNumber: '12/345/67890',
    vatId: null,
    legalForm: 'einzelunternehmer',
    isKleinunternehmer: false,
    defaultVatRate: 19,
    iban: null,
    bic: null,
    ...overrides,
  }
}

function makeProfile(
  overrides: Partial<ProviderTaxProfile> = {},
): ProviderTaxProfile {
  return {
    taxNumber: '12/345/67890',
    vatId: null,
    legalForm: 'einzelunternehmer',
    isKleinunternehmer: false,
    defaultVatRate: 19,
    iban: null,
    bic: null,
    ...overrides,
  }
}

// ── Format-Checks ────────────────────────────────────────────────────────────

describe('isValidTaxNumberFormat', () => {
  it('akzeptiert übliche deutsche Formate', () => {
    expect(isValidTaxNumberFormat('12/345/67890')).toBe(true)
    expect(isValidTaxNumberFormat('123/456/78901')).toBe(true)
    expect(isValidTaxNumberFormat('12345-67890')).toBe(true)
  })

  it('weist offensichtlichen Müll ab', () => {
    expect(isValidTaxNumberFormat('abc')).toBe(false)
    expect(isValidTaxNumberFormat('')).toBe(false)
  })
})

describe('isValidVatIdFormat', () => {
  it('akzeptiert Länderkürzel + alphanumerisch', () => {
    expect(isValidVatIdFormat('DE123456789')).toBe(true)
    expect(isValidVatIdFormat('de 123 456 789')).toBe(true)
    expect(isValidVatIdFormat('ATU12345678')).toBe(true)
  })

  it('weist Werte ohne Länderkürzel ab', () => {
    expect(isValidVatIdFormat('123456789')).toBe(false)
    expect(isValidVatIdFormat('XY')).toBe(false)
  })
})

describe('isValidIbanFormat', () => {
  it('akzeptiert IBANs mit/ohne Spaces', () => {
    expect(isValidIbanFormat('DE89370400440532013000')).toBe(true)
    expect(isValidIbanFormat('DE89 3704 0044 0532 0130 00')).toBe(true)
  })

  it('weist zu kurze oder reine Buchstaben ab', () => {
    expect(isValidIbanFormat('DE12')).toBe(false)
    expect(isValidIbanFormat('ABCDEFG')).toBe(false)
  })
})

describe('isValidBicFormat', () => {
  it('akzeptiert 8- und 11-stellige BICs', () => {
    expect(isValidBicFormat('COBADEFF')).toBe(true)
    expect(isValidBicFormat('COBADEFFXXX')).toBe(true)
  })

  it('weist falsche Längen / Zeichen ab', () => {
    expect(isValidBicFormat('COBA')).toBe(false)
    expect(isValidBicFormat('COBADEFFXX')).toBe(false)
  })
})

describe('isValidLegalForm', () => {
  it('akzeptiert nur Werte aus dem Enum', () => {
    expect(isValidLegalForm('gmbh')).toBe(true)
    expect(isValidLegalForm('einzelunternehmer')).toBe(true)
    expect(isValidLegalForm('startup')).toBe(false)
  })
})

describe('isAllowedDefaultVatRate', () => {
  it('akzeptiert genau 0, 7, 19', () => {
    for (const rate of ALLOWED_DEFAULT_VAT_RATES) {
      expect(isAllowedDefaultVatRate(rate)).toBe(true)
    }
    expect(isAllowedDefaultVatRate(16)).toBe(false)
    expect(isAllowedDefaultVatRate(20)).toBe(false)
  })
})

// ── validateTaxProfileForm ───────────────────────────────────────────────────

describe('validateTaxProfileForm', () => {
  it('akzeptiert minimal vollständigen Eingang (nur Steuernummer)', () => {
    const result = validateTaxProfileForm(makeForm())
    expect(result.isValid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('akzeptiert nur USt-IdNr. ohne Steuernummer', () => {
    const result = validateTaxProfileForm(
      makeForm({ taxNumber: null, vatId: 'DE123456789' }),
    )
    expect(result.isValid).toBe(true)
  })

  it('weist komplett fehlende Identifikation ab', () => {
    const result = validateTaxProfileForm(
      makeForm({ taxNumber: null, vatId: null }),
    )
    expect(result.isValid).toBe(false)
    expect(result.issues).toContain('tax_identification_missing')
  })

  it('akzeptiert Kleinunternehmer ohne USt-IdNr., aber nicht ohne Steuernummer', () => {
    const ok = validateTaxProfileForm(
      makeForm({ isKleinunternehmer: true, taxNumber: '12/345/67890', vatId: null }),
    )
    expect(ok.isValid).toBe(true)

    const missing = validateTaxProfileForm(
      makeForm({ isKleinunternehmer: true, taxNumber: null, vatId: null }),
    )
    expect(missing.isValid).toBe(false)
    expect(missing.issues).toContain('tax_identification_missing')
  })

  it('flaggt ungültige Formate, ohne fehlende Identifikation zu doppeln', () => {
    const result = validateTaxProfileForm(
      makeForm({
        taxNumber: 'abc',
        vatId: 'XY',
        iban: 'AB12',
        bic: 'INVALID',
      }),
    )
    expect(result.issues).toEqual(
      expect.arrayContaining(['tax_number_format', 'vat_id_format', 'iban_format', 'bic_format']),
    )
    expect(result.issues).not.toContain('tax_identification_missing')
  })

  it('flaggt ungültigen USt-Satz', () => {
    const result = validateTaxProfileForm(makeForm({ defaultVatRate: 16 }))
    expect(result.issues).toContain('default_vat_rate_invalid')
  })

  it('akzeptiert leere optionale Felder', () => {
    const result = validateTaxProfileForm(
      makeForm({
        legalForm: null,
        iban: null,
        bic: null,
      }),
    )
    expect(result.isValid).toBe(true)
  })
})

// ── isTaxProfileComplete ─────────────────────────────────────────────────────

describe('isTaxProfileComplete', () => {
  it('ist true bei nur Steuernummer und Standard-USt-Satz', () => {
    expect(isTaxProfileComplete(makeProfile())).toBe(true)
  })

  it('ist true bei nur USt-IdNr.', () => {
    expect(
      isTaxProfileComplete(
        makeProfile({ taxNumber: null, vatId: 'DE123456789' }),
      ),
    ).toBe(true)
  })

  it('ist false ohne jegliche Steueridentifikation', () => {
    expect(
      isTaxProfileComplete(makeProfile({ taxNumber: null, vatId: null })),
    ).toBe(false)
  })

  it('ist false bei ungültigem USt-Satz', () => {
    expect(
      isTaxProfileComplete(makeProfile({ defaultVatRate: 16 })),
    ).toBe(false)
  })
})

// ── hasBankingDetails ────────────────────────────────────────────────────────

describe('hasBankingDetails', () => {
  it('ist true sobald eine IBAN hinterlegt ist', () => {
    expect(hasBankingDetails(makeProfile({ iban: 'DE89370400440532013000' }))).toBe(true)
  })

  it('ist false ohne IBAN — BIC allein reicht nicht', () => {
    expect(hasBankingDetails(makeProfile({ iban: null, bic: 'COBADEFF' }))).toBe(false)
    expect(hasBankingDetails(makeProfile({ iban: '   ' }))).toBe(false)
  })
})
