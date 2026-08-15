/**
 * Resilient IndexedDB connection wrapper.
 *
 * Why this exists (Sentry FIXUP-WEB-6Q / FIXUP-WEB-6T):
 *   iOS/WebKit kills the IndexedDB server connection while the app is
 *   backgrounded (thermal pressure, memory reclaim). On resume, the page's
 *   cached `IDBDatabase` handle is dead and every transaction rejects with
 *     - InvalidStateError: "Failed to execute transaction on IDBDatabase:
 *       The database connection is closing." (sync throw from db.transaction)
 *     - UnknownError: "Connection to Indexed Database server lost."
 *       (async rejection from in-flight requests/transactions)
 *   Both libraries we sit under cache their connection forever (idb-keyval
 *   only resets on the `close` event — which Safari does not reliably fire;
 *   our raw caches never reset at all), so a single kill turned into either
 *   unhandled rejections or a silent no-op cache for the rest of the page
 *   lifetime.
 *
 * Strategy:
 *   - Cache exactly one connection per store, opened lazily.
 *   - On a connection-class error (InvalidStateError / UnknownError) the
 *     wrapper discards the dead connection, reopens, and retries the
 *     transaction EXACTLY once. Idempotent callbacks only (get/put/delete/
 *     cursor reads) — every consumer in this repo satisfies that.
 *   - A failed open never poisons the cache: the cached promise clears
 *     itself so the next operation retries the open.
 *   - `db.onclose` proactively invalidates the cache when WebKit does fire it.
 *   - The wrapper itself never produces unhandled rejections; after the
 *     single retry, errors propagate to the caller, which decides whether to
 *     swallow (best-effort caches) or surface (capture cache natural-failure
 *     path, e.g. QuotaExceededError).
 *
 * The runner signature is structurally identical to idb-keyval's `UseStore`,
 * so it can be passed as the `customStore` argument of idb-keyval's
 * get/set/del/keys — see localCaptureCache.ts.
 *
 * Zero project imports on purpose: keeps this importable from any layer
 * (chat, spatial, media) without pulling barrels or session.ts (see
 * .claude/build-gaps.md on barrel import traps).
 */

export interface ResilientIdbStoreConfig {
  dbName: string
  storeName: string
  /**
   * Omit to open at the database's current version (idb-keyval-compatible —
   * never triggers a version change on an existing DB).
   */
  version?: number
  /**
   * Schema setup, runs inside `onupgradeneeded`. Default: create
   * `storeName` with out-of-line keys (idb-keyval's layout).
   */
  upgrade?: (db: IDBDatabase) => void
  /**
   * Runs after every successful (re)open — e.g. stale-entry sweeps.
   * Best-effort: errors thrown here are swallowed (the hook must do its own
   * logging) so a broken sweep can never block the cache itself.
   */
  onOpen?: (db: IDBDatabase) => void
}

/**
 * Structurally identical to idb-keyval's `UseStore` type, so instances can be
 * passed as the `customStore` parameter of idb-keyval functions.
 */
export type ResilientIdbRun = <T>(
  txMode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>,
) => Promise<T>

/**
 * Connection-class error names. Matched by name only — the human-readable
 * messages differ across WebKit versions, and a single bounded retry on a
 * non-connection InvalidStateError is harmless (it fails identically and the
 * error still propagates).
 */
const CONNECTION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'InvalidStateError',
  'UnknownError',
])

/**
 * True for errors that indicate the IndexedDB server connection is dead and
 * a reopen+retry can heal the operation. Duck-typed on `name` because
 * DOMException identity is not stable across realms/environments.
 */
export function isIdbConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && CONNECTION_ERROR_NAMES.has(name)
}

/** Promisify a single IDBRequest. Rejects with the request's error. */
export function promisifyIdbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * Resolves when the transaction commits; rejects on abort/error. Use for
 * write paths that must observe the commit (idb-keyval's `set` semantics).
 */
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed'))
  })
}

/**
 * Create a lazily-opened, self-healing store runner for one DB/objectStore
 * pair. The returned function opens (or reuses) the connection, runs the
 * callback inside a fresh transaction, and retries exactly once on
 * connection-class failures.
 */
export function createResilientIdbStore(
  config: ResilientIdbStoreConfig,
): ResilientIdbRun {
  let dbPromise: Promise<IDBDatabase> | null = null

  /**
   * Drop the cached connection iff it is still the one the caller used —
   * a concurrent operation may already have swapped in a fresh, healthy
   * connection that must not be closed.
   */
  const discardConnection = (stale: Promise<IDBDatabase>): void => {
    if (dbPromise !== stale) return
    dbPromise = null
    stale.then(
      (db) => {
        try {
          db.close()
        } catch {
          // Already closed/closing — nothing to release.
        }
      },
      () => {
        // Open had already failed — nothing to close.
      },
    )
  }

  const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    const opened = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error(`IndexedDB unavailable (db: ${config.dbName})`))
        return
      }
      let request: IDBOpenDBRequest
      try {
        request =
          config.version === undefined
            ? indexedDB.open(config.dbName)
            : indexedDB.open(config.dbName, config.version)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      // `onblocked` may fire before a late `onsuccess`; track settlement so
      // the promise settles once and a post-rejection success closes the
      // orphaned connection instead of leaking it.
      let settled = false
      request.onupgradeneeded = () => {
        const db = request.result
        if (config.upgrade) {
          config.upgrade(db)
        } else if (!db.objectStoreNames.contains(config.storeName)) {
          db.createObjectStore(config.storeName)
        }
      }
      request.onsuccess = () => {
        const db = request.result
        if (settled) {
          try {
            db.close()
          } catch {
            // noop
          }
          return
        }
        settled = true
        // Safari fires `close` when it kills the connection server-side —
        // when it does, invalidate immediately instead of waiting for the
        // next operation to fail.
        db.onclose = () => discardConnection(opened)
        if (config.onOpen) {
          try {
            config.onOpen(db)
          } catch {
            // Best-effort hook — must never block the open.
          }
        }
        resolve(db)
      }
      request.onerror = () => {
        if (settled) return
        settled = true
        reject(
          request.error ??
            new Error(`IndexedDB open failed (db: ${config.dbName})`),
        )
      }
      request.onblocked = () => {
        if (settled) return
        settled = true
        reject(new Error(`IndexedDB open blocked (db: ${config.dbName})`))
      }
    })
    dbPromise = opened
    // A failed open must not poison the cache (idb-keyval keeps the rejected
    // promise forever) — clear it so the next operation retries the open.
    // This handler also guarantees the rejection is never unhandled when no
    // operation is currently awaiting it.
    opened.catch(() => {
      if (dbPromise === opened) dbPromise = null
    })
    return opened
  }

  const attempt = async <T>(
    txMode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => T | PromiseLike<T>,
  ): Promise<T> => {
    const opened = openDb()
    try {
      const db = await opened
      // db.transaction throws a synchronous InvalidStateError when the
      // connection is closing/closed — caught here like async failures.
      const tx = db.transaction(config.storeName, txMode)
      return await callback(tx.objectStore(config.storeName))
    } catch (err) {
      if (isIdbConnectionError(err)) discardConnection(opened)
      throw err
    }
  }

  return async <T>(
    txMode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => T | PromiseLike<T>,
  ): Promise<T> => {
    try {
      return await attempt(txMode, callback)
    } catch (err) {
      if (!isIdbConnectionError(err)) throw err
      // Connection-class failure: the dead connection was discarded above —
      // reopen and retry EXACTLY once. A second failure propagates.
      return await attempt(txMode, callback)
    }
  }
}
