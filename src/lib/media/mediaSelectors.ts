import type { MediaArtifact, MediaArtifactKind } from './types'

export type MediaArtifactViewModel = {
  id: string
  jobId: string
  kind: MediaArtifactKind
  kindLabel: string
  label: string
  filename: string
  mimeType: string
  uploadedAtLabel: string
  uploadedBy: string
  notes?: string
  disputeId?: string
  timelineEventId?: string
  isPhoto: boolean
  isDocument: boolean
  isDisputeEvidence: boolean
}

export function getArtifactKindLabel(kind: MediaArtifactKind): string {
  if (kind === 'job_photo') return 'Job-Foto'
  if (kind === 'work_progress_photo') return 'Fortschrittsfoto'
  if (kind === 'completion_photo') return 'Abschlussfoto'
  if (kind === 'document_attachment') return 'Dokument'
  return 'Beweismittel'
}

function formatDateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function mapArtifactToViewModel(artifact: MediaArtifact): MediaArtifactViewModel {
  const isPhoto =
    artifact.kind === 'job_photo' ||
    artifact.kind === 'work_progress_photo' ||
    artifact.kind === 'completion_photo'

  return {
    id: artifact.id,
    jobId: artifact.jobId,
    kind: artifact.kind,
    kindLabel: getArtifactKindLabel(artifact.kind),
    label: artifact.label,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    uploadedAtLabel: formatDateLabel(artifact.uploadedAt),
    uploadedBy: artifact.uploadedBy,
    notes: artifact.notes,
    disputeId: artifact.disputeId,
    timelineEventId: artifact.timelineEventId,
    isPhoto,
    isDocument: artifact.kind === 'document_attachment',
    isDisputeEvidence: artifact.kind === 'dispute_evidence',
  }
}

export function getArtifactViewModels(artifacts: MediaArtifact[]): MediaArtifactViewModel[] {
  return artifacts.map(mapArtifactToViewModel)
}

export function getPhotoArtifacts(artifacts: MediaArtifact[]): MediaArtifact[] {
  return artifacts.filter(
    (a) =>
      a.kind === 'job_photo' ||
      a.kind === 'work_progress_photo' ||
      a.kind === 'completion_photo'
  )
}

export function getDisputeEvidenceArtifacts(artifacts: MediaArtifact[]): MediaArtifact[] {
  return artifacts.filter((a) => a.kind === 'dispute_evidence')
}

export function getDocumentArtifacts(artifacts: MediaArtifact[]): MediaArtifact[] {
  return artifacts.filter((a) => a.kind === 'document_attachment')
}

/**
 * Formats a photo count as a German-language string with correct pluralization.
 * e.g. 1 → "1 Foto", 3 → "3 Fotos"
 */
export function formatPhotoCount(count: number): string {
  return `${count} ${count === 1 ? 'Foto' : 'Fotos'}`
}
