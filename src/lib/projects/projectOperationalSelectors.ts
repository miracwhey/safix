/**
 * Project Operational Selectors
 *
 * Determines whether a project has reached operational (active/running) state.
 *
 * Key rule: a real attached customer project must NOT automatically count as
 * an active/running project.  Operational state begins only when the project
 * has been linked to a job (sourceJobId is set) AND its status has advanced
 * beyond the initial 'request' stage.
 *
 * Transition point:
 *   attached project → offer accepted → job created/linked → status becomes
 *   'accepted' or beyond → NOW the project is operational.
 */

import type { Project } from './projectTypes'

/**
 * Statuses that indicate operational / payment-ready work is in progress.
 * Does NOT include 'request' (pre-offer inquiry stage) or 'cancelled'.
 */
const OPERATIONAL_STATUSES = new Set([
  'accepted',
  'scheduled',
  'in_progress',
  'review',
])

/**
 * Returns true when the project has reached operational state.
 *
 * A project is operational when:
 *   1. It is linked to a job (sourceJobId is set)
 *   2. Its status has advanced past 'request' into the operational range
 *
 * This excludes:
 *   - Builder projects that have not been linked to a job yet
 *   - Attached projects still in 'request' stage (inquiry sent but no offer accepted)
 *   - Cancelled projects
 *   - Completed projects (work is done)
 */
export function isProjectOperational(project: Project): boolean {
  if (!project.sourceJobId) return false
  return OPERATIONAL_STATUSES.has(project.status)
}

/**
 * Returns true when the project has been cancelled.
 */
export function isProjectCancelled(project: Project): boolean {
  return project.status === 'cancelled'
}

/**
 * Returns true when the project should appear on active surfaces
 * (home screen, project list active count, search picker).
 *
 * Active = any non-terminal status. Excludes completed and cancelled only.
 * Builder projects in 'request' without a sourceJobId are active —
 * operational status (isProjectOperational) is the stricter gate.
 */
export function isProjectActive(project: Project): boolean {
  return project.status !== 'completed' && project.status !== 'cancelled'
}

/**
 * Returns true for builder-origin projects that exist but have not yet been
 * linked to a job (sourceJobId is empty).  These are shown on the Home Screen
 * in a dedicated "In Planung" section rather than the active-project surfaces.
 */
export function isBuilderProjectPending(project: Project): boolean {
  if (project.status === 'completed' || project.status === 'cancelled') return false
  if (project.sourceJobId) return false
  return project.source === 'builder'
}
