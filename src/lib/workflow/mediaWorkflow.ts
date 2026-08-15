import {
  createArtifact,
  addArtifact,
  getArtifactsByJobId,
  type MediaArtifact,
  type MediaArtifactInput,
} from '../media'
import { addTimelineEvent, createTimelineEvent } from '../timeline'

export function attachArtifactWorkflow(input: MediaArtifactInput): MediaArtifact {
  const artifact = createArtifact(input)

  const timelineEvent = createTimelineEvent({
    jobId: input.jobId,
    type: 'artifact_attached',
  })

  addTimelineEvent(timelineEvent)

  const artifactWithRef: MediaArtifact = {
    ...artifact,
    timelineEventId: timelineEvent.id,
  }

  addArtifact(artifactWithRef)

  return artifactWithRef
}

export function attachDisputeEvidenceWorkflow(params: {
  jobId: string
  disputeId: string
  label: string
  filename: string
  mimeType: string
  uploadedBy: string
  notes?: string
}): MediaArtifact {
  const input: MediaArtifactInput = {
    jobId: params.jobId,
    kind: 'dispute_evidence',
    label: params.label,
    filename: params.filename,
    mimeType: params.mimeType,
    uploadedBy: params.uploadedBy,
    notes: params.notes,
    disputeId: params.disputeId,
  }

  const artifact = createArtifact(input)

  const timelineEvent = createTimelineEvent({
    jobId: params.jobId,
    type: 'dispute_evidence_attached',
  })

  addTimelineEvent(timelineEvent)

  const artifactWithRef: MediaArtifact = {
    ...artifact,
    timelineEventId: timelineEvent.id,
  }

  addArtifact(artifactWithRef)

  return artifactWithRef
}

export function getJobArtifacts(jobId: string): MediaArtifact[] {
  return getArtifactsByJobId(jobId)
}

export function attachProgressPhotoWorkflow(
  jobId: string,
  uploadedBy = 'craftsman'
): MediaArtifact {
  return attachArtifactWorkflow({
    jobId,
    kind: 'work_progress_photo',
    label: 'Fortschrittsfoto',
    filename: `fortschritt-${Date.now()}.jpg`,
    mimeType: 'image/jpeg',
    uploadedBy,
  })
}

export function attachCompletionPhotoWorkflow(
  jobId: string,
  uploadedBy = 'craftsman'
): MediaArtifact {
  return attachArtifactWorkflow({
    jobId,
    kind: 'completion_photo',
    label: 'Abschlussfoto',
    filename: `abschluss-${Date.now()}.jpg`,
    mimeType: 'image/jpeg',
    uploadedBy,
  })
}
