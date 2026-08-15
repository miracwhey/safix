/**
 * Commercial Document Policy — Paket 1 Foundation, Paket 2 Extension
 *
 * Defines per-documentType policy rules for SaFix's pre-execution commercial
 * documents (Offer). This is the authoritative policy registry for:
 *   - acceptance semantics (what accepting this document type means commercially)
 *   - job kind (what kind of Job this acceptance creates)
 *   - whether a documentType unlocks payment/escrow on acceptance
 *   - whether acceptance creates an Invoice
 *   - execution policy (whether the created Job can enter standard execution)
 *   - the human-readable classification of the document type
 *
 * This is the canonical answer to "what can this document type do?"
 * All downstream logic (workflow guards, payment gating, UI gates) must
 * derive from here — not hardcode per-type branches in isolation.
 *
 * ChangeOrder policy is NOT here — ChangeOrders are a separate domain
 * (src/lib/changeOrders/) with their own lifecycle and policy.
 *
 * PAKET 2 — Policy extensions:
 *   - acceptanceKind: named semantic for what "acceptance" means per type
 *   - jobKind: the kind of Job created on acceptance
 *   - allowsStandardExecution: guards execution corridor access
 *   - allowsDiagnosisExecution: marks diagnosis-specific execution path
 *   These four fields make type differences real at the workflow/guard layer.
 */

import type { OfferDocumentType } from './types'

// ── Acceptance kind ───────────────────────────────────────────────────────────

/**
 * Named acceptance semantics per documentType (Paket 2).
 *
 * 'binding_acceptance'              — Full commercial commitment. Unlocks payment,
 *                                     escrow, invoice, and standard execution.
 * 'estimate_confirmation'           — Non-binding acknowledgement. Creates a tracking
 *                                     Job only. No payment, escrow, invoice, or
 *                                     standard execution.
 * 'cost_estimate_acknowledgement'   — Acknowledgement of a concrete cost estimate.
 *                                     Creates a cost-estimate tracking Job. No payment,
 *                                     no escrow, no standard execution corridor.
 * 'diagnosis_approval'              — Approval of a diagnostic engagement. Creates a
 *                                     diagnosis Job with own instant-payment path.
 *                                     No standard escrow corridor.
 */
export type OfferAcceptanceKind =
  | 'binding_acceptance'
  | 'estimate_confirmation'
  | 'cost_estimate_acknowledgement'
  | 'diagnosis_approval'

// ── Job kind ─────────────────────────────────────────────────────────────────

/**
 * Operational kind for a Job created by offer acceptance (Paket 2).
 *
 * 'standard'                — Normal execution job. Created by binding_offer acceptance.
 *                             Full payment/escrow/execution corridor active.
 * 'estimate_tracking'       — Tracking-only job. Created by estimate acceptance.
 *                             No payment, no escrow, no standard execution.
 *                             Exists to track the work scope without commercial commitment.
 * 'cost_estimate_tracking'  — Tracking job from Kostenvoranschlag acknowledgement.
 *                             Concrete scope acknowledged, but no payment/escrow.
 *                             Exists to track without becoming a binding commitment.
 * 'diagnosis'               — Diagnostic engagement job. Created by diagnosis acceptance.
 *                             Own diagnosis instant-payment path (5 % fee).
 *                             No standard escrow. Not estimate_tracking — has defined
 *                             diagnostic scope and its own payment.
 */
export type JobKind = 'standard' | 'estimate_tracking' | 'cost_estimate_tracking' | 'diagnosis'

// ── Policy shape ─────────────────────────────────────────────────────────────

export type OfferDocumentTypePolicy = {
  // ── Paket 1 fields ────────────────────────────────────────────────────────

  /** Whether this document type unlocks the payment/escrow corridor on acceptance */
  allowsPaymentGating: boolean
  /** Whether acceptance creates or links a Job */
  allowsJobCreation: boolean
  /** Whether acceptance creates an EscrowPlan and FundingRequest */
  allowsEscrow: boolean
  /** Whether acceptance auto-creates an Invoice draft */
  allowsInvoice: boolean
  /**
   * Internal policy branch label.
   * Use for structural branching decisions, not display.
   *   'binding'    — full commercial execution path
   *   'non_binding' — job tracking only, no payment
   *   'diagnosis'  — own diagnosis path, not estimate or binding
   */
  policyBranch: 'binding' | 'non_binding' | 'diagnosis'

  // ── Paket 2 fields ────────────────────────────────────────────────────────

  /**
   * Named acceptance semantics for this document type.
   * What does it mean when a customer "accepts" this document?
   *   'binding_acceptance'    — Full commercial commitment, payment unlocked.
   *   'estimate_confirmation' — Non-binding acknowledgement, tracking only.
   *   'diagnosis_approval'    — Diagnosis engagement approved, own path.
   */
  acceptanceKind: OfferAcceptanceKind

  /**
   * The kind of Job that acceptance of this document type creates.
   * Used by the Job entity itself to enforce execution/payment guards
   * without needing to join back to the Offer.
   *   'standard'          — Normal execution job (binding_offer only)
   *   'estimate_tracking' — Tracking-only job (estimate)
   *   'diagnosis'         — Diagnostic job (diagnosis)
   */
  jobKind: JobKind

  /**
   * Whether a Job created by this document type may enter the standard
   * execution corridor (requestFunding → startJob → completeJob → release).
   *
   * false for estimate_tracking and diagnosis — these must NOT enter the
   * standard payment/escrow/execution path.
   */
  allowsStandardExecution: boolean

  /**
   * Whether a Job created by this document type may enter the diagnosis
   * execution path (diagnosis-scoped work, not full execution).
   *
   * true only for diagnosis — diagnosis jobs have their own narrower
   * execution scope. Not applicable to standard or estimate_tracking jobs.
   */
  allowsDiagnosisExecution: boolean

  /**
   * Whether acceptance of this document type triggers the diagnosis instant-payment path.
   * true only for 'diagnosis'. Mutually exclusive with allowsPaymentGating.
   * When true, acceptance creates a Payment with state 'diagnosis_payment_pending'
   * and the platform charges diagnosisFeePercent of the offer amount.
   */
  allowsDiagnosisPayment: boolean

  /**
   * Platform fee percentage for diagnosis instant-payments.
   * Only meaningful when allowsDiagnosisPayment = true.
   * undefined for all other document types.
   */
  diagnosisFeePercent: number | undefined

  /** German label for the document type (display use) */
  label: string
  /** German description of what this document type means commercially */
  description: string
}

// ── Policy registry ───────────────────────────────────────────────────────────

const POLICIES: Record<OfferDocumentType, OfferDocumentTypePolicy> = {
  estimate: {
    // Paket 1
    allowsPaymentGating: false,
    allowsJobCreation: true,
    allowsEscrow: false,
    allowsInvoice: false,
    policyBranch: 'non_binding',
    // Paket 2
    acceptanceKind: 'estimate_confirmation',
    jobKind: 'estimate_tracking',
    allowsStandardExecution: false,
    allowsDiagnosisExecution: false,
    allowsDiagnosisPayment: false,
    diagnosisFeePercent: undefined,
    label: 'Schätzung',
    description:
      'Unverbindliche Schätzung / Richtpreis. Bestätigung erstellt Verfolgungsauftrag — kein Zahlungskorridor, keine Zahlung, keine Standardausführung.',
  },
  cost_estimate: {
    // Paket 1
    allowsPaymentGating: false,
    allowsJobCreation: true,
    allowsEscrow: false,
    allowsInvoice: false,
    policyBranch: 'non_binding',
    // Paket 2
    acceptanceKind: 'cost_estimate_acknowledgement',
    jobKind: 'cost_estimate_tracking',
    allowsStandardExecution: false,
    allowsDiagnosisExecution: false,
    allowsDiagnosisPayment: false,
    diagnosisFeePercent: undefined,
    label: 'Kostenvoranschlag',
    description:
      'Kostenvoranschlag — konkreter als Schätzung, aber kein bindender Auftragsabschluss. Bestätigung erstellt Verfolgungsauftrag — kein Escrow, kein Standard-Zahlungskorridor.',
  },
  binding_offer: {
    // Paket 1
    allowsPaymentGating: true,
    allowsJobCreation: true,
    allowsEscrow: true,
    allowsInvoice: true,
    policyBranch: 'binding',
    // Paket 2
    acceptanceKind: 'binding_acceptance',
    jobKind: 'standard',
    allowsStandardExecution: true,
    allowsDiagnosisExecution: false,
    allowsDiagnosisPayment: false,
    diagnosisFeePercent: undefined,
    label: 'Verbindliches Angebot',
    description:
      'Verbindliches Angebot. Annahme erstellt Auftrag und öffnet Zahlungskorridor (Zahlung + Rechnung). Einziger Pfad für normalen Projektstart mit Standard-Escrow.',
  },
  diagnosis: {
    // Paket 1
    allowsPaymentGating: false,
    allowsJobCreation: true,
    allowsEscrow: false,
    allowsInvoice: false,
    policyBranch: 'diagnosis',
    // Paket 2
    acceptanceKind: 'diagnosis_approval',
    jobKind: 'diagnosis',
    allowsStandardExecution: false,
    allowsDiagnosisExecution: true,
    allowsDiagnosisPayment: true,
    diagnosisFeePercent: 5,
    label: 'Diagnose-Einsatz',
    description:
      'Diagnose-Einsatz. Freigabe löst eigenen In-App-Sofortzahlungspfad mit 5 % Plattformgebühr aus. Kein Standard-Escrow. Kein Vollauftrag — nur Diagnoseumfang.',
  },
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the full policy for a given OfferDocumentType.
 * Throws for unknown types to prevent silent misconfiguration.
 */
export function getDocumentTypePolicy(documentType: OfferDocumentType): OfferDocumentTypePolicy {
  const policy = POLICIES[documentType]
  if (!policy) {
    throw new Error(
      `[commercialDocumentPolicy] Unknown OfferDocumentType: '${documentType}'. ` +
        `Valid values: ${Object.keys(POLICIES).join(', ')}`
    )
  }
  return policy
}

/**
 * Returns true if this document type unlocks the payment corridor on acceptance.
 * Primary check for payment gating — prefer over manual `documentType === 'binding_offer'` checks.
 */
export function documentTypeAllowsPayment(documentType: OfferDocumentType): boolean {
  return POLICIES[documentType]?.allowsPaymentGating ?? false
}

/**
 * Returns true if this document type unlocks the escrow corridor on acceptance.
 */
export function documentTypeAllowsEscrow(documentType: OfferDocumentType): boolean {
  return POLICIES[documentType]?.allowsEscrow ?? false
}

/**
 * Returns the JobKind for a given OfferDocumentType.
 *
 * Used at job-creation time to stamp the Job with its commercial origin kind
 * so downstream guards (execution, payment) can enforce policy at the job level
 * without needing to join back to the Offer.
 */
export function getJobKindForDocumentType(documentType: OfferDocumentType): JobKind {
  return POLICIES[documentType]?.jobKind ?? 'standard'
}

/**
 * Returns the AcceptanceKind for a given OfferDocumentType.
 *
 * Use this to name the acceptance event semantically in logs, analytics,
 * and workflow branches — rather than comparing documentType === 'estimate' etc.
 */
export function getAcceptanceKind(documentType: OfferDocumentType): OfferAcceptanceKind {
  return POLICIES[documentType]?.acceptanceKind ?? 'binding_acceptance'
}

/**
 * Returns true if a Job of this kind may enter the standard execution corridor
 * (requestFunding → startJob → completeJob → release).
 *
 * ONLY 'standard' jobs (from binding_offer acceptance) may do so.
 * 'estimate_tracking' and 'diagnosis' jobs are blocked from standard execution.
 *
 * This is the primary execution guard — all execution entry points must
 * call this (or check job.jobKind) before proceeding.
 */
export function jobKindAllowsStandardExecution(jobKind: JobKind | undefined): boolean {
  if (!jobKind) return true  // legacy jobs without jobKind default to standard
  return POLICIES_BY_JOB_KIND[jobKind]?.allowsStandardExecution ?? true
}

/**
 * Returns true if a Job of this kind may enter the diagnosis execution path.
 * Only 'diagnosis' jobs may do so.
 */
export function jobKindAllowsDiagnosisExecution(jobKind: JobKind | undefined): boolean {
  if (!jobKind) return false
  return POLICIES_BY_JOB_KIND[jobKind]?.allowsDiagnosisExecution ?? false
}

// ── Reverse index: JobKind → policy ──────────────────────────────────────────

const POLICIES_BY_JOB_KIND: Record<JobKind, OfferDocumentTypePolicy> = {
  standard: POLICIES.binding_offer,
  estimate_tracking: POLICIES.estimate,
  cost_estimate_tracking: POLICIES.cost_estimate,
  diagnosis: POLICIES.diagnosis,
}

// ── Legacy bridge ─────────────────────────────────────────────────────────────

/**
 * Derives the effective OfferDocumentType from a raw value, with fallback.
 *
 * Used when reading older data that may have no documentType but has offerMode,
 * or when reading data with neither field set.
 *
 * Priority:
 *   1. documentType if present and valid
 *   2. offerMode='estimate' → 'estimate'
 *   3. offerMode='binding' or absent → 'binding_offer'
 */
export function resolveEffectiveDocumentType(
  documentType: OfferDocumentType | undefined | null,
  offerMode: string | undefined | null
): OfferDocumentType {
  if (documentType && documentType in POLICIES) return documentType
  if (offerMode === 'estimate') return 'estimate'
  return 'binding_offer'
}

/**
 * Derives the legacy offerMode value from a documentType.
 * Used for backward-compatible writes to offer_mode column.
 *
 *   binding_offer  → 'binding'
 *   estimate       → 'estimate'
 *   cost_estimate  → 'estimate' (no payment — maps to same legacy gate)
 *   diagnosis      → 'estimate' (no standard payment — maps to same legacy gate)
 */
export function documentTypeToLegacyOfferMode(documentType: OfferDocumentType): 'binding' | 'estimate' {
  if (documentType === 'binding_offer') return 'binding'
  return 'estimate'
}

/**
 * Convenience: returns true if this document type has its own diagnosis instant-payment path.
 */
export function documentTypeAllowsDiagnosisPayment(documentType: OfferDocumentType): boolean {
  return POLICIES[documentType]?.allowsDiagnosisPayment ?? false
}

/**
 * Returns the diagnosis fee percentage for a given documentType.
 * Returns undefined for non-diagnosis types.
 */
export function getDiagnosisFeePercent(documentType: OfferDocumentType): number | undefined {
  return POLICIES[documentType]?.diagnosisFeePercent
}
