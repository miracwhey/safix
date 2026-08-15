import type { Project } from '../projects/projectTypes'

/**
 * A concise read-model derived from the customer's project list.
 * Consumed by profile UI to show the customer their current operational
 * position without requiring them to open the full projects screen.
 */
export type CustomerProjectSummary = {
  /** Total number of projects the customer has. */
  total: number
  /** Projects that are not yet completed. */
  active: number
  /**
   * Projects that have a payment or dispute state requiring customer action:
   * – release_pending  → customer must release payment
   * – disputed         → dispute is active
   * – deposit_required → deposit payment is outstanding
   */
  requiresAttention: number
  /** True when there is at least one non-completed project. */
  hasActiveProjects: boolean
  /** The most recently updated active project, or null when none exist. */
  mostRecentActiveProject: Project | null
}

/**
 * Derives a `CustomerProjectSummary` from a snapshot of the projects store.
 *
 * Pure function — performs no state mutations.
 */
export function deriveCustomerProjectSummary(
  projects: Project[]
): CustomerProjectSummary {
  const active = projects.filter((p) => p.status !== 'completed' && p.status !== 'cancelled')

  const requiresAttention = active.filter(
    (p) =>
      p.paymentState === 'release_pending' ||
      p.paymentState === 'disputed' ||
      p.paymentState === 'deposit_required'
  )

  const mostRecentActiveProject =
    active.length > 0
      ? active.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
      : null

  return {
    total: projects.length,
    active: active.length,
    requiresAttention: requiresAttention.length,
    hasActiveProjects: active.length > 0,
    mostRecentActiveProject,
  }
}
