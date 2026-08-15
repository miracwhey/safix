import { describe, it, expect } from 'vitest'

/**
 * Validates the in-flight guard contract used in PayoutSetupScreen and PayoutReturnScreen.
 * The pattern: a boolean ref blocks re-entry into any async action until the
 * current one completes (success or error). Tests here verify the behavioral
 * contract independently of React rendering.
 */

function makeGuardedAction(impl: () => Promise<void>) {
  let inFlight = false
  return async function guarded() {
    if (inFlight) return
    inFlight = true
    try {
      await impl()
    } finally {
      inFlight = false
    }
  }
}

describe('in-flight guard contract', () => {
  it('does not execute impl concurrently when called twice before first resolves', async () => {
    const calls: number[] = []
    let resolve!: () => void

    const blocked = new Promise<void>((r) => { resolve = r })

    const action = makeGuardedAction(async () => {
      calls.push(Date.now())
      await blocked
    })

    const first = action()
    const second = action() // should be no-op — first is still in flight

    resolve()
    await first
    await second

    expect(calls).toHaveLength(1)
  })

  it('allows a second call after the first completes', async () => {
    const calls: number[] = []
    const action = makeGuardedAction(async () => {
      calls.push(1)
    })

    await action()
    await action()

    expect(calls).toHaveLength(2)
  })

  it('allows a second call after the first fails', async () => {
    const calls: number[] = []
    let firstCall = true

    const action = makeGuardedAction(async () => {
      calls.push(1)
      if (firstCall) {
        firstCall = false
        throw new Error('simulated failure')
      }
    })

    await action().catch(() => {}) // first call fails
    await action() // second call must succeed, not be blocked

    expect(calls).toHaveLength(2)
  })

  it('blocks additional calls while in-flight regardless of how many are attempted', async () => {
    const calls: number[] = []
    let resolve!: () => void
    const blocked = new Promise<void>((r) => { resolve = r })

    const action = makeGuardedAction(async () => {
      calls.push(1)
      await blocked
    })

    const p1 = action()
    void action() // no-op
    void action() // no-op
    void action() // no-op

    resolve()
    await p1

    expect(calls).toHaveLength(1)
  })

  it('syncStatus and resumeOnboarding block each other (shared guard)', async () => {
    // Simulates the shared actionInFlight ref used in PayoutReturnScreen:
    // both syncStatus and resumeOnboarding check the same ref, so they
    // cannot run concurrently with each other either.
    const calls: string[] = []
    let inFlight = false

    function makeSharedGuard(name: string, impl: () => Promise<void>) {
      return async function () {
        if (inFlight) return
        inFlight = true
        try {
          await impl()
        } finally {
          inFlight = false
        }
      }
    }

    let resolveSync!: () => void
    const blockedSync = new Promise<void>((r) => { resolveSync = r })

    const syncStatus = makeSharedGuard('sync', async () => {
      calls.push('sync')
      await blockedSync
    })

    const resumeOnboarding = makeSharedGuard('resume', async () => {
      calls.push('resume')
    })

    const p1 = syncStatus()
    void resumeOnboarding() // must be blocked — sync is in flight

    resolveSync()
    await p1

    expect(calls).toEqual(['sync']) // resume was blocked
  })
})
