import { getMediaRepository } from './repository'
import type { MediaArtifact } from './types'

type Listener = () => void

export function subscribeMedia(listener: Listener): () => void {
  return getMediaRepository().subscribe(listener)
}

export function getArtifacts(): MediaArtifact[] {
  return getMediaRepository().getAll()
}

export function getArtifactsByJobId(jobId: string): MediaArtifact[] {
  return getMediaRepository().getByJobId(jobId)
}

export function getArtifactById(id: string): MediaArtifact | undefined {
  return getMediaRepository().getById(id)
}

export function getArtifactsByDisputeId(disputeId: string): MediaArtifact[] {
  return getMediaRepository().getByDisputeId(disputeId)
}

export function isMediaHydrated(): boolean {
  return getMediaRepository().isHydrated()
}
