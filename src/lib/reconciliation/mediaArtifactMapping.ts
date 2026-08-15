/**
 * Mapping helpers between the existing `MediaArtifact` (in-memory + Supabase
 * `media_uploads` row) and the `ReconciliationMediaRow` contract consumed by
 * the reconciliation selector.
 *
 * Why a mapping layer: `MediaArtifact` is shared across many domains and uses
 * `kind` / `uploadedBy` / `mimeType`. The reconciliation selector intentionally
 * speaks a smaller, surface-oriented vocabulary (`mediaRole`, `ownerUserId`,
 * `mediaType`) so the same selector is testable from in-memory builders
 * without depending on the broader media domain.
 */

import type { MediaArtifact } from '../media/types'
import type { ReconciliationMediaRow } from './types'

function classifyMediaType(mime: string): ReconciliationMediaRow['mediaType'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'image' // videos render in the same evidence tile
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'document'
  if (mime.startsWith('text/') || mime.startsWith('application/')) return 'document'
  return 'other'
}

function deriveMediaRole(kind: MediaArtifact['kind']): string {
  if (kind === 'dispute_evidence') return 'evidence'
  return kind
}

export function mapMediaArtifactToReconciliationRow(
  artifact: MediaArtifact,
): ReconciliationMediaRow {
  return {
    id: artifact.id,
    ownerUserId: artifact.uploadedBy,
    mediaRole: deriveMediaRole(artifact.kind),
    mediaType: classifyMediaType(artifact.mimeType),
    fileName: artifact.filename,
    sizeBytes: null,
    createdAt: new Date(artifact.uploadedAt).toISOString(),
    // sharedWithCounterparty stays undefined until N13.OPS adds the operator
    // share workflow; selectors treat undefined as `false`.
  }
}

export function mapMediaArtifactsToReconciliationRows(
  artifacts: ReadonlyArray<MediaArtifact>,
): ReconciliationMediaRow[] {
  return artifacts.map(mapMediaArtifactToReconciliationRow)
}
