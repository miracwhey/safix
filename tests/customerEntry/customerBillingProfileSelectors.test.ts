/**
 * Customer Billing Profile Selectors — Unit Tests (Block 7.1B2)
 *
 * Validiert die reine Logik in
 * `src/lib/customer/customerBillingProfileSelectors.ts`:
 *   - Format-Checks für Postleitzahl, USt-IdNr., E-Mail, Country-Code.
 *   - Vollständigkeitskriterien (`isCustomerBillingProfileComplete`).
 *   - Form-Validation inkl. Geschäftskunde-Edge.
 *
 * KEINE I/O, kein Supabase — pure Functions.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidPostalCodeFormat,
  isValidVatIdFormat,
  isValidEmailFormat,
  isValidCountryCode,
  validateCustomerBillingProfileForm,
  isCustomerBillingProfileComplete,
  deriveFundingBillingGate,
} from '../../src/lib/customer/customerBillingProfileSelectors'
import type {
  CustomerBillingProfile,
  CustomerBillingProfileForm,
} from '../../src/lib/customer/customerBillingProfileService'

function makeForm(
  overrides: Partial<CustomerBillingProfileForm> = {},
): CustomerBillingProfileForm {
  return {
    billingName: 'Anna Beispiel',
    billingAddressLine1: 'Beispielweg 12',
    billingAddressLine2: null,
    billingPostalCode: '10115',
    billingCity: 'Berlin',
    billingCountry: 'DE',
    billingEmail: null,
    billingPhone: null,
    isBusiness: false,
    businessName: null,
    vatId: null,
    ...overrides,
  }
}

function makeProfile(
  overrides: Partial<CustomerBillingProfile> = {},
): CustomerBillingProfile {
  return {
    id: 'cbp-1',
    userId: 'user-1',
    billingName: 'Anna Beispiel',
    billingAddressLine1: 'Beispielweg 12',
    billingAddressLine2: null,
    billingPostalCode: '10115',
    billingCity: 'Berlin',
    billingCountry: 'DE',
    billingEmail: null,
    billingPhone: null,
    isBusiness: false,
    businessName: null,
    vatId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// ── Format-Checks ────────────────────────────────────────────────────────────

describe('isValidPostalCodeFormat', () => {
  it('akzeptiert deutsche und internationale Formate', () => {
    expect(isValidPostalCodeFormat('10115')).toBe(true)
    expect(isValidPostalCodeFormat('SW1A 1AA')).toBe(true)
    expect(isValidPostalCodeFormat('1010')).toBe(true)
  })

  it('weist offensichtlichen Müll ab', () => {
    expect(isValidPostalCodeFormat('')).toBe(false)
    expect(isValidPostalCodeFormat('!!')).toBe(false)
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

describe('isValidEmailFormat', () => {
  it('akzeptiert plausible E-Mail-Adressen', () => {
    expect(isValidEmailFormat('anna@example.com')).toBe(true)
    expect(isValidEmailFormat('a.b+c@x.y')).toBe(true)
  })

  it('weist Müll ab', () => {
    expect(isValidEmailFormat('foo')).toBe(false)
    expect(isValidEmailFormat('foo@bar')).toBe(false)
  })
})

describe('isValidCountryCode', () => {
  it('akzeptiert genau 2 Buchstaben', () => {
    expect(isValidCountryCode('DE')).toBe(true)
    expect(isValidCountryCode('at')).toBe(true)
  })

  it('weist andere Werte ab', () => {
    expect(isValidCountryCode('DEU')).toBe(false)
    expect(isValidCountryCode('1A')).toBe(false)
    expect(isValidCountryCode('')).toBe(false)
  })
})

// ── validateCustomerBillingProfileForm ───────────────────────────────────────

describe('validateCustomerBillingProfileForm', () => {
  it('akzeptiert das vollständige Privatkunden-Form', () => {
    const result = validateCustomerBillingProfileForm(makeForm())
    expect(result.isValid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('flaggt fehlende Pflichtangaben einzeln', () => {
    const result = validateCustomerBillingProfileForm(
      makeForm({
        billingName: '',
        billingAddressLine1: '',
        billingPostalCode: '',
        billingCity: '',
        billingCountry: '',
      }),
    )
    expect(result.isValid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'billing_name_missing',
        'address_line1_missing',
        'postal_code_missing',
        'city_missing',
        'country_missing',
      ]),
    )
    expect(result.issues).not.toContain('postal_code_format')
  })

  it('flaggt ungültige Formate, ohne fehlende Pflichten zu doppeln', () => {
    const result = validateCustomerBillingProfileForm(
      makeForm({ billingPostalCode: '!!', billingCountry: 'DEU' }),
    )
    expect(result.issues).toContain('postal_code_format')
    expect(result.issues).toContain('country_format')
    expect(result.issues).not.toContain('postal_code_missing')
  })

  it('verlangt businessName bei Geschäftskunden', () => {
    const ok = validateCustomerBillingProfileForm(
      makeForm({ isBusiness: true, businessName: 'Beispiel GmbH' }),
    )
    expect(ok.isValid).toBe(true)

    const missing = validateCustomerBillingProfileForm(
      makeForm({ isBusiness: true, businessName: null }),
    )
    expect(missing.isValid).toBe(false)
    expect(missing.issues).toContain('business_name_missing')
  })

  it('flaggt nur ungültige USt-IdNr., wenn etwas eingegeben wurde', () => {
    const empty = validateCustomerBillingProfileForm(
      makeForm({ isBusiness: true, businessName: 'X', vatId: null }),
    )
    expect(empty.isValid).toBe(true)

    const broken = validateCustomerBillingProfileForm(
      makeForm({ isBusiness: true, businessName: 'X', vatId: 'XY' }),
    )
    expect(broken.issues).toContain('vat_id_format')
  })

  it('flaggt ungültige E-Mail nur, wenn etwas eingegeben wurde', () => {
    const empty = validateCustomerBillingProfileForm(
      makeForm({ billingEmail: null }),
    )
    expect(empty.isValid).toBe(true)

    const broken = validateCustomerBillingProfileForm(
      makeForm({ billingEmail: 'not-an-email' }),
    )
    expect(broken.issues).toContain('email_format')
  })
})

// ── isCustomerBillingProfileComplete ─────────────────────────────────────────

describe('isCustomerBillingProfileComplete', () => {
  it('ist false bei null', () => {
    expect(isCustomerBillingProfileComplete(null)).toBe(false)
  })

  it('ist true bei vollständigem Privatprofil', () => {
    expect(isCustomerBillingProfileComplete(makeProfile())).toBe(true)
  })

  it('ist false, sobald Name fehlt', () => {
    expect(
      isCustomerBillingProfileComplete(makeProfile({ billingName: null })),
    ).toBe(false)
  })

  it('ist false, sobald Anschrift unvollständig ist', () => {
    expect(
      isCustomerBillingProfileComplete(
        makeProfile({ billingAddressLine1: null }),
      ),
    ).toBe(false)
    expect(
      isCustomerBillingProfileComplete(makeProfile({ billingPostalCode: null })),
    ).toBe(false)
    expect(
      isCustomerBillingProfileComplete(makeProfile({ billingCity: null })),
    ).toBe(false)
  })

  it('ist false bei kaputtem Country-Code', () => {
    expect(
      isCustomerBillingProfileComplete(makeProfile({ billingCountry: 'DEU' })),
    ).toBe(false)
  })

  it('verlangt businessName bei isBusiness=true', () => {
    expect(
      isCustomerBillingProfileComplete(
        makeProfile({ isBusiness: true, businessName: null }),
      ),
    ).toBe(false)

    expect(
      isCustomerBillingProfileComplete(
        makeProfile({ isBusiness: true, businessName: 'Beispiel GmbH' }),
      ),
    ).toBe(true)
  })

  it('ist true für Geschäftskunde ohne USt-IdNr. (B2 erzwingt sie nicht)', () => {
    expect(
      isCustomerBillingProfileComplete(
        makeProfile({ isBusiness: true, businessName: 'X', vatId: null }),
      ),
    ).toBe(true)
  })
})

// ── deriveFundingBillingGate ─────────────────────────────────────────────────

describe('deriveFundingBillingGate', () => {
  it('zeigt das Gate, wenn Funding pre-confirm und Profil unvollständig ist', () => {
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'created',
        billingPhase: 'incomplete',
      }),
    ).toBe('show-gate')
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'sent',
        billingPhase: 'incomplete',
      }),
    ).toBe('show-gate')
  })

  it('zeigt das Gate auch im Lade-Zustand pre-confirm (keep-safe)', () => {
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'created',
        billingPhase: 'loading',
      }),
    ).toBe('show-gate')
  })

  it('lässt die Karte durch, sobald das Profil vollständig ist', () => {
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'created',
        billingPhase: 'complete',
      }),
    ).toBe('show-card')
  })

  it('blockiert nicht, sobald die Stripe-Initiierung gestartet hat', () => {
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'funding_started',
        billingPhase: 'incomplete',
      }),
    ).toBe('show-card')
    expect(
      deriveFundingBillingGate({
        fundingStatus: 'funding_initiated',
        billingPhase: 'incomplete',
      }),
    ).toBe('show-card')
  })

  it('lässt funded/failed/cancelled unverändert durch', () => {
    for (const status of ['funded', 'funding_failed', 'cancelled', 'expired']) {
      expect(
        deriveFundingBillingGate({
          fundingStatus: status,
          billingPhase: 'incomplete',
        }),
      ).toBe('show-card')
    }
  })

  it('lässt unbekannten Status unverändert durch (kein false-positive Block)', () => {
    expect(
      deriveFundingBillingGate({
        fundingStatus: undefined,
        billingPhase: 'incomplete',
      }),
    ).toBe('show-card')
  })
})
