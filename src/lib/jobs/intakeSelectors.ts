import type { Job, IntakeContext } from './types'

// ---------------------------------------------------------------------------
// Placeholder sentinels used when intake fields are absent
// These must match the values set in convertInquiryToProjectWorkflow
// ---------------------------------------------------------------------------

const DESCRIPTION_PLACEHOLDER_PREFIX = 'Anfrage über SaFix –'
const LOCATION_PLACEHOLDER = 'Ort folgt'
const DATE_PLACEHOLDER = 'Termin offen'

/**
 * Describes how complete the intake context is for a newly created job.
 *
 * 'thin'    – very little information; the craftsman needs to actively clarify
 *             requirements with the customer before proceeding.
 * 'partial' – some information is present but one or more key fields are missing.
 * 'ready'   – all key intake fields are populated; the job can move directly to
 *             scheduling.
 */
export type IntakeReadiness = 'thin' | 'partial' | 'ready'

export type IntakeMissingField = {
  id: string
  /** Short German label shown in the UI */
  label: string
}

export type IntakeReadinessViewModel = {
  readiness: IntakeReadiness
  /** Short human-readable label, e.g. "Unvollständig – Details fehlen" */
  readinessLabel: string
  /** Colour token used by the UI to style the readiness badge */
  readinessColor: 'red' | 'yellow' | 'green'
  /** Origin of the intake, if available */
  origin: IntakeContext['origin'] | null
  /** Human-readable origin label */
  originLabel: string
  /** Fields that are still missing and should be obtained from the customer */
  missingFields: IntakeMissingField[]
  /** Number of key fields that are already present */
  completedCount: number
  /** Total number of key fields checked */
  totalCount: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FieldCheck = {
  id: string
  label: string
  present: boolean
}

function buildFieldChecks(job: Job): FieldCheck[] {
  const ctx = job.intakeContext

  return [
    {
      id: 'description',
      label: 'Projektbeschreibung',
      present: Boolean(
        ctx?.requestDescription
          ? ctx.requestDescription.trim().length > 0
          : job.description && !job.description.startsWith(DESCRIPTION_PLACEHOLDER_PREFIX)
      ),
    },
    {
      id: 'location',
      label: 'Arbeitsort',
      present: Boolean(
        (ctx?.requestLocation ?? job.location) &&
          (ctx?.requestLocation ?? job.location) !== LOCATION_PLACEHOLDER
      ),
    },
    {
      id: 'budget',
      label: 'Budgetrahmen',
      present: Boolean(ctx?.requestBudget ?? (job.amount && job.amount !== '')),
    },
    {
      id: 'duration',
      label: 'Projektdauer',
      present: Boolean(ctx?.requestDuration),
    },
    {
      id: 'schedule',
      label: 'Wunschtermin',
      present: Boolean(job.dateLabel && job.dateLabel !== DATE_PLACEHOLDER),
    },
  ]
}

function computeReadiness(
  completedCount: number,
  totalCount: number
): IntakeReadiness {
  if (completedCount === totalCount) return 'ready'
  if (completedCount >= Math.ceil(totalCount / 2)) return 'partial'
  return 'thin'
}

function readinessLabel(readiness: IntakeReadiness): string {
  switch (readiness) {
    case 'thin':
      return 'Anfrage unvollständig – Details klären'
    case 'partial':
      return 'Teilweise vollständig – noch Angaben fehlen'
    case 'ready':
      return 'Anfrage vollständig'
  }
}

function readinessColor(
  readiness: IntakeReadiness
): 'red' | 'yellow' | 'green' {
  switch (readiness) {
    case 'thin':
      return 'red'
    case 'partial':
      return 'yellow'
    case 'ready':
      return 'green'
  }
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a view-model that describes the intake completeness of a job.
 *
 * This is a pure read helper — it performs no state mutations.
 * It is most useful for jobs in 'new' status where the craftsman still needs
 * to assess whether enough information is available to start scheduling.
 */
export function deriveIntakeReadiness(job: Job): IntakeReadinessViewModel {
  const checks = buildFieldChecks(job)
  const missingFields = checks
    .filter((c) => !c.present)
    .map<IntakeMissingField>(({ id, label }) => ({ id, label }))

  const completedCount = checks.filter((c) => c.present).length
  const totalCount = checks.length
  const readiness = computeReadiness(completedCount, totalCount)

  return {
    readiness,
    readinessLabel: readinessLabel(readiness),
    readinessColor: readinessColor(readiness),
    origin: job.intakeContext?.origin ?? null,
    originLabel: job.intakeContext?.originLabel ?? 'Direkt',
    missingFields,
    completedCount,
    totalCount,
  }
}
