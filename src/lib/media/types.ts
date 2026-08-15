import type { EntityId, TimestampMs } from '../shared/coreTypes'

export type MediaArtifactKind =
  | 'job_photo'
  | 'work_progress_photo'
  | 'completion_photo'
  | 'document_attachment'
  | 'dispute_evidence'

export type MediaArtifact = {
  id: EntityId
  jobId: EntityId
  kind: MediaArtifactKind
  label: string
  filename: string
  mimeType: string
  uploadedAt: TimestampMs
  uploadedBy: string
  notes?: string
  disputeId?: EntityId
  timelineEventId?: EntityId
}

export type MediaArtifactInput = {
  jobId: EntityId
  kind: MediaArtifactKind
  label: string
  filename: string
  mimeType: string
  uploadedBy: string
  notes?: string
  disputeId?: EntityId
}
