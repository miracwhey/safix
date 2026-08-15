/**
 * Commercial Document Validator — Paket 4a
 *
 * Type-specific hard validation rules for pre-execution commercial documents.
 * This is the domain-layer enforcement point: only structurally complete documents
 * may be sent, regardless of how they are submitted (UI, API, tests).
 *
 * Called by:
 *   - createOfferWorkflow (when documentType is explicitly provided)
 *   - QuoteCreationSheet (UI validation — same rules, no duplication)
 *
 * INVARIANT: validation gates here must mirror what is presented as required in
 * QuoteCreationSheet. No hidden requirements that only surface at workflow time.
 *
 * ChangeOrder-Anschlussfähigkeit:
 *   The validator is parameterised on documentType and a flat ValidatableParams
 *   bag. ChangeOrders can define their own documentType values and call this
 *   validator with an appropriate set of params without restructuring.
 */

import type { OfferDocumentType } from './types'

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * A single validation error for a commercial document.
 *
 * - code:    machine-readable identifier (use in error messages, logs)
 * - message: human-readable German message shown to craftsman
 * - section: which commercial section is violated (for UI grouping)
 * - field:   optional specific form field name
 */
export type DocumentValidationError = {
  code: string
  message: string
  section: 'pricing' | 'scope' | 'exclusions' | 'assumptions' | 'payment' | 'validity'
  field?: string
}

export type DocumentValidationResult = {
  valid: boolean
  errors: DocumentValidationError[]
}

// ── Validatable params ────────────────────────────────────────────────────────

/**
 * The minimal set of fields the validator requires to make type-specific
 * decisions. All fields are optional — emptiness is what triggers errors.
 */
export type ValidatableOfferParams = {
  price?: string
  scopeSummary?: string
  scopeExcluded?: string
  paymentTerms?: string
  validUntil?: string
  assumptions?: string
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isEmpty(v: string | undefined | null): boolean {
  return !v || !v.trim()
}

// ── Validator ─────────────────────────────────────────────────────────────────

/**
 * Validates a commercial document against the type-specific hard requirements.
 *
 * Returns a structured result with all errors (not just the first). This allows
 * the UI to show the complete list of missing sections at once rather than
 * forcing the craftsman through a one-error-at-a-time loop.
 *
 * Rules per documentType:
 *
 * binding_offer:
 *   price, scopeSummary, scopeExcluded, validUntil are required.
 *   paymentTerms is NOT required — the platform escrow model is the primary
 *   payment truth. paymentTerms is stored as optional Sonderbedingungen.
 *
 * cost_estimate:
 *   price, scopeSummary, scopeExcluded, validUntil are required.
 *   Concrete scope is expected, but no payment terms apply.
 *
 * estimate:
 *   price, scopeSummary, assumptions (Unsicherheiten/Schätzbasis),
 *   scopeExcluded, validUntil are required.
 *   An estimate without explicit uncertainty basis is commercially misleading.
 *
 * diagnosis:
 *   price, scopeSummary, assumptions (Freigabegrenze), validUntil are required.
 *   A diagnosis without an approval limit cannot properly govern additional work.
 */
export function validateOfferDocument(
  documentType: OfferDocumentType,
  params: ValidatableOfferParams
): DocumentValidationResult {
  const errors: DocumentValidationError[] = []

  if (documentType === 'binding_offer') {
    if (isEmpty(params.price)) {
      errors.push({
        code: 'BINDING_OFFER_MISSING_PRICE',
        message: 'Preis / Gesamtbetrag ist erforderlich.',
        section: 'pricing',
        field: 'price',
      })
    }
    if (isEmpty(params.scopeSummary)) {
      errors.push({
        code: 'BINDING_OFFER_MISSING_SCOPE',
        message: 'Leistungsbeschreibung ist erforderlich.',
        section: 'scope',
        field: 'scopeSummary',
      })
    }
    if (isEmpty(params.scopeExcluded)) {
      errors.push({
        code: 'BINDING_OFFER_MISSING_EXCLUSIONS',
        message: 'Ausschlüsse / Nicht enthaltene Leistungen sind erforderlich.',
        section: 'exclusions',
        field: 'scopeExcluded',
      })
    }
    // paymentTerms is NOT required: the platform escrow model is the primary
    // payment truth. paymentTerms is stored as optional Sonderbedingungen only.
    if (isEmpty(params.validUntil)) {
      errors.push({
        code: 'BINDING_OFFER_MISSING_VALIDITY',
        message: 'Gültigkeit ist für ein verbindliches Angebot erforderlich.',
        section: 'validity',
        field: 'validUntil',
      })
    }
  } else if (documentType === 'cost_estimate') {
    if (isEmpty(params.price)) {
      errors.push({
        code: 'COST_ESTIMATE_MISSING_PRICE',
        message: 'Preis / Kostenschätzung ist erforderlich.',
        section: 'pricing',
        field: 'price',
      })
    }
    if (isEmpty(params.scopeSummary)) {
      errors.push({
        code: 'COST_ESTIMATE_MISSING_SCOPE',
        message: 'Leistungsbeschreibung ist für einen Kostenvoranschlag erforderlich.',
        section: 'scope',
        field: 'scopeSummary',
      })
    }
    if (isEmpty(params.scopeExcluded)) {
      errors.push({
        code: 'COST_ESTIMATE_MISSING_EXCLUSIONS',
        message: 'Ausschlüsse / Nicht enthaltene Leistungen sind für einen Kostenvoranschlag erforderlich.',
        section: 'exclusions',
        field: 'scopeExcluded',
      })
    }
    if (isEmpty(params.validUntil)) {
      errors.push({
        code: 'COST_ESTIMATE_MISSING_VALIDITY',
        message: 'Gültigkeit ist für einen Kostenvoranschlag erforderlich.',
        section: 'validity',
        field: 'validUntil',
      })
    }
  } else if (documentType === 'estimate') {
    if (isEmpty(params.price)) {
      errors.push({
        code: 'ESTIMATE_MISSING_PRICE',
        message: 'Schätzbetrag ist erforderlich.',
        section: 'pricing',
        field: 'price',
      })
    }
    if (isEmpty(params.scopeSummary)) {
      errors.push({
        code: 'ESTIMATE_MISSING_SCOPE',
        message: 'Schätzbasis / Leistungsbeschreibung ist erforderlich.',
        section: 'scope',
        field: 'scopeSummary',
      })
    }
    if (isEmpty(params.assumptions)) {
      errors.push({
        code: 'ESTIMATE_MISSING_UNCERTAINTY_BASIS',
        message: 'Unsicherheiten / Abweichungsgründe sind für eine Schätzung erforderlich.',
        section: 'assumptions',
        field: 'assumptions',
      })
    }
    if (isEmpty(params.scopeExcluded)) {
      errors.push({
        code: 'ESTIMATE_MISSING_EXCLUSIONS',
        message: 'Ausschlüsse / Nicht enthaltene Leistungen sind für eine Schätzung erforderlich.',
        section: 'exclusions',
        field: 'scopeExcluded',
      })
    }
    if (isEmpty(params.validUntil)) {
      errors.push({
        code: 'ESTIMATE_MISSING_VALIDITY',
        message: 'Gültigkeit ist für eine Schätzung erforderlich.',
        section: 'validity',
        field: 'validUntil',
      })
    }
  } else if (documentType === 'diagnosis') {
    if (isEmpty(params.price)) {
      errors.push({
        code: 'DIAGNOSIS_MISSING_PRICE',
        message: 'Preis / Einsatzpauschale ist erforderlich.',
        section: 'pricing',
        field: 'price',
      })
    }
    if (isEmpty(params.scopeSummary)) {
      errors.push({
        code: 'DIAGNOSIS_MISSING_SCOPE',
        message: 'Einsatzbeschreibung ist erforderlich.',
        section: 'scope',
        field: 'scopeSummary',
      })
    }
    if (isEmpty(params.assumptions)) {
      errors.push({
        code: 'DIAGNOSIS_MISSING_APPROVAL_LIMIT',
        message: 'Freigabegrenze / Zusatzarbeitsregel ist für einen Diagnose-Einsatz erforderlich.',
        section: 'assumptions',
        field: 'assumptions',
      })
    }
    if (isEmpty(params.validUntil)) {
      errors.push({
        code: 'DIAGNOSIS_MISSING_VALIDITY',
        message: 'Gültigkeit ist für einen Diagnose-Einsatz erforderlich.',
        section: 'validity',
        field: 'validUntil',
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Convenience: returns validation error messages as a flat string array
 * for direct use in UI error lists.
 */
export function getValidationMessages(result: DocumentValidationResult): string[] {
  return result.errors.map((e) => e.message)
}
