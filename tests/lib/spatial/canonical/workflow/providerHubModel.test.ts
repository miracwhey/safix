/**
 * Provider Hub Model — aggregator unit tests (Phase B · B-1).
 * Covers the §3.2 critical-action score, the §3.3 pipeline grouping, the
 * §3.4 activity feed, and the §13 PH-8 tab badge.
 */
import { describe, expect, it } from 'vitest'
import {
  buildProviderHubModel,
  computeJobSignals,
  HUB_CRITICAL_MAX,
  HUB_FEED_MAX,
  isHubCalm,
  type ProviderHubJobInput,
  type ProviderHubJobSignals,
  type HubPipelineStage,
} from '../../../../../src/lib/spatial/canonical/workflow/providerHubModel'
import type {
  PinReview,
  SpatialChangeOrder,
  SpatialEditHistoryEntry,
  SpatialRescanRequest,
} from '../../../../../src/lib/spatial/canonical/repository/SpatialSceneRepository'

const ZERO_SIGNALS: ProviderHubJobSignals = {
  customerWaitingHrs: null,
  quoteDeadlineHrs: null,
  quoteSent: false,
  workerPinsUnreviewed: 0,
  workerPinsUnreviewedHrs: null,
  rescanResponsePendingHrs: null,
  highSeverityPinUnread: false,
  changeOrderPending: false,
  bomError: false,
  validatorWarnings: 0,
}

function job(
  id: string,
  stage: HubPipelineStage,
  signals: Partial<ProviderHubJobSignals> = {},
): ProviderHubJobInput {
  return {
    jobId: id,
    sceneId: `scene-${id}`,
    sourceScanId: `scan-${id}`,
    title: `Job ${id}`,
    customerName: `Kunde ${id}`,
    locationLabel: 'Hamburg',
    areaM2: 8,
    roomLabel: 'Bad',
    priority: 'mid',
    stage,
    signals: { ...ZERO_SIGNALS, ...signals },
    recentEvents: [],
  }
}

describe('buildProviderHubModel · critical-action scoring (§3.2)', () => {
  it('a job with no open signal produces no critical action', () => {
    const model = buildProviderHubModel([job('a', 'neu')])
    expect(model.criticalActions).toHaveLength(0)
    expect(isHubCalm(model)).toBe(true)
  })

  it('customer waiting >24h scores 100 and is red', () => {
    const model = buildProviderHubModel([job('a', 'neu', { customerWaitingHrs: 26 })])
    expect(model.criticalActions).toHaveLength(1)
    expect(model.criticalActions[0].score).toBe(100)
    expect(model.criticalActions[0].urgency).toBe('red')
  })

  it('customer waiting <=24h does NOT score', () => {
    const model = buildProviderHubModel([job('a', 'neu', { customerWaitingHrs: 20 })])
    expect(model.criticalActions).toHaveLength(0)
  })

  it('quote deadline <48h and not sent scores 80; sent suppresses it', () => {
    expect(
      buildProviderHubModel([job('a', 'quoting', { quoteDeadlineHrs: 12, quoteSent: false })])
        .criticalActions[0]?.score,
    ).toBe(80)
    expect(
      buildProviderHubModel([job('a', 'quoting', { quoteDeadlineHrs: 12, quoteSent: true })])
        .criticalActions,
    ).toHaveLength(0)
  })

  it('sums every contributing signal into the job score', () => {
    // customer-waiting(100) + change-order(40) + validator(20) = 160
    const model = buildProviderHubModel([
      job('a', 'aktiv', {
        customerWaitingHrs: 30,
        changeOrderPending: true,
        validatorWarnings: 2,
      }),
    ])
    expect(model.criticalActions[0].score).toBe(160)
    // dominant signal titles the card
    expect(model.criticalActions[0].ctaLabel).toBe('Antworten')
  })

  it('caps critical actions at 4, score-descending', () => {
    const jobs = [
      job('low', 'aktiv', { validatorWarnings: 1 }), // 20
      job('hi', 'neu', { customerWaitingHrs: 40 }), // 100
      job('mid', 'aktiv', { bomError: true }), // 30
      job('co', 'aktiv', { changeOrderPending: true }), // 40
      job('hp', 'aktiv', { highSeverityPinUnread: true }), // 50
    ]
    const model = buildProviderHubModel(jobs)
    expect(model.criticalActions).toHaveLength(HUB_CRITICAL_MAX)
    expect(model.criticalActions.map((c) => c.jobId)).toEqual(['hi', 'hp', 'co', 'mid'])
  })
})

describe('buildProviderHubModel · pipeline (§3.3)', () => {
  it('always produces the 4 fixed columns in order', () => {
    const model = buildProviderHubModel([])
    expect(model.pipeline.map((c) => c.stage)).toEqual(['neu', 'quoting', 'aktiv', 'fertig'])
  })

  it('groups jobs into their stage column and counts them', () => {
    const model = buildProviderHubModel([
      job('a', 'neu'),
      job('b', 'neu'),
      job('c', 'aktiv'),
      job('d', 'fertig'),
    ])
    const byStage = Object.fromEntries(model.pipeline.map((c) => [c.stage, c.count]))
    expect(byStage).toEqual({ neu: 2, quoting: 0, aktiv: 1, fertig: 0 + 1 })
    expect(model.totalJobs).toBe(4)
  })

  it('floats urgent cards to the top of their column', () => {
    const model = buildProviderHubModel([
      job('calm', 'aktiv'),
      job('urgent', 'aktiv', { customerWaitingHrs: 40 }),
    ])
    const aktiv = model.pipeline.find((c) => c.stage === 'aktiv')!
    expect(aktiv.cards[0].jobId).toBe('urgent')
    expect(aktiv.cards[0].urgency).toBe('red')
  })
})

describe('buildProviderHubModel · activity feed (§3.4) + tab badge (§13 PH-8)', () => {
  it('merges events newest-first and caps at HUB_FEED_MAX', () => {
    const many = Array.from({ length: HUB_FEED_MAX + 5 }, (_, i) => ({
      id: `e${i}`,
      jobId: 'a',
      jobLabel: 'Job a',
      actorKind: 'team' as const,
      text: 'Szene bearbeitet',
      atMs: i * 1000,
      agoLabel: `${i}s`,
    }))
    const j = job('a', 'aktiv')
    j.recentEvents = many
    const model = buildProviderHubModel([j])
    expect(model.activityFeed).toHaveLength(HUB_FEED_MAX)
    expect(model.activityFeed[0].id).toBe(`e${HUB_FEED_MAX + 4}`) // newest
  })

  it('tab badge counts critical actions plus uncovered worker-review jobs', () => {
    const model = buildProviderHubModel([
      job('crit', 'aktiv', { customerWaitingHrs: 40 }), // critical
      job('rev', 'aktiv', { workerPinsUnreviewed: 3 }), // worker review, no critical
    ])
    expect(model.criticalActions).toHaveLength(1)
    expect(model.tabBadgeCount).toBe(2)
  })
})

describe('computeJobSignals (C-8)', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z')
  const isoAgo = (hrs: number) => new Date(NOW - hrs * 3_600_000).toISOString()

  function mkHistory(o: Partial<SpatialEditHistoryEntry>): SpatialEditHistoryEntry {
    return {
      id: 'e-' + Math.random().toString(36).slice(2),
      sceneId: 's',
      providerOrgId: 'org',
      actorId: null,
      variantId: 'v',
      baseNodeId: 'n',
      overrideFields: {},
      command: 'set',
      parametricSha256Before: null,
      parametricSha256After: null,
      createdAt: isoAgo(1),
      ...o,
    }
  }
  function mkChangeOrder(o: Partial<SpatialChangeOrder>): SpatialChangeOrder {
    return {
      id: 'co',
      sceneId: 's',
      nodeId: null,
      proposerId: 'p',
      status: 'proposed',
      title: 'CO',
      body: null,
      metadata: {},
      createdAt: isoAgo(1),
      updatedAt: isoAgo(1),
      ...o,
    }
  }
  function mkRescan(o: Partial<SpatialRescanRequest>): SpatialRescanRequest {
    return {
      id: 'r',
      sceneId: 's',
      providerOrgId: 'org',
      requestedByUserId: 'u',
      requestedByRole: 'owner',
      reason: 'x',
      status: 'pending',
      responseNote: null,
      respondedAt: null,
      createdAt: isoAgo(1),
      updatedAt: isoAgo(1),
      ...o,
    }
  }
  function mkReview(annotationNodeId: string): PinReview {
    return {
      id: 'pr-' + annotationNodeId,
      sceneId: 's',
      providerOrgId: 'org',
      annotationNodeId,
      reviewedByUserId: 'u',
      reviewedByRole: 'owner',
      reviewStatus: 'trusted',
      createdAt: isoAgo(1),
      updatedAt: isoAgo(1),
    }
  }
  const baseScene = {
    validationState: 'passed',
    customerVerifyState: 'not_started',
    customerVerifyLastActiveAt: null,
  }
  const emptyInput = {
    scene: baseScene,
    editHistory: [],
    changeOrders: [],
    rescanRequests: [],
    pinReviews: [],
    workerActorIds: new Set<string>(),
    quoteSent: false,
    nowMs: NOW,
  }

  it('flags a pending change-order', () => {
    expect(computeJobSignals({ ...emptyInput, changeOrders: [mkChangeOrder({})] }).changeOrderPending).toBe(true)
    expect(
      computeJobSignals({ ...emptyInput, changeOrders: [mkChangeOrder({ status: 'accepted' })] })
        .changeOrderPending,
    ).toBe(false)
  })

  it('counts unreviewed worker pins and excludes reviewed ones', () => {
    const signals = computeJobSignals({
      ...emptyInput,
      editHistory: [
        mkHistory({ actorId: 'w1', baseNodeId: 'n1' }),
        mkHistory({ actorId: 'w1', baseNodeId: 'n2' }),
      ],
      pinReviews: [mkReview('n1')],
      workerActorIds: new Set(['w1']),
    })
    expect(signals.workerPinsUnreviewed).toBe(1)
  })

  it('derives rescanResponsePendingHrs from the oldest pending request', () => {
    const signals = computeJobSignals({
      ...emptyInput,
      rescanRequests: [
        mkRescan({ createdAt: isoAgo(30) }),
        mkRescan({ createdAt: isoAgo(5) }),
        mkRescan({ status: 'accepted', createdAt: isoAgo(99) }),
      ],
    })
    expect(Math.round(signals.rescanResponsePendingHrs ?? -1)).toBe(30)
  })

  it('flags customerWaitingHrs once the scan is approved and unquoted', () => {
    const waiting = computeJobSignals({
      ...emptyInput,
      scene: {
        validationState: 'passed',
        customerVerifyState: 'approved',
        customerVerifyLastActiveAt: isoAgo(40),
      },
      quoteSent: false,
    })
    expect(Math.round(waiting.customerWaitingHrs ?? -1)).toBe(40)
    // Suppressed once the quote is out.
    const quoted = computeJobSignals({
      ...emptyInput,
      scene: {
        validationState: 'passed',
        customerVerifyState: 'approved',
        customerVerifyLastActiveAt: isoAgo(40),
      },
      quoteSent: true,
    })
    expect(quoted.customerWaitingHrs).toBeNull()
  })

  it('leaves quoteDeadlineHrs + bomError at their documented defaults', () => {
    const signals = computeJobSignals(emptyInput)
    expect(signals.quoteDeadlineHrs).toBeNull()
    expect(signals.bomError).toBe(false)
  })
})
