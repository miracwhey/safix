import { getMediaRepository } from './repository'
import type { MediaArtifact } from './types'

export function addArtifact(artifact: MediaArtifact): void {
  getMediaRepository().add(artifact)
}
