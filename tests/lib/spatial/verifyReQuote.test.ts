/**
 * Verify-flow Re-Quote-Trigger — `verifyReQuote.ts` (Block 3.9 · VF-2).
 *
 * Covers the VF-2 threshold (>5 % dimension OR high-severity pin OR layout
 * change), the reason priority order, and the `markQuotesStale` offer-selection
 * plan (only `pending`, idempotent on already-stale).
 */
import { describe, it, expect } from 'vitest'

import {
  evaluateReQuoteTrigger,
  planMarkQuotesStale,
  applyStalePlan,
  RE_QUOTE_DIMENSION_THRESHOLD,
} from '../../../src/lib/spatial/workflow/verifyReQuote'
import type { VerifyChangeSummary } from '../../../src/lib/spatial/workflow/verifyChangeSummary'
import type { Offer, OfferStatus } from '../../../src/lib/offers/types'
import { InMemoryOfferRepository } from '../../../src/lib/offers/repository/InMemoryOfferRepository'

// ── Fixtures ───────────────────────────────────────────────────────────────

function summary(overrides: Partial<VerifyChangeSummary> = {}): VerifyChangeSummary {
  const base: VerifyChangeSummary = {
    measurements: [],
    layout: [],
    pins: [],
    totalChanges: 0,
    isEmpty: true,
  }
  const merged = { ...base, ...overrides }
  merged.totalChanges =
    merged.measurements.length + merged.layout.length + merged.pins.length
  merged.isEmpty = merged.totalChanges === 0
  return merged
}

/** A minimal `Offer` carrying only the fields the re-quote planner reads. */
function offer(id: string, status: OfferStatus, isStale = false): Offer {
  return { id, status, isStale } as unknown as Offer
}

// ── VF-2 threshold ─────────────────────────────────────────────────────────

describe('evaluateReQuoteTrigger · measurement threshold', () => {
  it('does NOT trigger when no change was made', () => {
    expect(evaluateReQuoteTrigger(summary())).toEqual({ triggered: false })
  })

  it('does NOT trigger for a sub-5 % height change', () => {
    const s = summary({
      measurements: [
        { wallId: 'w', wallName: 'W', heightBeforeM: 2.5, heightAfterM: 2.5 * 1.04 },
      ],
    })
    expect(evaluateReQuoteTrigger(s)).toEqual({ triggered: false })
  })

  it('triggers `measurement_changed` for a >5 % height change', () => {
    const s = summary({
      measurements: [
        { wallId: 'w', wallName: 'W', heightBeforeM: 2.5, heightAfterM: 2.5 * 1.06 },
      ],
    })
    expect(evaluateReQuoteTrigger(s)).toEqual({
      triggered: true,
      reason: 'measurement_changed',
    })
  })

  it('does NOT trigger exactly AT the 5 % threshold (strict >)', () => {
    const after = 2.5 * (1 + RE_QUOTE_DIMENSION_THRESHOLD)
    const s = summary({
      measurements: [{ wallId: 'w', wallName: 'W', heightBeforeM: 2.5, heightAfterM: after }],
    })
    expect(evaluateReQuoteTrigger(s).triggered).toBe(false)
  })

  it('treats a degenerate (zero) base height as significant', () => {
    const s = summary({
      measurements: [{ wallId: 'w', wallName: 'W', heightBeforeM: 0, heightAfterM: 2.5 }],
    })
    expect(evaluateReQuoteTrigger(s).triggered).toBe(true)
  })
})

describe('evaluateReQuoteTrigger · high-severity pin', () => {
  it('triggers `high_severity_pin_added` for a new high-severity pin', () => {
    const s = summary({
      pins: [{ pinId: 'p', pinType: 'damage', title: 'Schimmel', severity: 'high' }],
    })
    expect(evaluateReQuoteTrigger(s)).toEqual({
      triggered: true,
      reason: 'high_severity_pin_added',
    })
  })

  it('does NOT trigger for a low / medium severity pin', () => {
    const s = summary({
      pins: [
        { pinId: 'p1', pinType: 'damage', title: 'A', severity: 'low' },
        { pinId: 'p2', pinType: 'damage', title: 'B', severity: 'medium' },
      ],
    })
    expect(evaluateReQuoteTrigger(s).triggered).toBe(false)
  })
})

describe('evaluateReQuoteTrigger · layout change', () => {
  it('triggers `layout_changed` for any layout edit', () => {
    const s = summary({
      layout: [{ kind: 'wall_deleted', nodeId: 'w', label: 'Wand entfernt' }],
    })
    expect(evaluateReQuoteTrigger(s)).toEqual({ triggered: true, reason: 'layout_changed' })
  })
})

describe('evaluateReQuoteTrigger · reason priority', () => {
  it('measurement wins over a high-severity pin and a layout change', () => {
    const s = summary({
      measurements: [
        { wallId: 'w', wallName: 'W', heightBeforeM: 2.5, heightAfterM: 3.0 },
      ],
      pins: [{ pinId: 'p', pinType: 'damage', title: 'X', severity: 'high' }],
      layout: [{ kind: 'wall_deleted', nodeId: 'w2', label: 'x' }],
    })
    expect(evaluateReQuoteTrigger(s)).toEqual({
      triggered: true,
      reason: 'measurement_changed',
    })
  })

  it('a high-severity pin wins over a layout change', () => {
    const s = summary({
      pins: [{ pinId: 'p', pinType: 'damage', title: 'X', severity: 'high' }],
      layout: [{ kind: 'wall_deleted', nodeId: 'w2', label: 'x' }],
    })
    expect(evaluateReQuoteTrigger(s).triggered).toBe(true)
    if (evaluateReQuoteTrigger(s).triggered) {
      expect(evaluateReQuoteTrigger(s)).toMatchObject({ reason: 'high_severity_pin_added' })
    }
  })
})

// ── markQuotesStale plan ───────────────────────────────────────────────────

describe('planMarkQuotesStale', () => {
  const triggered = { triggered: true, reason: 'layout_changed' } as const

  it('returns an empty plan when the trigger did not fire', () => {
    const offers = [offer('o1', 'pending')]
    expect(planMarkQuotesStale(offers, { triggered: false }, 'scene-1')).toEqual([])
  })

  it('only flags `pending` offers', () => {
    const offers = [
      offer('o1', 'pending'),
      offer('o2', 'draft'),
      offer('o3', 'accepted'),
      offer('o4', 'declined'),
      offer('o5', 'superseded'),
      offer('o6', 'expired'),
    ]
    const plan = planMarkQuotesStale(offers, triggered, 'scene-1', 1000)
    expect(plan.map((p) => p.offerId)).toEqual(['o1'])
    expect(plan[0]).toEqual({
      offerId: 'o1',
      reason: 'layout_changed',
      markedAt: 1000,
      sourceSceneId: 'scene-1',
    })
  })

  it('skips an offer that is already stale (idempotent)', () => {
    const offers = [offer('o1', 'pending', true), offer('o2', 'pending', false)]
    const plan = planMarkQuotesStale(offers, triggered, 'scene-1')
    expect(plan.map((p) => p.offerId)).toEqual(['o2'])
  })
})

describe('applyStalePlan', () => {
  it('sets the four QUOTE-STALE fields, leaves status pending', () => {
    const o = offer('o1', 'pending')
    const patched = applyStalePlan(o, {
      offerId: 'o1',
      reason: 'measurement_changed',
      markedAt: 42,
      sourceSceneId: 'scene-9',
    })
    expect(patched).toMatchObject({
      status: 'pending',
      isStale: true,
      staleReason: 'measurement_changed',
      staleMarkedAt: 42,
      staleSourceSceneId: 'scene-9',
    })
  })
})

// ── QUOTE-STALE repository symmetry (InMemory · Block 3.9) ──────────────────

describe('QUOTE-STALE · InMemoryOfferRepository symmetry', () => {
  it('round-trips the four QUOTE-STALE fields through an update', async () => {
    const repo = new InMemoryOfferRepository()
    const fresh = offer('o1', 'pending')
    fresh.conversationId = 'conv-1'
    await repo.add(fresh)

    // Defaults — a fresh offer is not stale.
    expect(repo.getById('o1')?.isStale).toBe(false)
    expect(repo.getById('o1')?.staleReason).toBeUndefined()

    // Apply the stale plan via the repo updater — the same path the
    // verify-flow workflow uses.
    await repo.update('o1', (o) =>
      applyStalePlan(o, {
        offerId: 'o1',
        reason: 'high_severity_pin_added',
        markedAt: 999,
        sourceSceneId: 'scene-7',
      }),
    )
    const stale = repo.getById('o1')
    expect(stale).toMatchObject({
      status: 'pending',
      isStale: true,
      staleReason: 'high_severity_pin_added',
      staleMarkedAt: 999,
      staleSourceSceneId: 'scene-7',
    })
  })
})
