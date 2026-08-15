/**
 * Controllable in-memory IndexedDB fake for resilience tests.
 *
 * Implements exactly the IDB surface that src/lib/idb/resilientIdb.ts and its
 * consumers touch: open / transaction / objectStore / get / put / delete /
 * getAllKeys / openCursor — with injectable failures that mirror the real
 * WebKit connection-kill errors (DOMException names + messages) behind
 * Sentry FIXUP-WEB-6Q/6T:
 *   - InvalidStateError "Failed to execute transaction on IDBDatabase:
 *     The database connection is closing." (sync throw from db.transaction)
 *   - UnknownError "Connection to Indexed Database server lost."
 *     (async request/transaction failure)
 *
 * All callbacks fire via queueMicrotask — never synchronously — matching the
 * event-loop behaviour the production wrapper is written against.
 */

type Handler = (() => void) | null

export class FakeIdbRequest {
  onsuccess: Handler = null
  onerror: Handler = null
  result: unknown = undefined
  error: Error | null = null
  private settled = false
  private readonly onSettled: () => void

  constructor(onSettled: () => void) {
    this.onSettled = onSettled
  }

  /** Fire onsuccess; `final: false` keeps the request open (cursor steps). */
  succeed(result: unknown, final = true): void {
    this.result = result
    this.onsuccess?.()
    if (final && !this.settled) {
      this.settled = true
      this.onSettled()
    }
  }

  fail(error: Error): void {
    this.error = error
    this.onerror?.()
    if (!this.settled) {
      this.settled = true
      this.onSettled()
    }
  }
}

class FakeIdbTransaction {
  oncomplete: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  error: Error | null = null
  private pending = 0
  private registered = 0
  private failure: Error | null = null
  private readonly env: FakeIdbEnv
  private readonly storeName: string

  constructor(env: FakeIdbEnv, storeName: string) {
    this.env = env
    this.storeName = storeName
  }

  objectStore(_name: string): FakeIdbObjectStore {
    return new FakeIdbObjectStore(this.env, this)
  }

  registerRequest(): FakeIdbRequest {
    this.pending += 1
    this.registered += 1
    return new FakeIdbRequest(() => this.requestSettled())
  }

  noteFailure(error: Error): void {
    this.failure = error
  }

  private requestSettled(): void {
    this.pending -= 1
    if (this.pending > 0) return
    queueMicrotask(() => {
      if (this.pending > 0) return
      if (this.failure) {
        this.error = this.failure
        this.onabort?.()
        this.onerror?.()
      } else {
        this.oncomplete?.()
      }
    })
  }
}

interface FakeCursor {
  key: IDBValidKey
  value: unknown
  continue: () => void
  delete: () => void
}

class FakeIdbObjectStore {
  private readonly env: FakeIdbEnv
  private readonly tx: FakeIdbTransaction

  constructor(env: FakeIdbEnv, tx: FakeIdbTransaction) {
    this.env = env
    this.tx = tx
  }

  get transaction(): FakeIdbTransaction {
    return this.tx
  }

  get(key: IDBValidKey): FakeIdbRequest {
    return this.dispatch((req) => req.succeed(this.env.records.get(key)))
  }

  put(value: unknown, key?: IDBValidKey): FakeIdbRequest {
    return this.dispatch((req) => {
      const resolvedKey =
        key ??
        (this.env.keyPath
          ? ((value as Record<string, IDBValidKey>)[this.env.keyPath])
          : undefined)
      if (resolvedKey === undefined) {
        const err = new DOMException('No key provided', 'DataError')
        this.tx.noteFailure(err)
        req.fail(err)
        return
      }
      this.env.records.set(resolvedKey, value)
      req.succeed(resolvedKey)
    })
  }

  delete(key: IDBValidKey): FakeIdbRequest {
    return this.dispatch((req) => {
      this.env.records.delete(key)
      req.succeed(undefined)
    })
  }

  getAllKeys(): FakeIdbRequest {
    return this.dispatch((req) => req.succeed(Array.from(this.env.records.keys())))
  }

  openCursor(): FakeIdbRequest {
    return this.dispatch((req) => {
      const entries = Array.from(this.env.records.entries())
      let i = 0
      const step = (): void => {
        if (i < entries.length) {
          const [key, value] = entries[i]
          const cursor: FakeCursor = {
            key,
            value,
            continue: () => {
              i += 1
              queueMicrotask(step)
            },
            delete: () => {
              this.env.records.delete(key)
            },
          }
          req.succeed(cursor, false)
        } else {
          req.succeed(null, true)
        }
      }
      step()
    })
  }

  /** Async-dispatch a request, consuming one queued failure if present. */
  private dispatch(run: (req: FakeIdbRequest) => void): FakeIdbRequest {
    const req = this.tx.registerRequest()
    const failure = this.env.shiftRequestFailure()
    queueMicrotask(() => {
      if (failure) {
        this.tx.noteFailure(failure)
        req.fail(failure)
        return
      }
      run(req)
    })
    return req
  }
}

export class FakeIdbDatabase {
  onclose: Handler = null
  closed = false
  private readonly env: FakeIdbEnv
  readonly objectStoreNames = {
    contains: (_name: string) => true,
  }

  constructor(env: FakeIdbEnv) {
    this.env = env
  }

  transaction(storeName: string, _mode?: IDBTransactionMode): FakeIdbTransaction {
    this.env.txCalls += 1
    const queued = this.env.shiftTransactionThrow()
    if (queued) throw queued
    if (this.closed) {
      throw new DOMException(
        'Failed to execute transaction on IDBDatabase: The database connection is closing.',
        'InvalidStateError',
      )
    }
    return new FakeIdbTransaction(this.env, storeName)
  }

  close(): void {
    this.closed = true
  }

  /** Simulate WebKit killing the connection server-side. */
  simulateServerKill(): void {
    this.closed = true
    this.onclose?.()
  }
}

class FakeIdbOpenRequest {
  onsuccess: Handler = null
  onerror: Handler = null
  onupgradeneeded: Handler = null
  onblocked: Handler = null
  result!: FakeIdbDatabase
  error: Error | null = null
}

export class FakeIdbEnv {
  openCalls = 0
  txCalls = 0
  records = new Map<IDBValidKey, unknown>()
  dbs: FakeIdbDatabase[] = []
  /** keyPath used by put() when no explicit key is given (in-line keys). */
  keyPath: string | null = null

  private openFailures: Error[] = []
  private blockedOpens = 0
  private txThrows: Error[] = []
  private requestFailures: Error[] = []
  private upgradeNeeded = true

  readonly indexedDB = {
    open: (_name: string, _version?: number): FakeIdbOpenRequest => {
      this.openCalls += 1
      const req = new FakeIdbOpenRequest()
      const failure = this.openFailures.shift()
      const blocked = this.blockedOpens > 0
      if (blocked) this.blockedOpens -= 1
      queueMicrotask(() => {
        if (failure) {
          req.error = failure
          req.onerror?.()
          return
        }
        if (blocked) {
          req.onblocked?.()
          return
        }
        const db = new FakeIdbDatabase(this)
        req.result = db
        if (this.upgradeNeeded) {
          this.upgradeNeeded = false
          req.onupgradeneeded?.()
        }
        this.dbs.push(db)
        req.onsuccess?.()
      })
      return req
    },
  } as unknown as IDBFactory

  failNextOpen(error: Error): void {
    this.openFailures.push(error)
  }

  blockNextOpen(): void {
    this.blockedOpens += 1
  }

  throwOnNextTransaction(error: Error): void {
    this.txThrows.push(error)
  }

  failNextRequest(error: Error): void {
    this.requestFailures.push(error)
  }

  shiftTransactionThrow(): Error | undefined {
    return this.txThrows.shift()
  }

  shiftRequestFailure(): Error | undefined {
    return this.requestFailures.shift()
  }
}

/** Real WebKit error: synchronous throw from db.transaction after a kill. */
export function connectionClosingError(): DOMException {
  return new DOMException(
    'Failed to execute transaction on IDBDatabase: The database connection is closing.',
    'InvalidStateError',
  )
}

/** Real WebKit error: async rejection once the IDB server process is gone. */
export function connectionLostError(): DOMException {
  return new DOMException(
    'Connection to Indexed Database server lost. Refresh the page to try again',
    'UnknownError',
  )
}

/** Flush queued microtasks + macrotask so all fake callbacks have fired. */
export async function flushFakeIdb(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
