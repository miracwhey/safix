import { describe, it, expect } from 'vitest'
import type { AnalyticsEvent } from '../../src/lib/analytics'
import { distinctActors, deriveFunnel, getUserFunnel, isoWeek } from '../../src/lib/analytics'

function ev(partial: Partial<AnalyticsEvent>): AnalyticsEvent {
  return {
    eventId: partial.eventId ?? crypto.randomUUID(),
    eventType: partial.eventType ?? 'app_open',
    entityType: partial.entityType ?? 'user',
    entityId: partial.entityId ?? 'u1',
    actorUserId: partial.actorUserId,
    metadata: partial.metadata,
    createdAt: partial.createdAt ?? 0,
  }
}

describe('funnel selectors', () => {
  const events: AnalyticsEvent[] = [
    ev({ eventType: 'app_open', actorUserId: 'u1', createdAt: 10 }),
    ev({ eventType: 'app_open', actorUserId: 'u1', createdAt: 20 }), // same actor twice
    ev({ eventType: 'app_open', actorUserId: 'u2', createdAt: 15 }),
    ev({ eventType: 'app_open', actorUserId: undefined, createdAt: 5 }), // anonymous, ignored
    ev({ eventType: 'signup', actorUserId: 'u1', createdAt: 30, metadata: { cohortWeek: '2026-W27', role: 'customer' } }),
    ev({ eventType: 'inquiry_created', actorUserId: 'u1', createdAt: 40, metadata: { providerId: 'p9' } }),
    ev({ eventType: 'payment_created', actorUserId: 'u1', createdAt: 50 }),
  ]

  it('distinctActors counts unique actors, ignoring anonymous', () => {
    expect(distinctActors(events, 'app_open')).toBe(2)
    expect(distinctActors(events, 'signup')).toBe(1)
    expect(distinctActors(events, 'job_created')).toBe(0)
  })

  it('deriveFunnel reports distinct actors per lifecycle stage', () => {
    expect(deriveFunnel(events)).toEqual({
      appOpens: 2,
      signups: 1,
      inquiriesCreated: 1,
      firstPayments: 1,
    })
  })

  it('getUserFunnel returns earliest timestamp per stage + stamped cohort/role', () => {
    const f = getUserFunnel(events, 'u1')
    expect(f.appOpenedAt).toBe(10) // earliest of 10/20
    expect(f.signedUpAt).toBe(30)
    expect(f.firstInquiryAt).toBe(40)
    expect(f.firstPaymentAt).toBe(50)
    expect(f.cohortWeek).toBe('2026-W27')
    expect(f.role).toBe('customer')
  })

  it('getUserFunnel for an unknown user is empty', () => {
    expect(getUserFunnel(events, 'nobody')).toEqual({})
  })
})

describe('isoWeek', () => {
  it('returns a Thursday-anchored ISO week key', () => {
    // 2026-01-01 is a Thursday → ISO week 1 of 2026.
    expect(isoWeek('2026-01-01T00:00:00.000Z')).toBe('2026-W01')
    // Mid-year sanity: 2026-07-06 (Monday) → W28.
    expect(isoWeek('2026-07-06T12:00:00.000Z')).toBe('2026-W28')
  })

  it('returns undefined for missing or unparseable input', () => {
    expect(isoWeek(undefined)).toBeUndefined()
    expect(isoWeek(null)).toBeUndefined()
    expect(isoWeek('not-a-date')).toBeUndefined()
  })
})
