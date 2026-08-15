/**
 * Selectors and types for the guided project-builder flow.
 *
 * The builder collects structured input from the customer and derives a
 * readiness view-model that drives the builder UI (step completion, CTA
 * enablement, completeness indicator).
 *
 * Pure functions — no state mutations.
 */

// ── Input model ───────────────────────────────────────────────────────────────

/**
 * Structured input collected by the project-builder steps.
 * All fields that drive a required check are mandatory; budget and timing are
 * optional enrichment fields. The `title` field is optional — when absent the
 * workflow derives a title from category and location.
 */
export type ProjectBuilderInput = {
  /** Trade category, e.g. "Elektrik", "Bad", "Sanitär". */
  category: string
  /**
   * Optional human-readable title. When omitted, the workflow auto-generates
   * one from the category and location fields.
   */
  title?: string
  /** Free-text description of the required work. */
  description: string
  /** City or district where the work is needed. */
  location: string
  /** Optional budget expectation, e.g. "unter 2.000 €". */
  requestedBudget?: string
  /** Optional timing preference, e.g. "Innerhalb 4 Wochen". */
  requestedTiming?: string
  /** Trade-specific structured answers from the guided builder flow. */
  tradeSpecificAnswers?: Array<{ key: string; label: string; value: string }>
}

// ── Readiness model ───────────────────────────────────────────────────────────

export type ProjectBuilderCompletion = 'minimal' | 'good' | 'excellent'

export type ProjectBuilderReadiness = {
  /**
   * True when all required fields (category, description, location) are filled.
   * The primary CTA to create the project is only enabled when this is true.
   */
  isReady: boolean
  /**
   * 0–100 score weighted across required (70 %) and optional (30 %) fields.
   * Drives the completeness progress bar in the summary step.
   */
  completionScore: number
  /** Human-readable label derived from the completion score. */
  completionLevel: ProjectBuilderCompletion
  /** Labels for required fields that are still missing. */
  missingRequired: string[]
  /** Labels for optional fields that are still missing. */
  missingOptional: string[]
}

// ── Selector ──────────────────────────────────────────────────────────────────

/**
 * Derives a `ProjectBuilderReadiness` from a partial builder input snapshot.
 *
 * Accepts a partial so it can be called at any step of the builder flow before
 * all fields are populated.
 */
export function deriveProjectBuilderReadiness(
  input: Partial<ProjectBuilderInput>
): ProjectBuilderReadiness {
  const missingRequired: string[] = []
  const missingOptional: string[] = []

  if (!input.category?.trim()) missingRequired.push('Kategorie')
  if (!input.description?.trim()) missingRequired.push('Beschreibung')
  if (!input.location?.trim()) missingRequired.push('Ort')

  if (!input.requestedBudget?.trim()) missingOptional.push('Budget')
  if (!input.requestedTiming?.trim()) missingOptional.push('Zeitraum')

  const isReady = missingRequired.length === 0

  // 70 % weight for the 3 required fields, 30 % for 2 optional fields
  const requiredScore = ((3 - missingRequired.length) / 3) * 70
  const optionalScore = ((2 - missingOptional.length) / 2) * 30
  const completionScore = Math.round(requiredScore + optionalScore)

  const completionLevel: ProjectBuilderCompletion =
    completionScore >= 90 ? 'excellent' : completionScore >= 55 ? 'good' : 'minimal'

  return {
    isReady,
    completionScore,
    completionLevel,
    missingRequired,
    missingOptional,
  }
}
