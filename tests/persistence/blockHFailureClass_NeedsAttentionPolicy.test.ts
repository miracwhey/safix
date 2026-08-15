/**
 * Block H-Failure-Class — needsUserAttention policy by FailureKind
 *
 * Verifies the SyncStatusBar truth contract:
 *
 *   - permission-denied / business-rejected / validation
 *       → user attention immediately, no age-threshold suppression
 *   - auth-not-ready
 *       → never user attention (silent until next auth-ready flush)
 *   - transient / retryable / unknown
 *       → existing age-threshold + retry-count behaviour preserved
 *   - permanent flag
 *       → still wins regardless of kind
 *
 * These invariants are what stop a falsche Eskalation while keeping echte
 * dauerhafte Probleme weiterhin sichtbar.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  recordPersistenceFailure,
  needsUserAttention,
  clearPersistenceFailures,
  getPersistenceFailures,
  type PersistenceFailure,
} from '../../src/lib/persistence/persistenceErrorStore'

beforeEach(() => {
  clearPersistenceFailures()
})

function recent(): number {
  // Fresh — well below the 15 s age threshold.
  return Date.now()
}

function aged(): number {
  // 20 s ago — past the MIN_AGE_MS threshold (15 s).
  return Date.now() - 20_000
}

function lastFailure(): PersistenceFailure {
  const all = getPersistenceFailures()
  return all[all.length - 1]
}

describe('needsUserAttention — permanent kinds', () => {
  it('escalates permission-denied immediately, even when fresh', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: { code: 'PGRST301' },
      occurredAt: recent(),
    })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('escalates business-rejected immediately, even when fresh', () => {
    recordPersistenceFailure({
      domain: 'team',
      operation: 'add',
      entityId: 't-1',
      error: { code: '23502', message: 'null value in column' },
      occurredAt: recent(),
    })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('escalates validation (42xxx) immediately, even when fresh', () => {
    recordPersistenceFailure({
      domain: 'invoices',
      operation: 'update',
      entityId: 'inv-1',
      error: { code: '42703', message: 'column does not exist' },
      occurredAt: recent(),
    })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('escalates explicit kind=permission-denied even when error has no code', () => {
    recordPersistenceFailure({
      domain: 'payments/ledger',
      operation: 'add',
      entityId: 'led-1',
      error: new Error('opaque'),
      occurredAt: recent(),
      kind: 'permission-denied',
    })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })
})

describe('needsUserAttention — auth-not-ready', () => {
  it('never escalates auth-not-ready, even when aged', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: { status: 401 },
      occurredAt: aged(),
    })
    expect(needsUserAttention(lastFailure())).toBe(false)
  })

  it('never escalates auth-not-ready, even with high retry count', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: { status: 401 },
      occurredAt: aged(),
    })
    // Simulate multiple auto-recovery attempts.
    recordPersistenceFailure(
      {
        domain: 'jobs',
        operation: 'update',
        entityId: 'job-1',
        error: { status: 401 },
        occurredAt: aged(),
      },
      { fromAutoRecovery: true },
    )
    recordPersistenceFailure(
      {
        domain: 'jobs',
        operation: 'update',
        entityId: 'job-1',
        error: { status: 401 },
        occurredAt: aged(),
      },
      { fromAutoRecovery: true },
    )
    expect(needsUserAttention(lastFailure())).toBe(false)
  })
})

describe('needsUserAttention — transient/retryable/unknown', () => {
  it('does NOT escalate fresh transient failure (queued domain)', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: recent(),
    })
    expect(needsUserAttention(lastFailure())).toBe(false)
  })

  it('escalates aged transient failure on non-queued domain (15s rule)', () => {
    recordPersistenceFailure({
      domain: 'payments',
      operation: 'update',
      entityId: 'pay-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: aged(),
    })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('does NOT escalate aged transient on queued domain without 2 retries', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: aged(),
    })
    expect(needsUserAttention(lastFailure())).toBe(false)
  })

  it('escalates aged transient on queued domain after 2 retries', () => {
    const make = () => ({
      domain: 'jobs' as const,
      operation: 'update' as const,
      entityId: 'job-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: aged(),
    })
    recordPersistenceFailure(make())
    recordPersistenceFailure(make(), { fromAutoRecovery: true })
    recordPersistenceFailure(make(), { fromAutoRecovery: true })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('treats unknown like transient (queued + 2 retries + age)', () => {
    const make = () => ({
      domain: 'jobs' as const,
      operation: 'update' as const,
      entityId: 'job-1',
      error: { foo: 'bar' }, // classifier → unknown
      occurredAt: aged(),
    })
    recordPersistenceFailure(make())
    recordPersistenceFailure(make(), { fromAutoRecovery: true })
    recordPersistenceFailure(make(), { fromAutoRecovery: true })
    expect(needsUserAttention(lastFailure())).toBe(true)
  })
})

describe('needsUserAttention — permanent flag still wins', () => {
  it('escalates permanent failure regardless of kind', () => {
    recordPersistenceFailure(
      {
        domain: 'jobs',
        operation: 'update',
        entityId: 'job-1',
        error: { foo: 'bar' }, // classifier → unknown
        occurredAt: recent(),
      },
      { permanent: true },
    )
    expect(needsUserAttention(lastFailure())).toBe(true)
  })

  it('escalates permanent even when explicitly auth-not-ready (defensive)', () => {
    recordPersistenceFailure(
      {
        domain: 'jobs',
        operation: 'update',
        entityId: 'job-1',
        error: { status: 401 },
        occurredAt: recent(),
        kind: 'auth-not-ready',
      },
      { permanent: true },
    )
    // permanent takes precedence — the queue already gave up.
    expect(needsUserAttention(lastFailure())).toBe(true)
  })
})

describe('recordPersistenceFailure — auto-classify integration', () => {
  it('stores kind from explicit input when supplied', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'add',
      entityId: 'job-1',
      error: new Error('opaque'),
      occurredAt: recent(),
      kind: 'business-rejected',
    })
    expect(lastFailure().kind).toBe('business-rejected')
  })

  it('auto-classifies when kind is omitted', () => {
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'add',
      entityId: 'job-2',
      error: { code: '23505' },
      occurredAt: recent(),
    })
    expect(lastFailure().kind).toBe('business-rejected')
  })

  it('auto-classifies network error as transient', () => {
    recordPersistenceFailure({
      domain: 'calendar',
      operation: 'add',
      entityId: 'cal-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: recent(),
    })
    expect(lastFailure().kind).toBe('transient')
  })

  it('upgrades kind on subsequent record for same entity', () => {
    // First record: transient (network).
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: new TypeError('Failed to fetch'),
      occurredAt: recent(),
    })
    expect(lastFailure().kind).toBe('transient')

    // Second record on same entity: now a real RLS reject — kind updates.
    recordPersistenceFailure({
      domain: 'jobs',
      operation: 'update',
      entityId: 'job-1',
      error: { code: 'PGRST301' },
      occurredAt: recent(),
    })
    expect(lastFailure().kind).toBe('permission-denied')
    expect(needsUserAttention(lastFailure())).toBe(true)
  })
})
