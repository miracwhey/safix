import { describe, it, expect } from 'vitest'
import {
  selectReconciliationList,
  selectReconciliationView,
} from '../../src/lib/reconciliation/reconciliationSelectors'
import type {
  ReconciliationHistoryRow,
  ReconciliationMediaRow,
  ReconciliationStripeRow,
} from '../../src/lib/reconciliation/types'
import type { Dispute, DisputeStatus } from '../../src/lib/disputes/types'

const FIXED_NOW_MS = Date.parse('2026-04-26T10:00:00.000Z')

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
    jobId: 'job-1',
    status: 'customer_waiting' as DisputeStatus,
    reason: 'work_quality',
    title: 'Bad sanieren',
    description: 'Fliesenarbeit unvollständig',
    createdAt: '2026-04-18T14:32:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  } as Dispute
}

function buildHistoryRow(
  overrides: Partial<ReconciliationHistoryRow> = {},
): ReconciliationHistoryRow {
  return {
    id: 'history-1',
    disputeId: '7c1f5d8a-3b22-4a8e-9f10-aa9f3c1d4e22',
    previousStatus: null,
    nextStatus: 'open',
    source: 'system',
    actorUserId: null,
    note: null,
    createdAt: '2026-04-18T14:32:00.000Z',
    ...overrides,
  }
}

function buildMediaRow(
  overrides: Partial<ReconciliationMediaRow> = {},
): ReconciliationMediaRow {
  return {
    id: 'media-1',
    ownerUserId: 'user-customer',
    mediaRole: 'evidence',
    mediaType: 'image',
    fileName: 'foto.jpg',
    sizeBytes: 2_400_000,
    createdAt: '2026-04-18T15:00:00.000Z',
    ...overrides,
  }
}

function buildStripeRow(
  overrides: Partial<ReconciliationStripeRow> = {},
): ReconciliationStripeRow {
  return {
    eventId: 'evt_1',
    eventType: 'payment_intent.succeeded',
    paymentIntentId: 'pi_1',
    outcome: 'reconciled',
    amountEur: 2_140,
    processedAt: '2026-04-02T09:30:00.000Z',
    ...overrides,
  }
}

describe('selectReconciliationView', () => {
  it('builds an Aktenzeichen and a populated view for a waiting customer', () => {
    const dispute = buildDispute({ status: 'customer_waiting' })
    const history = [
      buildHistoryRow({
        id: 'h1',
        nextStatus: 'open',
        source: 'client',
        actorUserId: 'user-customer',
        note: 'Übergang zur Dusche fehlt komplett',
        createdAt: '2026-04-18T14:32:00.000Z',
      }),
      buildHistoryRow({
        id: 'h2',
        previousStatus: 'open',
        nextStatus: 'under_review',
        source: 'admin',
        note: 'In Prüfung — wir bitten Anbieter um Stellungnahme',
        createdAt: '2026-04-19T09:15:00.000Z',
      }),
      buildHistoryRow({
        id: 'h3',
        previousStatus: 'under_review',
        nextStatus: 'customer_waiting',
        source: 'admin',
        note: null,
        createdAt: '2026-04-26T10:00:00.000Z',
      }),
    ]

    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history,
      media: [buildMediaRow()],
      stripeEvents: [buildStripeRow()],
      viewer: { userId: 'user-customer' },
      counterparty: { displayName: 'Mustermann GmbH' },
      nowMs: FIXED_NOW_MS,
      statementDeadlineAt: '2026-04-28T17:00:00.000Z',
    })

    expect(view).not.toBeNull()
    expect(view!.aktenzeichen).toMatch(/^R-\d{4}\/04-2026$/)
    expect(view!.role).toBe('customer')
    expect(view!.status).toBe('customer_waiting')
    expect(view!.timeline).toHaveLength(3)
    expect(view!.timeline[0].source).toBe('you')
    expect(view!.timeline[0].quote).toContain('Dusche fehlt')
    expect(view!.ownEvidence).toHaveLength(1)
    expect(view!.sharedCounterpartyEvidence).toHaveLength(0)
    expect(view!.deadline?.urgency).toBe('soon')
    expect(view!.availableActions).toContain('submit_statement')
    expect(view!.availableActions).toContain('upload_evidence')
  })

  it('suppresses counterparty client events from the timeline', () => {
    const dispute = buildDispute()
    const history = [
      buildHistoryRow({
        id: 'h-self',
        source: 'client',
        actorUserId: 'user-customer',
        note: 'My own statement',
      }),
      buildHistoryRow({
        id: 'h-counter',
        source: 'client',
        actorUserId: 'user-craftsman',
        note: 'Counterparty statement that must not leak',
      }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history,
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.timeline).toHaveLength(1)
    expect(view!.timeline[0].source).toBe('you')
  })

  it('redacts counterparty PII inside admin notes', () => {
    const dispute = buildDispute({ status: 'resolved', resolvedAt: '2026-05-01T11:00:00Z', decision: 'split', resolutionType: 'split', splitRatio: 0.6, settlementStatus: 'settled' })
    const adminNote = 'Anbieter Mustermann GmbH (kontakt@mustermann.de) hat …'
    const history = [
      buildHistoryRow({
        id: 'h-decision',
        previousStatus: 'under_review',
        nextStatus: 'resolved',
        source: 'admin',
        note: adminNote,
        createdAt: '2026-05-01T11:00:00.000Z',
      }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history,
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      counterparty: { displayName: 'Mustermann GmbH', emails: ['kontakt@mustermann.de'] },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.timeline[0].body).not.toContain('Mustermann')
    expect(view!.timeline[0].body).not.toContain('kontakt@mustermann.de')
    expect(view!.decision?.rationale).not.toContain('Mustermann')
    expect(view!.decision?.decision).toBe('split')
    expect(view!.decision?.splitRatio).toBeCloseTo(0.6)
  })

  it('marks snapshotMissing when the dispute predates Block 6.1 snapshots', () => {
    const dispute = buildDispute({ contextSnapshot: undefined })
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.snapshotMissing).toBe(true)
    expect(view!.snapshot).toBeNull()
  })

  it('exposes only own evidence, never counterparty evidence by default', () => {
    const dispute = buildDispute()
    const media = [
      buildMediaRow({ id: 'mine', ownerUserId: 'user-customer' }),
      buildMediaRow({ id: 'theirs', ownerUserId: 'user-craftsman' }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media,
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.ownEvidence.map((e) => e.id)).toEqual(['mine'])
    expect(view!.sharedCounterpartyEvidence).toHaveLength(0)
  })

  it('only surfaces counterparty evidence flagged as shared by the operator', () => {
    const dispute = buildDispute()
    const media = [
      buildMediaRow({
        id: 'shared',
        ownerUserId: 'user-craftsman',
        sharedWithCounterparty: true,
      }),
      buildMediaRow({
        id: 'private',
        ownerUserId: 'user-craftsman',
        sharedWithCounterparty: false,
      }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media,
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.sharedCounterpartyEvidence.map((e) => e.id)).toEqual(['shared'])
  })

  it('drops Stripe events outside the visible allowlist', () => {
    const dispute = buildDispute()
    const stripeEvents = [
      buildStripeRow({ eventType: 'payment_intent.succeeded' }),
      buildStripeRow({ eventId: 'evt_internal', eventType: 'invoice.created' }),
      buildStripeRow({ eventId: 'evt_refund', eventType: 'refund.succeeded' }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media: [],
      stripeEvents,
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    const visibleTypes = view!.stripeTimeline.map((e) => e.type)
    expect(visibleTypes).toContain('payment_intent.succeeded')
    expect(visibleTypes).toContain('refund.succeeded')
    expect(visibleTypes).not.toContain('invoice.created')
  })

  it('returns null when the dispute id and createdAt cannot produce an Aktenzeichen', () => {
    const view = selectReconciliationView({
      dispute: buildDispute({ createdAt: 'not-a-date' }),
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view).toBeNull()
  })

  it('omits submit_statement when the dispute is not waiting on the viewer', () => {
    const view = selectReconciliationView({
      dispute: buildDispute({ status: 'under_review' }),
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.availableActions).not.toContain('submit_statement')
    expect(view!.availableActions).toContain('upload_evidence')
  })

  // ─── N13.OPS · operator metadata read-paths ───────────────────────────

  it('returns an empty operatorComments array when metadata has none', () => {
    const view = selectReconciliationView({
      dispute: buildDispute(),
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.operatorComments).toEqual([])
  })

  it('reads operator_comments from dispute.metadata, oldest first', () => {
    const dispute = buildDispute({
      // metadata is not on the Dispute type — operator_comments lives in jsonb
      metadata: {
        operator_comments: [
          {
            id: 'cmt_2',
            body: 'Update: Anbieter hat Stellungnahme nachgereicht',
            written_at: '2026-04-22T09:30:00.000Z',
          },
          {
            id: 'cmt_1',
            body: 'Wir haben den Fall in Prüfung genommen',
            written_at: '2026-04-19T14:00:00.000Z',
          },
        ],
      },
    } as Partial<Dispute>)
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.operatorComments.map((c) => c.id)).toEqual(['cmt_1', 'cmt_2'])
    expect(view!.operatorComments[0].body).toContain('in Prüfung genommen')
  })

  it('drops malformed operator_comments entries', () => {
    const dispute = buildDispute({
      metadata: {
        operator_comments: [
          { id: 'cmt_ok', body: 'good', written_at: '2026-04-20T10:00:00.000Z' },
          { id: 'cmt_no_body', written_at: '2026-04-21T10:00:00.000Z' },
          { body: 'no-id', written_at: '2026-04-22T10:00:00.000Z' },
          'string-not-object',
          null,
        ],
      },
    } as Partial<Dispute>)
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media: [],
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.operatorComments).toHaveLength(1)
    expect(view!.operatorComments[0].id).toBe('cmt_ok')
  })

  it('flips counterparty media into shared when listed in metadata.shared_evidence_ids', () => {
    const dispute = buildDispute({
      metadata: { shared_evidence_ids: ['shared-via-meta'] },
    } as Partial<Dispute>)
    const media = [
      buildMediaRow({
        id: 'shared-via-meta',
        ownerUserId: 'user-craftsman',
        sharedWithCounterparty: false,
      }),
      buildMediaRow({
        id: 'still-private',
        ownerUserId: 'user-craftsman',
        sharedWithCounterparty: false,
      }),
    ]
    const view = selectReconciliationView({
      dispute,
      role: 'customer',
      history: [],
      media,
      stripeEvents: [],
      viewer: { userId: 'user-customer' },
      nowMs: FIXED_NOW_MS,
    })
    expect(view!.sharedCounterpartyEvidence.map((e) => e.id)).toEqual(['shared-via-meta'])
  })
})

describe('selectReconciliationList', () => {
  it('splits disputes into active and resolved buckets and counts viewer-waiting items', () => {
    const disputes: Dispute[] = [
      buildDispute({
        id: '11111111-2222-3333-4444-555555555555',
        status: 'customer_waiting',
        createdAt: '2026-04-18T14:32:00.000Z',
        updatedAt: '2026-04-26T10:00:00.000Z',
      }),
      buildDispute({
        id: '22222222-3333-4444-5555-666666666666',
        status: 'under_review',
        createdAt: '2026-04-12T10:00:00.000Z',
        updatedAt: '2026-04-21T08:00:00.000Z',
      }),
      buildDispute({
        id: '33333333-4444-5555-6666-777777777777',
        status: 'resolved',
        decision: 'split',
        resolutionType: 'split',
        splitRatio: 0.4,
        settlementStatus: 'settled',
        createdAt: '2026-03-02T10:00:00.000Z',
        updatedAt: '2026-03-09T11:00:00.000Z',
        resolvedAt: '2026-03-09T11:00:00.000Z',
      }),
    ]

    const buckets = selectReconciliationList({
      role: 'customer',
      viewerUserId: 'user-customer',
      disputes,
      nowMs: FIXED_NOW_MS,
      resolveContext: (dispute) => ({
        amountEur: dispute.id.startsWith('11') ? 2_140 : null,
        statementDeadlineAt:
          dispute.status === 'customer_waiting' ? '2026-04-28T17:00:00.000Z' : null,
        refundedAmountEur: dispute.status === 'resolved' ? 410 : null,
      }),
    })

    expect(buckets.counts.active).toBe(2)
    expect(buckets.counts.awaitingViewer).toBe(1)
    expect(buckets.counts.resolved).toBe(1)

    expect(buckets.active[0].requiresAction).toBe(true)
    expect(buckets.active[0].urgencyLevel).toBe('critical')
    expect(buckets.active[0].deadline?.urgency).toBe('soon')

    expect(buckets.resolved[0].decisionSummary).toBe('Aufteilung 40/60')
    expect(buckets.resolved[0].refundedAmountEur).toBe(410)
  })

  it('still emits items when no resolveContext is provided', () => {
    const buckets = selectReconciliationList({
      role: 'customer',
      viewerUserId: 'user-customer',
      disputes: [buildDispute()],
      nowMs: FIXED_NOW_MS,
    })
    expect(buckets.active).toHaveLength(1)
    expect(buckets.active[0].deadline).toBeNull()
    expect(buckets.active[0].amountEur).toBeNull()
  })
})
