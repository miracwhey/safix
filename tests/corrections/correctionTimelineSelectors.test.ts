import { describe, it, expect } from 'vitest'
import { deriveCorrectionTimeline } from '../../src/lib/corrections/correctionTimelineSelectors'
import type { CorrectionRequest } from '../../src/lib/corrections'

const T0 = 1_700_000_000_000
const T1 = T0 + 1_000 * 60 * 60 // +1h

function makeRequest(overrides: Partial<CorrectionRequest> = {}): CorrectionRequest {
  return {
    id: 'cr-1',
    providerId: 'p1',
    workerTeamMemberId: 'tm-w',
    workerProfileId: 'u-w',
    kind: 'wrong_time',
    description: 'falsche Zeit',
    status: 'open',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

describe('deriveCorrectionTimeline — Block 7.2.5', () => {
  it('emits exactly one "submitted" event when status is open and untouched', () => {
    const events = deriveCorrectionTimeline(makeRequest())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'submitted', labelKey: 'submitted', occurredAt: T0 })
  })

  it('still emits only "submitted" for in_review (no terminal decision)', () => {
    const events = deriveCorrectionTimeline(makeRequest({ status: 'in_review', updatedAt: T1 }))
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('submitted')
  })

  it('emits submitted + resolved for terminal-resolved with later updatedAt', () => {
    const events = deriveCorrectionTimeline(
      makeRequest({ status: 'resolved', updatedAt: T1 }),
    )
    expect(events.map((e) => e.kind)).toEqual(['submitted', 'resolved'])
    expect(events[1].occurredAt).toBe(T1)
  })

  it('emits submitted + rejected for terminal-rejected with later updatedAt', () => {
    const events = deriveCorrectionTimeline(
      makeRequest({ status: 'rejected', updatedAt: T1 }),
    )
    expect(events.map((e) => e.kind)).toEqual(['submitted', 'rejected'])
    expect(events[1].occurredAt).toBe(T1)
  })

  it('skips terminal event when updatedAt equals createdAt (instant-on-submit anomaly)', () => {
    const events = deriveCorrectionTimeline(
      makeRequest({ status: 'resolved', updatedAt: T0 }),
    )
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('submitted')
  })

  it('preserves chronological ordering', () => {
    const events = deriveCorrectionTimeline(
      makeRequest({ status: 'rejected', updatedAt: T1 }),
    )
    expect(events[0].occurredAt).toBeLessThan(events[1].occurredAt)
  })
})
