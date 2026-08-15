/**
 * Provider Tax Profile Selectors
 *
 * Pure helpers für das Steuer-/Bankprofil eines Handwerkers (Block 7.1B1).
 *
 * Geltungsbereich:
 *   - App-seitige Validierung der Eingabefelder.
 *   - Vollständigkeitssignal für die Profilanzeige (separat von der
 *     5-stufigen Onboarding-Logik in `lib/onboarding/selectors.ts`).
 *   - KEIN Steuer-Beratungs-Logik, keine Auto-Erkennung von 7 % vs. 19 %,
 *     kein §13b-Reverse-Charge — diese Erweiterungen kommen frühestens in
 *     Block 7.1B2+.
 *
 * Discovery- und Auszahlungs-Readiness werden NICHT gestört: das
 * Steuerprofil ist eine eigenständige Vollständigkeitsdimension, die später
 * (B2+) für Rechnungs-Issuance gateet, in B1 jedoch nur signalisiert wird.
 */

import {
  PROVIDER_LEGAL_FORMS,
  type ProviderLegalForm,
  type ProviderTaxProfile,
  type ProviderTaxProfileForm,
} from './providerProfileService'

// ── Zulässige Standard-USt-Sätze ─────────────────────────────────────────────

/**
 * In Deutschland gebräuchliche USt-Sätze, die der Handwerker als Default
 * für neue Rechnungspositionen wählen kann.
 *
 *   - 19 — Regelsteuersatz
 *   - 7  — ermäßigter Steuersatz (z. B. bestimmte Lieferungen)
 *   - 0  — Kleinunternehmer / steuerfrei
 *
 * Andere Werte werden durch {@link isAllowedDefaultVatRate} abgewiesen.
 */
export const ALLOWED_DEFAULT_VAT_RATES = [0, 7, 19] as const
export type AllowedDefaultVatRate = (typeof ALLOWED_DEFAULT_VAT_RATES)[number]

export function isAllowedDefaultVatRate(value: number): value is AllowedDefaultVatRate {
  return (ALLOWED_DEFAULT_VAT_RATES as readonly number[]).includes(value)
}

// ── Format-Validierung (light, kein Checksum-Algorithmus) ───────────────────

const TAX_NUMBER_PATTERN = /^[0-9./\- ]{6,32}$/
const VAT_ID_PATTERN = /^[A-Z]{2}[A-Z0-9 ]{6,30}$/
const IBAN_PATTERN = /^[A-Z]{2}[0-9A-Z]{13,32}$/
const BIC_PATTERN = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/

/** Entfernt Whitespace und vereinheitlicht Großschreibung — bewahrt eingegebene Trennzeichen. */
function normaliseUpper(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

export function isValidTaxNumberFormat(value: string): boolean {
  return TAX_NUMBER_PATTERN.test(value.trim())
}

export function isValidVatIdFormat(value: string): boolean {
  return VAT_ID_PATTERN.test(normaliseUpper(value))
}

export function isValidIbanFormat(value: string): boolean {
  return IBAN_PATTERN.test(normaliseUpper(value))
}

export function isValidBicFormat(value: string): boolean {
  return BIC_PATTERN.test(normaliseUpper(value))
}

export function isValidLegalForm(value: string): value is ProviderLegalForm {
  return (PROVIDER_LEGAL_FORMS as readonly string[]).includes(value)
}

// ── Vollständigkeit & Validierung ───────────────────────────────────────────

export type TaxProfileValidationIssue =
  | 'tax_identification_missing'
  | 'tax_number_format'
  | 'vat_id_format'
  | 'legal_form_invalid'
  | 'iban_format'
  | 'bic_format'
  | 'default_vat_rate_invalid'

export type TaxProfileValidationResult = {
  isValid: boolean
  issues: TaxProfileValidationIssue[]
}

/**
 * Validiert ein Eingabe-Form für das Steuerprofil.
 *
 * Pflichtregeln:
 *   - Mindestens `taxNumber` ODER `vatId` ist gesetzt; wenn
 *     `isKleinunternehmer = true`, darf `vatId` fehlen, `taxNumber` bleibt
 *     aber empfohlen — eine vollständig leere Identifikation wird abgewiesen.
 *   - `legalForm` ist optional, muss aber — falls gesetzt — zum Enum passen.
 *   - `defaultVatRate` muss in {@link ALLOWED_DEFAULT_VAT_RATES} liegen.
 *   - Alle Format-Checks gelten nur, wenn das jeweilige Feld nicht leer ist.
 *
 * Reine Funktion. Keine Steuer-Beratungs-Logik.
 */
export function validateTaxProfileForm(
  form: ProviderTaxProfileForm,
): TaxProfileValidationResult {
  const issues: TaxProfileValidationIssue[] = []

  const hasTaxNumber = !!form.taxNumber && form.taxNumber.trim().length > 0
  const hasVatId = !!form.vatId && form.vatId.trim().length > 0

  if (!hasTaxNumber && !hasVatId) {
    issues.push('tax_identification_missing')
  }

  if (hasTaxNumber && !isValidTaxNumberFormat(form.taxNumber!)) {
    issues.push('tax_number_format')
  }
  if (hasVatId && !isValidVatIdFormat(form.vatId!)) {
    issues.push('vat_id_format')
  }

  if (form.legalForm !== null && !isValidLegalForm(form.legalForm)) {
    issues.push('legal_form_invalid')
  }

  if (!isAllowedDefaultVatRate(form.defaultVatRate)) {
    issues.push('default_vat_rate_invalid')
  }

  if (form.iban && form.iban.trim().length > 0 && !isValidIbanFormat(form.iban)) {
    issues.push('iban_format')
  }
  if (form.bic && form.bic.trim().length > 0 && !isValidBicFormat(form.bic)) {
    issues.push('bic_format')
  }

  return { isValid: issues.length === 0, issues }
}

/**
 * Liefert `true`, wenn das gespeicherte Steuerprofil die Mindestpflichten
 * für eine spätere §14-UStG-Rechnungs-Issuance erfüllt.
 *
 * Mindestkriterien (B1):
 *   - `taxNumber` ODER `vatId` vorhanden.
 *   - Wenn `isKleinunternehmer = false`: `vatId` ist nicht zwingend, aber
 *     mindestens eine der beiden Identifikationen muss da sein.
 *   - `defaultVatRate` ist gesetzt (DB-DEFAULT 19) und im erlaubten Set.
 *
 * Bewusst KEIN Pflichtfeld in B1: legal_form, iban, bic. Diese sind für
 * das Steuersignal nicht hart erforderlich — sie verbessern aber den
 * Profil-Vollständigkeitsgrad und werden in B2 ggf. zu Hard-Gates.
 *
 * Reine Funktion.
 */
export function isTaxProfileComplete(profile: ProviderTaxProfile): boolean {
  const hasTaxNumber = !!profile.taxNumber && profile.taxNumber.trim().length > 0
  const hasVatId = !!profile.vatId && profile.vatId.trim().length > 0

  if (!hasTaxNumber && !hasVatId) return false
  if (!isAllowedDefaultVatRate(profile.defaultVatRate)) return false

  return true
}

/**
 * Liefert `true`, wenn der Handwerker eine IBAN für die Rechnungsanzeige
 * hinterlegt hat. Stripe-Auszahlungs-Readiness liegt unverändert in
 * `provider_payout_accounts`; `hasBankingDetails` ist eine reine
 * Profil-Vollständigkeitsdimension.
 */
export function hasBankingDetails(profile: ProviderTaxProfile): boolean {
  return !!profile.iban && profile.iban.trim().length > 0
}
