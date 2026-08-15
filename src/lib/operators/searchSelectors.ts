import type { OperatorPriorityCase, OperatorPrioritySeverity } from '../jobs/operatorPrioritySelectors'
import type { OperatorCase, OperatorCaseSeverity } from './operatorCaseSelectors'

/**
 * Filters operator priority cases by a free-text search query.
 *
 * Matches against job ID, case label, type, and severity. Case-insensitive.
 * Returns all cases when the query is empty or whitespace-only.
 *
 * Pure function — no store reads, no side effects.
 */
export function searchOperatorPriorityCases(
  query: string,
  cases: OperatorPriorityCase[]
): OperatorPriorityCase[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return cases

  return cases.filter(
    (c) =>
      c.label.toLowerCase().includes(normalized) ||
      c.type.toLowerCase().includes(normalized) ||
      c.severity.toLowerCase().includes(normalized) ||
      c.jobId.toLowerCase().includes(normalized)
  )
}

/**
 * Filters operator pilot cases by a free-text search query.
 *
 * Matches against job ID, title, description, type, and severity.
 * Case-insensitive. Returns all cases when the query is empty.
 *
 * Pure function — no store reads, no side effects.
 */
export function searchOperatorPilotCases(
  query: string,
  cases: OperatorCase[]
): OperatorCase[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return cases

  return cases.filter(
    (c) =>
      c.title.toLowerCase().includes(normalized) ||
      c.description.toLowerCase().includes(normalized) ||
      c.type.toLowerCase().includes(normalized) ||
      c.severity.toLowerCase().includes(normalized) ||
      c.jobId.toLowerCase().includes(normalized)
  )
}

/**
 * Filters operator priority cases by severity.
 *
 * Returns all cases when severity is null (no active filter).
 *
 * Pure function — no store reads, no side effects.
 */
export function filterOperatorPriorityCases(
  severity: OperatorPrioritySeverity | null,
  cases: OperatorPriorityCase[]
): OperatorPriorityCase[] {
  if (!severity) return cases
  return cases.filter((c) => c.severity === severity)
}

/**
 * Filters operator pilot cases by severity.
 *
 * Returns all cases when severity is null (no active filter).
 *
 * Pure function — no store reads, no side effects.
 */
export function filterOperatorPilotCases(
  severity: OperatorCaseSeverity | null,
  cases: OperatorCase[]
): OperatorCase[] {
  if (!severity) return cases
  return cases.filter((c) => c.severity === severity)
}
