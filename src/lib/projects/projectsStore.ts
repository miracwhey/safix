import { getProjectRepository, initializeProjectRepository } from './repository'
import type { Project } from './projectTypes'

export function subscribeProjects(listener: () => void): () => void {
  return getProjectRepository().subscribe(listener)
}

/**
 * Returns `true` once the project repository has completed its initial data
 * load.  Used by screens to distinguish "not loaded yet" from "genuinely
 * does not exist" without resorting to a timeout.
 */
export function isProjectRepositoryHydrated(): boolean {
  return getProjectRepository().isHydrated()
}

export function getProjects(): Project[] {
  return getProjectRepository().getAll()
}

export function getProjectById(id: string): Project | undefined {
  return getProjectRepository().getById(id)
}

/**
 * Best-effort lazy load of a project that is not in the owner-scoped cache
 * (e.g. a project shared into a chat thread the current user did not create).
 * RLS decides visibility; on success listeners fire and getProjectById resolves.
 */
export function ensureProjectLoaded(id: string): Promise<void> {
  return getProjectRepository().ensureLoaded(id)
}

export function getProjectByJobId(jobId: string): Project | undefined {
  return getProjectRepository().getByJobId(jobId)
}

export function addProject(project: Project): Promise<void> {
  return getProjectRepository().add(project)
}

export function updateProject(projectId: string, updates: Partial<Project>): Promise<Project | undefined> {
  return getProjectRepository().update(projectId, updates)
}

export function retryProjectsHydration(): void {
  // Rejection surfaces via the 15s watchdog in consuming screens; swallow here
  // to prevent an unhandled rejection when Supabase is unreachable.
  initializeProjectRepository(true).catch(() => undefined)
}
