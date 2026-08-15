import { describe, it, expect } from 'vitest'
import {
  buildDisputeExportPayload,
  disputeExportFilename,
  serialiseDisputeExport,
} from '../../src/lib/reconciliation/export/exportDispute'
import {
  buildAllDisputesExportPayload,
  allDisputesExportFilename,
  serialiseAllDisputesExport,
} from '../../src/lib/reconciliation/export/exportAllDisputes'
import type {
  ReconciliationListBuckets,
  ReconciliationView,
} from '../../src/lib/reconciliation/types'

const FIXED_NOW_MS = Date.parse('2026-04-30T10:00:00.000Z')

function buildView(overrides: Partial<ReconciliationView> = {}): ReconciliationView {
  return {
    disputeId: 'd-1',
    aktenzeichen: 'R-2042/04-2026',
    jobId: 'job-1',
    role: 'craftsman',
    status: 'customer_waiting',
    statusLabel: 'Warte auf Kundenbeleg',
    nextStepLabel: 'SaFix prüft den Fall.',
    snapshot: null,
    snapshotMissing: true,
    timeline: [],
    ownEvidence: [],
    sharedCounterpartyEvidence: [],
    stripeTimeline: [],
    deadline: null,
    decision: null,
    availableActions: ['view_only'],
    dispute: {
      id: 'd-1',
      jobId: 'job-1',
      status: 'customer_waiting',
      reason: 'work_quality',
      title: 'Bad sanieren',
      description: 'Fliesenarbeit unvollständig',
      createdAt: '2026-04-18T14:32:00.000Z',
      updatedAt: '2026-04-26T10:00:00.000Z',
    },
    ...overrides,
  }
}

describe('buildDisputeExportPayload', () => {
  it('produces a stable schema-tagged payload from a view', () => {
    const payload = buildDisputeExportPayload(buildView(), FIXED_NOW_MS)
    expect(payload.schema).toBe('fixup.reconciliation.dispute_export')
    expect(payload.schemaVersion).toBe('1.0')
    expect(payload.exportedAt).toBe('2026-04-30T10:00:00.000Z')
    expect(payload.case.aktenzeichen).toBe('R-2042/04-2026')
    expect(payload.case.role).toBe('craftsman')
    expect(payload.case.snapshotMissing).toBe(true)
  })

  it('emits the same JSON string for the same input', () => {
    const a = serialiseDisputeExport(buildDisputeExportPayload(buildView(), FIXED_NOW_MS))
    const b = serialiseDisputeExport(buildDisputeExportPayload(buildView(), FIXED_NOW_MS))
    expect(a).toBe(b)
  })

  it('does not include any property not part of the case contract', () => {
    const payload = buildDisputeExportPayload(buildView(), FIXED_NOW_MS)
    const allowed = new Set([
      'aktenzeichen',
      'disputeId',
      'jobId',
      'role',
      'status',
      'statusLabel',
      'nextStep',
      'snapshot',
      'snapshotMissing',
      'timeline',
      'ownEvidence',
      'sharedCounterpartyEvidence',
      'stripeTimeline',
      'deadline',
      'decision',
    ])
    for (const key of Object.keys(payload.case)) {
      expect(allowed.has(key)).toBe(true)
    }
  })

  it('only carries shared counterparty evidence — selector already filters the rest', () => {
    const payload = buildDisputeExportPayload(
      buildView({
        sharedCounterpartyEvidence: [
          {
            id: 'shared-ev',
            kind: 'image',
            name: 'shared.jpg',
            uploadedAt: '2026-04-18T14:32:00.000Z',
            sizeBytes: null,
            ownedByViewer: false,
            mediaId: 'shared-ev',
          },
        ],
      }),
      FIXED_NOW_MS,
    )
    expect(payload.case.sharedCounterpartyEvidence).toHaveLength(1)
    expect(payload.case.ownEvidence).toEqual([])
  })

  it('builds a slash-safe filename from the Aktenzeichen', () => {
    const payload = buildDisputeExportPayload(buildView(), FIXED_NOW_MS)
    expect(disputeExportFilename(payload)).toBe('safix-streitfall-R-2042_04-2026.json')
  })
})

describe('buildAllDisputesExportPayload', () => {
  function buildBuckets(): ReconciliationListBuckets {
    return {
      active: [
        {
          disputeId: 'd-1',
          aktenzeichen: 'R-2042/04-2026',
          jobId: 'job-1',
          jobTitle: 'Bad sanieren',
          status: 'customer_waiting',
          statusLabel: 'Warte auf Kundenbeleg',
          summary: 'Fliesenarbeit unvollständig',
          amountEur: 2_140,
          updatedAt: '2026-04-26T10:00:00.000Z',
          createdAt: '2026-04-18T14:32:00.000Z',
          resolvedAt: null,
          deadline: null,
          requiresAction: false,
          urgencyLevel: 'critical',
          decisionSummary: null,
          refundedAmountEur: null,
        },
      ],
      resolved: [],
      counts: { active: 1, awaitingViewer: 0, resolved: 0 },
    }
  }

  it('schema-tags the bundle and includes counts plus per-case summaries', () => {
    const payload = buildAllDisputesExportPayload({
      buckets: buildBuckets(),
      viewerUserId: 'user-1',
      role: 'craftsman',
      nowMs: FIXED_NOW_MS,
    })
    expect(payload.schema).toBe('fixup.reconciliation.all_disputes_export')
    expect(payload.schemaVersion).toBe('1.0')
    expect(payload.exportedAt).toBe('2026-04-30T10:00:00.000Z')
    expect(payload.viewer).toEqual({ userId: 'user-1', role: 'craftsman' })
    expect(payload.counts.active).toBe(1)
    expect(payload.active).toHaveLength(1)
    expect(payload.resolved).toHaveLength(0)
  })

  it('uses an ISO date in the bundle filename', () => {
    const payload = buildAllDisputesExportPayload({
      buckets: buildBuckets(),
      viewerUserId: 'user-1',
      role: 'craftsman',
      nowMs: FIXED_NOW_MS,
    })
    expect(allDisputesExportFilename(payload)).toBe('safix-streitfaelle-2026-04-30.json')
  })

  it('serialises deterministically', () => {
    const payload = buildAllDisputesExportPayload({
      buckets: buildBuckets(),
      viewerUserId: 'user-1',
      role: 'craftsman',
      nowMs: FIXED_NOW_MS,
    })
    expect(serialiseAllDisputesExport(payload)).toBe(serialiseAllDisputesExport(payload))
  })
})
