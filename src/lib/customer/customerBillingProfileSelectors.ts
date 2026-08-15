/**
 * Customer Billing Profile Selectors
 *
 * Pure Helper für das Customer-seitige Rechnungsprofil (Block 7.1B2).
 *
 * Geltungsbereich:
 *   - App-seitige Validierung des Billing-Forms.
 *   - Vollständigkeitssignal für Funding-Gate ("Rechnungsdaten ergänzen").
 *   - Light-Format-Checks für Postleitzahl, USt-IdNr., E-Mail.
 *   - KEINE Steuer-Beratungs-Logik. KEINE §13b-Reverse-Charge-Aktivierung.
 *
 * Issuance-Hard-Gates ("Keine Rechnung ohne Empfänger-Anschrift") werden
 * hier vorbereitet, aber erst in 7.1B3+ scharfgeschaltet. In B2 ist
 * `isCustomerBillingProfileComplete` ausschliesslich Funding-Gate-Logik —
 * Invoice-Issuance bleibt unverändert.
 */

import type {
  CustomerBillingProfile,
  CustomerBillingProfileForm,
} from './customerBillingProfileService'

// ── Format-Validierung (light, kein Checksum-Algorithmus) ───────────────────

const POSTAL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9 -]{2,11}$/
const VAT_ID_PATTERN = /^[A-Z]{2}[A-Z0-9 ]{6,30}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normaliseUpper(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase()
}

export function isValidPostalCodeFormat(value: string): boolean {
  return POSTAL_CODE_PATTERN.test(value.trim().toUpperCase())
}

export function isValidVatIdFormat(value: string): boolean {
  return VAT_ID_PATTERN.test(normaliseUpper(value))
}

export function isValidEmailFormat(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim())
}

export function isValidCountryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value.trim().toUpperCase())
}

// ── Vollständigkeit & Validierung ───────────────────────────────────────────

export type CustomerBillingValidationIssue =
  | 'billing_name_missing'
  | 'address_line1_missing'
  | 'postal_code_missing'
  | 'postal_code_format'
  | 'city_missing'
  | 'country_missing'
  | 'country_format'
  | 'business_name_missing'
  | 'vat_id_format'
  | 'email_format'

export type CustomerBillingValidationResult = {
  isValid: boolean
  issues: CustomerBillingValidationIssue[]
}

/**
 * Validiert ein Eingabe-Form für das Customer-Billing-Profile.
 *
 * Pflichtregeln (in B2):
 *   - `billingName` ist Pflicht — auf der späteren Rechnung der Empfänger.
 *   - `billingAddressLine1`, `billingPostalCode`, `billingCity`,
 *     `billingCountry` sind Pflicht (vollständige Anschrift gemäss §14 UStG).
 *   - `addressLine2` ist optional.
 *   - Wenn `isBusiness = true`: `businessName` ist Pflicht; `vatId` ist
 *     optional (Privatpersonen mit Geschäftskontext bleiben möglich, USt-IdNr.
 *     wird in B3 für §13b erforderlich, in B2 nur erfasst).
 *   - Format-Checks gelten nur, wenn das jeweilige Feld nicht leer ist.
 *   - E-Mail/Phone bleiben optional und werden nur formatiert, nicht erzwungen.
 *
 * Reine Funktion. Keine Side-Effects, kein I/O.
 */
export function validateCustomerBillingProfileForm(
  form: CustomerBillingProfileForm,
): CustomerBillingValidationResult {
  const issues: CustomerBillingValidationIssue[] = []

  const billingName = (form.billingName ?? '').trim()
  const addressLine1 = (form.billingAddressLine1 ?? '').trim()
  const postalCode = (form.billingPostalCode ?? '').trim()
  const city = (form.billingCity ?? '').trim()
  const country = (form.billingCountry ?? '').trim()

  if (billingName.length === 0) issues.push('billing_name_missing')
  if (addressLine1.length === 0) issues.push('address_line1_missing')

  if (postalCode.length === 0) {
    issues.push('postal_code_missing')
  } else if (!isValidPostalCodeFormat(postalCode)) {
    issues.push('postal_code_format')
  }

  if (city.length === 0) issues.push('city_missing')

  if (country.length === 0) {
    issues.push('country_missing')
  } else if (!isValidCountryCode(country)) {
    issues.push('country_format')
  }

  if (form.isBusiness) {
    const businessName = (form.businessName ?? '').trim()
    if (businessName.length === 0) issues.push('business_name_missing')
  }

  const vatId = (form.vatId ?? '').trim()
  if (vatId.length > 0 && !isValidVatIdFormat(vatId)) {
    issues.push('vat_id_format')
  }

  const email = (form.billingEmail ?? '').trim()
  if (email.length > 0 && !isValidEmailFormat(email)) {
    issues.push('email_format')
  }

  return { isValid: issues.length === 0, issues }
}

/**
 * Liefert `true`, wenn das gespeicherte Billing-Profile die §14-UStG-
 * Empfänger-Pflichten erfüllt: vollständiger Name + vollständige Anschrift.
 *
 * Geschäftskunden mit `isBusiness=true` müssen zusätzlich `businessName`
 * gesetzt haben — `vatId` ist in B2 nicht zwingend (kommt in B3 als
 * §13b-Voraussetzung).
 *
 * Wird im Funding-Flow als Gate-Bedingung benutzt: unvollständiges Profil
 * → "Rechnungsdaten ergänzen"-CTA statt direktem Stripe-Confirm. Reine
 * Funktion.
 */
export function isCustomerBillingProfileComplete(
  profile: CustomerBillingProfile | null,
): boolean {
  if (!profile) return false

  const name = (profile.billingName ?? '').trim()
  const line1 = (profile.billingAddressLine1 ?? '').trim()
  const postal = (profile.billingPostalCode ?? '').trim()
  const city = (profile.billingCity ?? '').trim()
  const country = (profile.billingCountry ?? '').trim()

  if (
    name.length === 0 ||
    line1.length === 0 ||
    postal.length === 0 ||
    city.length === 0 ||
    country.length === 0
  ) {
    return false
  }

  if (!isValidCountryCode(country)) return false

  if (profile.isBusiness) {
    const businessName = (profile.businessName ?? '').trim()
    if (businessName.length === 0) return false
  }

  return true
}

// ── Funding-Gate-Decision ───────────────────────────────────────────────────

/**
 * Funding-Status, in denen die Customer-Aktion noch aussteht. Sobald die
 * Stripe-Initiierung gestartet ist (`funding_started`/`funding_initiated`)
 * darf das Billing-Gate die Karte nicht mehr ersetzen — eine laufende
 * Stripe-Bestätigung würde sonst orphaned werden.
 */
export type FundingPreconfirmStatus = 'created' | 'sent'

export type FundingBillingGateDecision = 'show-gate' | 'show-card'

export type FundingBillingGateInputs = {
  /** Aktueller Funding-Request-Status, oder undefined wenn noch unbekannt. */
  fundingStatus: string | undefined
  /** Lade-Status der Billing-Profile-Abfrage. */
  billingPhase: 'loading' | 'complete' | 'incomplete'
}

const PRECONFIRM_STATUSES = new Set<string>(['created', 'sent'])

/**
 * Entscheidet, ob im Funding-Screen die Billing-Gate-CTA gezeigt werden
 * muss. Reine Funktion — keine Side-Effects, kein I/O. Wird vom Screen
 * aufgerufen und getrennt unit-getestet (Block 7.1B2).
 *
 * Regeln:
 *   - Pre-Confirm (`created`/`sent`) und Profil unvollständig → `show-gate`.
 *   - Pre-Confirm und Profil-Status noch im Laden → `show-gate` (keep-safe:
 *     der Customer soll erst zahlen, sobald der Status zuverlässig
 *     bestätigt ist).
 *   - Profil vollständig → `show-card`.
 *   - Funding bereits in Initiierung / funded / failed / cancelled →
 *     `show-card` (Stripe-Flow nicht unterbrechen).
 */
export function deriveFundingBillingGate(
  inputs: FundingBillingGateInputs,
): FundingBillingGateDecision {
  const { fundingStatus, billingPhase } = inputs

  const isPreconfirm = !!fundingStatus && PRECONFIRM_STATUSES.has(fundingStatus)
  if (!isPreconfirm) return 'show-card'
  if (billingPhase === 'complete') return 'show-card'
  return 'show-gate'
}
