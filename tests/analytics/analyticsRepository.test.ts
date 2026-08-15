import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryAnalyticsRepository } from '../../src/lib/analytics/repository/InMemoryAnalyticsRepository'
import type { AnalyticsEvent } from '../../src/lib/analytics/analyticsTypes'

function makeEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    eventId: overrides.eventId ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? 'job_created',
    entityType: overrides.entityType ?? 'job',
    entityId: overrides.entityId ?? 'job-1',
    actorUserId: overrides.actorUserId,
    metadata: overrides.metadata,
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

describe('InMemoryAnalyticsRepository', () => {
  let repo: InMemoryAnalyticsRepository

  beforeEach(() => {
    repo = new InMemoryAnalyticsRepository()
  })

  it('starts empty', () => {
    expect(repo.getAll()).toEqual([])
  })

  it('adds and retrieves events', () => {
    const event = makeEvent()
    repo.add(event)
    expect(repo.getAll()).toHaveLength(1)
    expect(repo.getAll()[0]).toEqual(event)
  })

  it('prepends new events (newest first)', () => {
    const first = makeEvent({ eventId: 'e1', createdAt: 1000 })
    const second = makeEvent({ eventId: 'e2', createdAt: 2000 })
    repo.add(first)
    repo.add(second)

    const all = repo.getAll()
    expect(all[0].eventId).toBe('e2')
    expect(all[1].eventId).toBe('e1')
  })

  it('filters by event type', () => {
    repo.add(makeEvent({ eventType: 'job_created' }))
    repo.add(makeEvent({ eventType: 'job_completed' }))
    repo.add(makeEvent({ eventType: 'job_created' }))

    expect(repo.getByEventType('job_created')).toHaveLength(2)
    expect(repo.getByEventType('job_completed')).toHaveLength(1)
    expect(repo.getByEventType('payment_created')).toHaveLength(0)
  })

  it('filters by entity id', () => {
    repo.add(makeEvent({ entityId: 'job-1' }))
    repo.add(makeEvent({ entityId: 'job-2' }))
    repo.add(makeEvent({ entityId: 'job-1' }))

    expect(repo.getByEntityId('job-1')).toHaveLength(2)
    expect(repo.getByEntityId('job-2')).toHaveLength(1)
    expect(repo.getByEntityId('job-3')).toHaveLength(0)
  })

  it('filters events since a timestamp', () => {
    repo.add(makeEvent({ createdAt: 1000 }))
    repo.add(makeEvent({ createdAt: 2000 }))
    repo.add(makeEvent({ createdAt: 3000 }))

    expect(repo.getSince(2000)).toHaveLength(2)
    expect(repo.getSince(3000)).toHaveLength(1)
    expect(repo.getSince(4000)).toHaveLength(0)
  })

  it('notifies subscribers on add', () => {
    let callCount = 0
    repo.subscribe(() => { callCount++ })

    repo.add(makeEvent())
    expect(callCount).toBe(1)

    repo.add(makeEvent())
    expect(callCount).toBe(2)
  })

  it('supports unsubscribe', () => {
    let callCount = 0
    const unsub = repo.subscribe(() => { callCount++ })

    repo.add(makeEvent())
    expect(callCount).toBe(1)

    unsub()
    repo.add(makeEvent())
    expect(callCount).toBe(1)
  })

  it('can be initialized with seed data', () => {
    const seed = [makeEvent({ eventId: 's1' }), makeEvent({ eventId: 's2' })]
    const seeded = new InMemoryAnalyticsRepository(seed)
    expect(seeded.getAll()).toHaveLength(2)
  })
})
