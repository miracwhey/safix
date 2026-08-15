import type { MediaArtifact } from '../types'

export interface MediaRepository {
  initialize(): Promise<void>
  isHydrated(): boolean
  getAll(): MediaArtifact[]
  getByJobId(jobId: string): MediaArtifact[]
  getById(id: string): MediaArtifact | undefined
  getByDisputeId(disputeId: string): MediaArtifact[]
  add(artifact: MediaArtifact): void
  subscribe(listener: () => void): () => void
  notify(): void
}
