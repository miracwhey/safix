/**
 * Block D Slice 3 — Voice-recording IndexedDB cache.
 *
 * A recorded blob is persisted **before** the optimistic chat-message insert
 * so a crash, app-kill, or reload between recording-stop and successful upload
 * does not lose the user's content. Failed-upload retry reads the same entry.
 *
 * Storage-key pattern: `<clientMessageId>` (the same UUID that becomes
 * chat_messages.client_message_id). One entry per pending voice note.
 *
 * Safety:
 *   - No PII: blob + thread-scoping ids only.
 *   - Best-effort: every operation tolerates absent IDB (private mode, quota,
 *     non-browser env) by returning null/void and logging via observability.
 *   - Stale-sweep on init removes entries older than 7 days to bound size.
 *   - Connection handling lives in src/lib/idb/resilientIdb.ts: WebKit kills
 *     the IDB server connection while backgrounded (Sentry FIXUP-WEB-6Q/6T);
 *     the wrapper reopens + retries once so this cache no longer degrades
 *     into a silent no-op for the rest of the page lifetime.
 */

import { logWarning } from '../../observability'
import {
  createResilientIdbStore,
  promisifyIdbRequest,
} from '../../idb/resilientIdb'
import type { CachedVoiceRecording } from './types'

const DB_NAME = 'fixup_voice_recordings'
const DB_VERSION = 1
const STORE = 'recordings'
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const runInStore = createResilientIdbStore({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'clientMessageId' })
    }
  },
})

/**
 * Runs `run` against the recordings store. Requests are promisified; raw
 * Promises pass through. Never rejects — any failure (absent IDB, quota,
 * connection loss that survived the wrapper's single retry) resolves `null`
 * and logs, preserving the original best-effort contract.
 */
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return runInStore<T>(mode, (store) => {
    const result = run(store)
    return result instanceof Promise ? result : promisifyIdbRequest(result)
  }).catch((err) => {
    logWarning('voice.cache.op_failed', { error: String(err) })
    return null
  })
}

export async function cacheVoiceRecording(entry: CachedVoiceRecording): Promise<void> {
  await withStore('readwrite', (store) => store.put(entry))
}

export async function readVoiceRecording(clientMessageId: string): Promise<CachedVoiceRecording | null> {
  const value = await withStore<CachedVoiceRecording | undefined>('readonly', (store) =>
    store.get(clientMessageId),
  )
  return value ?? null
}

export async function clearVoiceRecording(clientMessageId: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(clientMessageId))
}

export async function listPendingVoiceRecordings(): Promise<CachedVoiceRecording[]> {
  const result = await withStore<CachedVoiceRecording[]>('readonly', (store) => {
    return new Promise<CachedVoiceRecording[]>((resolve, reject) => {
      const out: CachedVoiceRecording[] = []
      const cursorReq = store.openCursor()
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          out.push(cursor.value as CachedVoiceRecording)
          cursor.continue()
        } else {
          resolve(out)
        }
      }
      // Reject (instead of resolving a partial list) so a connection-class
      // cursor failure goes through the wrapper's reopen+retry once; a final
      // failure still resolves null → [] via withStore's catch.
      cursorReq.onerror = () =>
        reject(cursorReq.error ?? new Error('voice cache cursor failed'))
    })
  })
  return result ?? []
}

/**
 * Removes cache entries older than STALE_AFTER_MS. Call once at app boot
 * (idempotent, best-effort). Prevents IDB growth when a user repeatedly
 * abandons partial recordings.
 */
export async function sweepStaleVoiceRecordings(now: number = Date.now()): Promise<void> {
  const all = await listPendingVoiceRecordings()
  const stale = all.filter((entry) => now - entry.createdAt > STALE_AFTER_MS)
  for (const entry of stale) {
    await clearVoiceRecording(entry.clientMessageId)
  }
}
