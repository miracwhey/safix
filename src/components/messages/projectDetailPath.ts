import type { MessageRole } from '../../lib/messages'
import type { ProjectArtifact } from '../../lib/messages/threadArtifactTypes'

/**
 * Returns the navigation path for a project artifact based on the viewer role.
 *
 * Customer → /projects/:projectId
 * Craftsman → /craftsman/jobs/:sourceJobId (when job exists)
 * Craftsman → /craftsman/request/:projectId (pre-job request detail)
 */
export function getProjectDetailPath(
  artifact: ProjectArtifact,
  role: MessageRole
): string | undefined {
  const projectId = artifact.project?.id ?? artifact.snapshot?.projectId
  if (role === 'customer' && projectId) return `/projects/${projectId}`

  if (role === 'craftsman') {
    const sourceJobId = artifact.project?.sourceJobId
    if (sourceJobId) return `/craftsman/jobs/${sourceJobId}`
    // Pre-job: route to request detail view so craftsman can inspect before offering
    if (projectId) return `/craftsman/request/${projectId}`
  }

  return undefined
}
