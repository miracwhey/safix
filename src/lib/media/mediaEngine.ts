import type { MediaArtifact, MediaArtifactInput } from './types'

export function createArtifact(input: MediaArtifactInput): MediaArtifact {
  const now = Date.now()

  return {
    id: `artifact-${input.jobId}-${input.kind}-${now}-${Math.random()
      .toString(36)
      .slice(2, 6)}`,
    jobId: input.jobId,
    kind: input.kind,
    label: input.label,
    filename: input.filename,
    mimeType: input.mimeType,
    uploadedAt: now,
    uploadedBy: input.uploadedBy,
    notes: input.notes,
    disputeId: input.disputeId,
  }
}
