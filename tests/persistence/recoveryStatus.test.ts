/**
 * recoveryStatus — store unit tests
 *
 * Verifies refcount semantics, finish-handle idempotency, subscriber
 * notifications, and the sign-out-driven force-clear path.  These
 * invariants are what guarantees the SyncStatusBar suppression behaves
 * correctly under iOS resume cascades and account switches.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  markRecoveryStarted,
  isRecovering,
  getRecoveryStartedAt,
  clearRecoveryStatus,
  subscribeToRecoveryStatus,
  _resetRecoveryStatusForTest,
} from '../../src/lib/persistence/recoveryStatus'

beforeEach(() => {
  _resetRecoveryStatusForTest()
})

describe('recoveryStatus', () => {
  it('starts in a non-recovering state', () => {
    expect(isRecovering()).toBe(false)
    expect(getRecoveryStartedAt()).toBeNull()
  })

  it('marks recovering and returns a finish handle', () => {
    const finish = markRecoveryStarted()
    expect(typeof finish).toBe('function')
    expect(isRecovering()).toBe(true)
    expect(getRecoveryStartedAt()).toBeTypeOf('number')

    finish()
    expect(isRecovering()).toBe(false)
    expect(getRecoveryStartedAt()).toBeNull()
  })

  it('refcounts overlapping recoveries — banner stays suppressed until last finish', () => {
    const a = markRecoveryStarted()
    const b = markRecoveryStarted()
    const c = markRecoveryStarted()

    expect(isRecovering()).toBe(true)

    a()
    expect(isRecovering()).toBe(true)
    b()
    expect(isRecovering()).toBe(true)
    c()
    expect(isRecovering()).toBe(false)
  })

  it('preserves the original startedAt across overlapping recoveries', async () => {
    const finishA = markRecoveryStarted()
    const startedAtA = getRecoveryStartedAt()
    expect(startedAtA).not.toBeNull()

    // Wait so a hypothetical second start would have a strictly larger ts.
    await new Promise((r) => setTimeout(r, 5))

    const finishB = markRecoveryStarted()
    expect(getRecoveryStartedAt()).toBe(startedAtA)

    finishA()
    finishB()
    expect(getRecoveryStartedAt()).toBeNull()
  })

  it('finish handle is idempotent — calling twice does not double-decrement', () => {
    const a = markRecoveryStarted()
    const b = markRecoveryStarted()
    expect(isRecovering()).toBe(true)

    a()
    a() // second call must be a no-op
    expect(isRecovering()).toBe(true) // b still outstanding

    b()
    expect(isRecovering()).toBe(false)
  })

  it('clearRecoveryStatus force-resets the counter', () => {
    markRecoveryStarted()
    markRecoveryStarted()
    expect(isRecovering()).toBe(true)

    clearRecoveryStatus()
    expect(isRecovering()).toBe(false)
    expect(getRecoveryStartedAt()).toBeNull()
  })

  it('outstanding finish handles are no-ops after clearRecoveryStatus', () => {
    const finish = markRecoveryStarted()
    clearRecoveryStatus()
    expect(isRecovering()).toBe(false)

    finish() // must not push the counter below zero
    expect(isRecovering()).toBe(false)

    // A subsequent fresh recovery still works.
    const next = markRecoveryStarted()
    expect(isRecovering()).toBe(true)
    next()
    expect(isRecovering()).toBe(false)
  })

  it('clearRecoveryStatus on an already-empty store does not notify', () => {
    let calls = 0
    subscribeToRecoveryStatus(() => { calls += 1 })

    clearRecoveryStatus() // already empty — must be a no-op
    expect(calls).toBe(0)

    markRecoveryStarted()
    expect(calls).toBe(1)
  })

  it('notifies subscribers on every transition', () => {
    const events: boolean[] = []
    const unsubscribe = subscribeToRecoveryStatus(() => {
      events.push(isRecovering())
    })

    const a = markRecoveryStarted() // notify: true
    const b = markRecoveryStarted() // notify: true
    a() // notify: still true (b outstanding)
    b() // notify: false

    expect(events).toEqual([true, true, true, false])

    unsubscribe()
    markRecoveryStarted()
    expect(events).toHaveLength(4) // no further notifications
  })

  it('multiple subscribers receive independent notifications', () => {
    let aCalls = 0
    let bCalls = 0
    const unA = subscribeToRecoveryStatus(() => { aCalls += 1 })
    const unB = subscribeToRecoveryStatus(() => { bCalls += 1 })

    const finish = markRecoveryStarted()
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(1)

    finish()
    expect(aCalls).toBe(2)
    expect(bCalls).toBe(2)

    unA()
    const finish2 = markRecoveryStarted()
    expect(aCalls).toBe(2) // unsubscribed
    expect(bCalls).toBe(3)

    unB()
    finish2()
  })
})
