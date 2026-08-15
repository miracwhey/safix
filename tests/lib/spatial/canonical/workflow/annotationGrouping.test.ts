/**
 * Tests for canonical/workflow/annotationGrouping.ts
 *
 * Covers:
 * - groupAnnotationsByAuthor: groups by actorId, actionable groups first
 * - deriveAnnotationKind: heuristic kind inference from overrideFields
 * - deriveAnnotationSeverity: heuristic severity inference
 * - severityToWord: German display words
 * - filterAnnotations: 'all' | 'pending' | 'issues' filter
 */
import { describe, it, expect } from 'vitest'

import {
  groupAnnotationsByAuthor,
  deriveAnnotationKind,
  deriveAnnotationSeverity,
  severityToWord,
  filterAnnotations,
} from '../../../../../src/lib/spatial/canonical/workflow/annotationGrouping.ts'
import type {
  ActorRole,
  PinReviewState,
} from '../../../../../src/lib/spatial/canonical/workflow/annotationGrouping.ts'
import type { SpatialEditHistoryEntry } from '../../../../../src/lib/spatial/canonical/repository/SpatialSceneRepository.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

function entry(
  overrides: Partial<SpatialEditHistoryEntry> & { overrideFields: Record<string, unknown> },
): SpatialEditHistoryEntry {
  return {
    id: overrides.id ?? 'e-' + Math.random().toString(36).slice(2),
    sceneId: 'scene-1',
    providerOrgId: null,
    actorId: overrides.actorId ?? null,
    variantId: 'provider_annotations',
    baseNodeId: overrides.baseNodeId ?? 'node-1',
    overrideFields: overrides.overrideFields,
    command: overrides.command ?? 'set',
    parametricSha256Before: null,
    parametricSha256After: null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  }
}

// ── deriveAnnotationKind ─────────────────────────────────────────────────────

describe('deriveAnnotationKind', () => {
  it('returns "measurement" when measuredValue is present', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { measuredValue: '2.75' } }))).toBe(
      'measurement',
    )
  })

  it('returns "measurement" when lengthM is present', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { lengthM: '2.8' } }))).toBe('measurement')
  })

  it('returns "material" when materialId is present', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { materialId: 'mat-1' } }))).toBe(
      'material',
    )
  })

  it('returns "photo" when photoUrl is present', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { photoUrl: 'https://…' } }))).toBe(
      'photo',
    )
  })

  it('returns "issue" when issueNote is present', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { issueNote: 'Abfluss fehlt' } }))).toBe(
      'issue',
    )
  })

  it('respects explicit annotationType field', () => {
    expect(
      deriveAnnotationKind(
        entry({ overrideFields: { annotationType: 'material', materialSuggestion: 'Stein' } }),
      ),
    ).toBe('material')
  })

  it('falls back to "note" for unrecognised fields', () => {
    expect(deriveAnnotationKind(entry({ overrideFields: { custom: 'value' } }))).toBe('note')
  })
})

// ── deriveAnnotationSeverity ─────────────────────────────────────────────────

describe('deriveAnnotationSeverity', () => {
  it('reads severity field', () => {
    expect(
      deriveAnnotationSeverity(entry({ overrideFields: { severity: 'high' } })),
    ).toBe('high')
  })

  it('reads priority field as fallback', () => {
    expect(
      deriveAnnotationSeverity(entry({ overrideFields: { priority: 'critical' } })),
    ).toBe('critical')
  })

  it('returns "none" when neither is present', () => {
    expect(deriveAnnotationSeverity(entry({ overrideFields: {} }))).toBe('none')
  })

  it('prefers severity over priority when both present', () => {
    expect(
      deriveAnnotationSeverity(
        entry({ overrideFields: { severity: 'medium', priority: 'critical' } }),
      ),
    ).toBe('medium')
  })
})

// ── severityToWord ───────────────────────────────────────────────────────────

describe('severityToWord', () => {
  it.each([
    ['critical', 'Kritisch'],
    ['high', 'Hohe Priorität'],
    ['medium', 'Mittlere Priorität'],
    ['low', 'Niedrige Priorität'],
    ['none', ''],
  ] as const)('maps %s → %s', (severity, word) => {
    expect(severityToWord(severity)).toBe(word)
  })
})

// ── groupAnnotationsByAuthor ─────────────────────────────────────────────────

describe('groupAnnotationsByAuthor', () => {
  it('returns an empty array for no entries', () => {
    expect(groupAnnotationsByAuthor([])).toEqual([])
  })

  it('groups entries by actorId', () => {
    const entries = [
      entry({ actorId: 'actor-a', overrideFields: { lengthM: '2.8' } }),
      entry({ actorId: 'actor-b', overrideFields: { lengthM: '3.1' } }),
      entry({ actorId: 'actor-a', overrideFields: { issueNote: 'Riss' } }),
    ]
    const groups = groupAnnotationsByAuthor(entries)
    expect(groups).toHaveLength(2)
    const groupA = groups.find((g) => g.actorId === 'actor-a')!
    expect(groupA.pins).toHaveLength(2)
    const groupB = groups.find((g) => g.actorId === 'actor-b')!
    expect(groupB.pins).toHaveLength(1)
  })

  it('places group with more pending pins first', () => {
    const t0 = new Date('2025-01-01T10:00:00Z').toISOString()
    const entries = [
      entry({ actorId: 'actor-small', overrideFields: {}, createdAt: t0 }),
      entry({ actorId: 'actor-large', overrideFields: {}, createdAt: t0 }),
      entry({ actorId: 'actor-large', overrideFields: {}, createdAt: t0 }),
    ]
    const groups = groupAnnotationsByAuthor(entries)
    expect(groups[0].actorId).toBe('actor-large')
  })

  it('sorts entries within a group by createdAt descending', () => {
    const older = new Date('2025-01-01T08:00:00Z').toISOString()
    const newer = new Date('2025-01-01T10:00:00Z').toISOString()
    const entries = [
      entry({ actorId: 'actor-a', overrideFields: { note: 'old' }, createdAt: older }),
      entry({ actorId: 'actor-a', overrideFields: { note: 'new' }, createdAt: newer }),
    ]
    const groups = groupAnnotationsByAuthor(entries)
    expect(groups[0].pins[0].entry.overrideFields.note).toBe('new')
  })

  it('marks a worker-authored group as actionable (C-6)', () => {
    const entries = [entry({ actorId: 'actor-a', overrideFields: {} })]
    const authorInfo = new Map<string | null, { displayName: string; role: ActorRole }>([
      ['actor-a', { displayName: 'Max', role: 'worker' }],
    ])
    const groups = groupAnnotationsByAuthor(entries, { authorInfo })
    expect(groups[0].isActionable).toBe(true)
    expect(groups[0].displayName).toBe('Max')
  })

  it('does not mark a customer group as actionable (C-6)', () => {
    const entries = [entry({ actorId: 'cust-1', overrideFields: {} })]
    const authorInfo = new Map<string | null, { displayName: string; role: ActorRole }>([
      ['cust-1', { displayName: 'Kundin Berger', role: 'customer' }],
    ])
    const groups = groupAnnotationsByAuthor(entries, { authorInfo })
    expect(groups[0].isActionable).toBe(false)
  })

  it('applies persisted review states to pins (C-6)', () => {
    const entries = [
      entry({ id: 'e1', actorId: 'actor-a', baseNodeId: 'wall-1', overrideFields: {} }),
      entry({ id: 'e2', actorId: 'actor-a', baseNodeId: 'wall-2', overrideFields: {} }),
    ]
    const reviewStates = new Map<string, PinReviewState>([['wall-1', 'approved']])
    const groups = groupAnnotationsByAuthor(entries, { reviewStates })
    const byNode = new Map(groups[0].pins.map((p) => [p.entry.baseNodeId, p.reviewState]))
    expect(byNode.get('wall-1')).toBe('approved')
    expect(byNode.get('wall-2')).toBe('pending')
    expect(groups[0].reviewState.approved).toBe(1)
    expect(groups[0].reviewState.pending).toBe(1)
  })

  it('reports correct reviewState totals', () => {
    const entries = [
      entry({ actorId: 'actor-a', overrideFields: {} }),
      entry({ actorId: 'actor-a', overrideFields: {} }),
    ]
    const groups = groupAnnotationsByAuthor(entries)
    const state = groups[0].reviewState
    expect(state.total).toBe(2)
    // Phase-C seam: all pending in V1
    expect(state.pending).toBe(2)
    expect(state.approved).toBe(0)
    expect(state.rejected).toBe(0)
  })

  it('groups null actorId entries together', () => {
    const entries = [
      entry({ actorId: null, overrideFields: {} }),
      entry({ actorId: null, overrideFields: {} }),
    ]
    const groups = groupAnnotationsByAuthor(entries)
    expect(groups).toHaveLength(1)
    expect(groups[0].actorId).toBeNull()
    expect(groups[0].pins).toHaveLength(2)
  })
})

// ── filterAnnotations ────────────────────────────────────────────────────────

describe('filterAnnotations', () => {
  const entries = [
    entry({ actorId: 'a', overrideFields: { issueNote: 'problem' } }),
    entry({ actorId: 'a', overrideFields: { lengthM: '2.8' } }),
    entry({ actorId: 'b', overrideFields: { photoUrl: 'https://…' } }),
  ]

  it('all: returns everything', () => {
    expect(filterAnnotations(entries, 'all')).toHaveLength(3)
  })

  it('pending: returns everything when no review states are supplied', () => {
    expect(filterAnnotations(entries, 'pending')).toHaveLength(3)
  })

  it('pending: drops nodes that already carry a review (C-6)', () => {
    const reviewed = [
      entry({ baseNodeId: 'n1', actorId: 'a', overrideFields: {} }),
      entry({ baseNodeId: 'n2', actorId: 'a', overrideFields: {} }),
    ]
    const states = new Map<string, PinReviewState>([['n1', 'approved']])
    const result = filterAnnotations(reviewed, 'pending', states)
    expect(result).toHaveLength(1)
    expect(result[0].baseNodeId).toBe('n2')
  })

  it('issues: returns only issue-kind entries', () => {
    const result = filterAnnotations(entries, 'issues')
    expect(result).toHaveLength(1)
    expect(result[0].overrideFields.issueNote).toBe('problem')
  })
})
