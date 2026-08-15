/**
 * src/lib/idb/resilientIdb.ts — reopen-on-connection-loss wrapper.
 *
 * Repro target: Sentry FIXUP-WEB-6Q/6T — WebKit kills the IndexedDB server
 * connection while backgrounded; on resume the cached connection rejects
 * every transaction with InvalidStateError ("The database connection is
 * closing.") or UnknownError ("Connection to Indexed Database server lost").
 *
 * Contract under test:
 *   - connection-class errors → discard connection, reopen, retry EXACTLY once
 *   - non-connection errors (quota etc.) → no retry, propagate
 *   - failed opens never poison the cached connection
 *   - `close` event invalidates proactively
 *   - no path produces an unhandled rejection (vitest fails the run on any)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  createResilientIdbStore,
  isIdbConnectionError,
  promisifyIdbRequest,
  transactionDone,
} from '../../../src/lib/idb/resilientIdb'
import {
  FakeIdbEnv,
  connectionClosingError,
  connectionLostError,
} from '../../helpers/fakeIndexedDb'

let env: FakeIdbEnv

beforeEach(() => {
  env = new FakeIdbEnv()
  vi.stubGlobal('indexedDB', env.indexedDB)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeStore() {
  return createResilientIdbStore({ dbName: 'test-db', storeName: 'test-store' })
}

function readKey(run: ReturnType<typeof makeStore>, key: string) {
  return run('readonly', (store) => promisifyIdbRequest(store.get(key)))
}

describe('happy path', () => {
  it('round-trips a value and reuses the connection across operations', async () => {
    const run = makeStore()
    await run('readwrite', (store) => {
      store.put('value-1', 'k')
      return transactionDone(store.transaction)
    })
    const value = await readKey(run, 'k')
    expect(value).toBe('value-1')
    expect(env.openCalls).toBe(1)
  })
})

describe('reopen + retry on connection-class errors', () => {
  it('heals a sync InvalidStateError ("connection is closing") by reopening and retrying once', async () => {
    env.records.set('k', 'v')
    const run = makeStore()
    await readKey(run, 'k') // warm connection (open #1)

    env.throwOnNextTransaction(connectionClosingError())
    const value = await readKey(run, 'k')

    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
    // Dead connection was explicitly released.
    expect(env.dbs[0]?.closed).toBe(true)
  })

  it('heals an async UnknownError ("Connection to Indexed Database server lost") the same way', async () => {
    env.records.set('k', 'v')
    const run = makeStore()
    await readKey(run, 'k') // warm connection (open #1)

    env.failNextRequest(connectionLostError())
    const value = await readKey(run, 'k')

    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
  })

  it('retries EXACTLY once — a second connection failure propagates, then later calls recover', async () => {
    env.records.set('k', 'v')
    const run = makeStore()

    env.throwOnNextTransaction(connectionClosingError())
    env.throwOnNextTransaction(connectionClosingError())

    await expect(readKey(run, 'k')).rejects.toMatchObject({
      name: 'InvalidStateError',
    })
    // attempt 1 (open #1, tx #1 throws) + retry (open #2, tx #2 throws) — no third attempt.
    expect(env.openCalls).toBe(2)
    expect(env.txCalls).toBe(2)

    // The second failure also discarded its connection — next call self-heals.
    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(3)
  })

  it('reopens after the browser fires the close event', async () => {
    env.records.set('k', 'v')
    const run = makeStore()
    await readKey(run, 'k')
    expect(env.openCalls).toBe(1)

    env.dbs[0].simulateServerKill()
    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
  })

  it('retries a connection-class open failure once', async () => {
    env.records.set('k', 'v')
    env.failNextOpen(connectionLostError())
    const run = makeStore()

    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
  })
})

describe('non-connection errors are not retried', () => {
  it('propagates QuotaExceededError without retry and keeps the connection', async () => {
    env.records.set('k', 'v')
    const run = makeStore()
    await readKey(run, 'k') // warm (open #1, tx #1)

    env.failNextRequest(new DOMException('Quota exceeded', 'QuotaExceededError'))
    await expect(readKey(run, 'k')).rejects.toMatchObject({
      name: 'QuotaExceededError',
    })
    expect(env.openCalls).toBe(1)
    expect(env.txCalls).toBe(2)

    // Connection survives the non-connection error.
    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(1)
  })
})

describe('open failures never poison the cache', () => {
  it('a non-retryable open failure rejects, but the next operation reopens', async () => {
    env.records.set('k', 'v')
    env.failNextOpen(new DOMException('Access denied', 'SecurityError'))
    const run = makeStore()

    await expect(readKey(run, 'k')).rejects.toMatchObject({ name: 'SecurityError' })
    expect(env.openCalls).toBe(1)

    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
  })

  it('a blocked open rejects, but the next operation reopens', async () => {
    env.records.set('k', 'v')
    env.blockNextOpen()
    const run = makeStore()

    await expect(readKey(run, 'k')).rejects.toThrow(/blocked/)

    const value = await readKey(run, 'k')
    expect(value).toBe('v')
    expect(env.openCalls).toBe(2)
  })

  it('rejects without indexedDB in the environment, without retry storms', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const run = makeStore()
    await expect(readKey(run, 'k')).rejects.toThrow(/IndexedDB unavailable/)
  })
})

describe('onOpen hook', () => {
  it('runs after every (re)open — initial and post-kill', async () => {
    env.records.set('k', 'v')
    const onOpen = vi.fn()
    const run = createResilientIdbStore({
      dbName: 'test-db',
      storeName: 'test-store',
      onOpen,
    })

    await readKey(run, 'k')
    expect(onOpen).toHaveBeenCalledTimes(1)

    env.throwOnNextTransaction(connectionClosingError())
    await readKey(run, 'k')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('a throwing onOpen hook does not break the operation', async () => {
    env.records.set('k', 'v')
    const run = createResilientIdbStore({
      dbName: 'test-db',
      storeName: 'test-store',
      onOpen: () => {
        throw new Error('sweep exploded')
      },
    })
    const value = await readKey(run, 'k')
    expect(value).toBe('v')
  })
})

describe('write path (transactionDone)', () => {
  it('rejects when the transaction aborts, then heals connection-class aborts on retry', async () => {
    const run = makeStore()
    await run('readwrite', (store) => {
      store.put('v1', 'k')
      return transactionDone(store.transaction)
    })

    env.failNextRequest(connectionLostError())
    await run('readwrite', (store) => {
      store.put('v2', 'k')
      return transactionDone(store.transaction)
    })
    expect(env.records.get('k')).toBe('v2')
    expect(env.openCalls).toBe(2)
  })
})

describe('isIdbConnectionError', () => {
  it('matches the two connection-class DOMException names', () => {
    expect(isIdbConnectionError(connectionClosingError())).toBe(true)
    expect(isIdbConnectionError(connectionLostError())).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isIdbConnectionError(new DOMException('Quota exceeded', 'QuotaExceededError'))).toBe(false)
    expect(isIdbConnectionError(new Error('boom'))).toBe(false)
    expect(isIdbConnectionError(null)).toBe(false)
    expect(isIdbConnectionError(undefined)).toBe(false)
    expect(isIdbConnectionError('UnknownError')).toBe(false)
  })

  it('duck-types on name for cross-realm errors', () => {
    expect(isIdbConnectionError({ name: 'UnknownError', message: 'lost' })).toBe(true)
    expect(isIdbConnectionError({ name: 'InvalidStateError' })).toBe(true)
  })
})
