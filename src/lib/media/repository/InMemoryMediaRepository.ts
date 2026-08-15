import type { MediaArtifact } from '../types'
import type { MediaRepository } from './MediaRepository'

type Listener = () => void

export class InMemoryMediaRepository implements MediaRepository {
  private artifacts: MediaArtifact[] = []
  private readonly listeners = new Set<Listener>()

  async initialize(): Promise<void> {
    // In-memory data is already loaded at construction time
  }

  isHydrated(): boolean {
    return true
  }

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): MediaArtifact[] {
    return [...this.artifacts]
  }

  getByJobId(jobId: string): MediaArtifact[] {
    return this.artifacts
      .filter((a) => a.jobId === jobId)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
  }

  getById(id: string): MediaArtifact | undefined {
    return this.artifacts.find((a) => a.id === id)
  }

  getByDisputeId(disputeId: string): MediaArtifact[] {
    return this.artifacts
      .filter((a) => a.disputeId === disputeId)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
  }

  add(artifact: MediaArtifact): void {
    const alreadyExists = this.artifacts.some((a) => a.id === artifact.id)
    if (alreadyExists) {
      throw new Error(
        `Duplicate media artifact ID: ${artifact.id}. This simulates the PostgreSQL unique constraint violation that would occur in production (duplicate key value violates unique constraint "media_uploads_pkey").`
      )
    }

    this.artifacts = [...this.artifacts, artifact].sort(
      (a, b) => b.uploadedAt - a.uploadedAt,
    )
    this.notify()
  }
}
