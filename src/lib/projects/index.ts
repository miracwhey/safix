export type {
  Project,
  ProjectPaymentState,
  ProjectStatus,
} from './projectTypes'

export {
  addProject,
  ensureProjectLoaded,
  getProjectById,
  getProjectByJobId,
  getProjects,
  isProjectRepositoryHydrated,
  retryProjectsHydration,
  subscribeProjects,
  updateProject,
} from './projectsStore'

export type {
  ProjectBuilderInput,
  ProjectBuilderReadiness,
  ProjectBuilderCompletion,
} from './projectBuilderSelectors'

export { deriveProjectBuilderReadiness } from './projectBuilderSelectors'

export {
  deriveProjectStatusFromJob,
  isProjectStatusStale,
  syncProjectFromJob,
} from './projectStatusSync'

export {
  isProjectOperational,
  isProjectCancelled,
  isProjectActive,
  isBuilderProjectPending,
} from './projectOperationalSelectors'

export type { ProjectRepository } from './repository'
export { getProjectRepository, setProjectRepository, initializeProjectRepository, SupabaseProjectRepository } from './repository'
