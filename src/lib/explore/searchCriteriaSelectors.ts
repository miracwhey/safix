import type { ProjectCase } from '../../domain/projects/projectCaseTypes'
import type { ExploreReel } from './exploreTypes'

export type SearchCriteria = {
  category: string
  description: string
  location: string
  budget?: string
  timing?: string
}

export type ManualSearchInput = {
  category: string
  description: string
  location: string
  budget?: string
  timing?: string
}

/**
 * Derives normalized SearchCriteria from a structured ProjectCase.
 * Returns null when the project lacks the minimum required fields.
 */
export function deriveSearchCriteriaFromProject(
  project: ProjectCase
): SearchCriteria | null {
  const category = (project.category ?? '').trim()
  const description = (project.description ?? '').trim()
  const location = (project.location ?? '').trim()

  if (!category || !description || !location) return null

  return {
    category,
    description,
    location,
    budget: project.requestedBudget,
    timing: project.requestedTiming,
  }
}

/**
 * Derives normalized SearchCriteria from manual guided input.
 * Returns null when required fields are missing.
 */
export function deriveSearchCriteriaFromManualInput(
  input: Partial<ManualSearchInput>
): SearchCriteria | null {
  const category = (input.category ?? '').trim()
  const description = (input.description ?? '').trim()
  const location = (input.location ?? '').trim()

  if (!category || !description || !location) return null

  return {
    category,
    description,
    location,
    budget: input.budget,
    timing: input.timing,
  }
}

/**
 * Derives normalized SearchCriteria from an ExploreReel.
 * Returns null when the reel lacks the minimum required fields (category and location).
 *
 * MVP mapping:
 * - category    ← reel.category
 * - description ← reel.title
 * - location    ← reel.location
 * - budget      ← reel.costLabel
 * - timing      ← reel.durationLabel
 */
export function deriveSearchCriteriaFromReel(
  reel: ExploreReel
): SearchCriteria | null {
  const category = (reel.category ?? '').trim()
  const location = (reel.location ?? '').trim()

  if (!category || !location) return null

  return {
    category,
    description: reel.title.trim(),
    location,
    ...(reel.costLabel && { budget: reel.costLabel }),
    ...(reel.durationLabel && { timing: reel.durationLabel }),
  }
}
