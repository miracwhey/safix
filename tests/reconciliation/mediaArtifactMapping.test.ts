import { describe, it, expect } from 'vitest'
import {
  mapMediaArtifactToReconciliationRow,
  mapMediaArtifactsToReconciliationRows,
} from '../../src/lib/reconciliation/mediaArtifactMapping'
import type { MediaArtifact } from '../../src/lib/media/types'

function buildArtifact(overrides: Partial<MediaArtifact> = {}): MediaArtifact {
  return {
    id: 'artifact-1',
    jobId: 'job-1',
    kind: 'dispute_evidence',
    label: 'Foto',
    filename: 'foto.jpg',
    mimeType: 'image/jpeg',
    uploadedAt: Date.parse('2026-04-18T15:00:00.000Z'),
    uploadedBy: 'user-customer',
    ...overrides,
  }
}

describe('mapMediaArtifactToReconciliationRow', () => {
  it('translates an image dispute_evidence artifact to a reconciliation row', () => {
    const row = mapMediaArtifactToReconciliationRow(buildArtifact())
    expect(row.id).toBe('artifact-1')
    expect(row.ownerUserId).toBe('user-customer')
    expect(row.mediaRole).toBe('evidence')
    expect(row.mediaType).toBe('image')
    expect(row.fileName).toBe('foto.jpg')
    expect(row.sizeBytes).toBeNull()
    expect(row.createdAt).toBe('2026-04-18T15:00:00.000Z')
  })

  it('classifies a PDF mime as a document', () => {
    const row = mapMediaArtifactToReconciliationRow(
      buildArtifact({ mimeType: 'application/pdf', filename: 'beleg.pdf' }),
    )
    expect(row.mediaType).toBe('document')
  })

  it('classifies an audio mime as audio', () => {
    const row = mapMediaArtifactToReconciliationRow(
      buildArtifact({ mimeType: 'audio/m4a', filename: 'sprachnotiz.m4a' }),
    )
    expect(row.mediaType).toBe('audio')
  })

  it('classifies a text mime as document', () => {
    const row = mapMediaArtifactToReconciliationRow(
      buildArtifact({ mimeType: 'text/plain', filename: 'auszug.txt' }),
    )
    expect(row.mediaType).toBe('document')
  })

  it('keeps non-evidence kinds as their raw value', () => {
    const row = mapMediaArtifactToReconciliationRow(
      buildArtifact({ kind: 'completion_photo', filename: 'fertig.jpg' }),
    )
    expect(row.mediaRole).toBe('completion_photo')
  })

  it('does not flag the artifact as shared with counterparty', () => {
    const row = mapMediaArtifactToReconciliationRow(buildArtifact())
    expect(row.sharedWithCounterparty).toBeUndefined()
  })

  it('preserves order when mapping a list', () => {
    const inputs = [
      buildArtifact({ id: 'a' }),
      buildArtifact({ id: 'b' }),
      buildArtifact({ id: 'c' }),
    ]
    const rows = mapMediaArtifactsToReconciliationRows(inputs)
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })
})
