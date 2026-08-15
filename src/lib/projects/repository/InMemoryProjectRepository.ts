import { projectsMock } from '../mockData'
import type { Project } from '../projectTypes'
import type { ProjectRepository } from './ProjectRepository'

type Listener = () => void

export class InMemoryProjectRepository implements ProjectRepository {
  private projects: Project[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Project[] = [...projectsMock]) {
    this.projects = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  getAll(): Project[] {
    return [...this.projects]
  }

  getById(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  // In-memory store has no remote source — everything readable is already
  // loaded, so lazy-by-id is a no-op.
  async ensureLoaded(_id: string): Promise<void> {
    void _id
  }

  getByJobId(jobId: string): Project | undefined {
    return this.projects.find((p) => p.sourceJobId === jobId)
  }

  async add(project: Project): Promise<void> {
    this.projects = [...this.projects, project]
    this.notify()
  }

  async update(projectId: string, updates: Partial<Project>): Promise<Project | undefined> {
    let updatedProject: Project | undefined

    this.projects = this.projects.map((project) => {
      if (project.id !== projectId) return project

      updatedProject = {
        ...project,
        ...updates,
        updatedAt: Date.now(),
      }

      return updatedProject
    })

    if (updatedProject) {
      this.notify()
    }

    return updatedProject
  }

  reset(): void {
    this.projects = [...projectsMock]
    this.notify()
  }
}
