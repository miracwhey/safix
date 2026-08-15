/**
 * Chat-Härtung Cluster 1 — Persistent media outbox (IndexedDB).
 *
 * WhatsApp-Semantik: a media send (voice / photo / document / video) survives
 * app-kill, reload, and network loss. The optimistic bubble is client-only
 * truth; this outbox is the durable record that keeps a queued/failed send
 * alive so the drain-worker (see chatWorkflow.ts) can retry it on reconnect —
 * exactly the persistence layer the text path already has via
 * `pendingMutationStore`.
 *
 * The *blob* itself stays in `recordingCache` (voice) / `attachmentPendingCache`
 * (photo/document/video), keyed by the same `clientMessageId`. This store only
 * carries the metadata the drain-worker needs to re-run the upload + idempotent
 * RPC and to rebuild the optimistic bubble on rehydration.
 *
 * One entry per in-flight or failed send, keyed by `clientMessageId`. Stale
 * entries (> 7 days) are swept on first open — same policy as the blob caches.
 *
 * Resilience mirrors attachmentPendingCache/recordingCache: every function
 * tolerates absent/broken IDB (private mode, quota, WebKit connection kill)
 * by resolving void/null/[] and logging — it NEVER rejects. Connection
 * handling lives in src/lib/idb/resilientIdb.ts.
 */

import { logWarning } from '../observability'
import {
  createResilientIdbStore,
  promisifyIdbRequest,
  transactionDone,
} from '../idb/resilientIdb'
import type { ChatChannelType } from './types'

const DB_NAME = 'fixup_media_outbox'
const DB_VERSION = 1
const STORE = 'outbox'
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export type MediaOutboxKind = 'voice' | 'image' | 'document' | 'video'
export type MediaOutboxState = 'queued' | 'failed'

/**
 * Metadata the drain-worker needs to rebuild the optimistic bubble AND re-run
 * the send. Only the fields that differ per media kind live here; the blob is
 * read from the blob cache at drain time.
 */
export interface MediaOutboxMetadata {
  caption?: string | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  /** Extension hint for voice/video uploads (m4a, aac, webm, mp4). */
  fileExtension?: string | null
  /** Poster path once the video upload produced one (diagnostic only). */
  posterStoragePath?: string | null
}

export interface MediaOutboxRecord {
  clientMessageId: string
  threadId: string
  channelType: ChatChannelType
  providerId: string | null
  kind: MediaOutboxKind
  fileName: string
  mimeType: string
  /** Last-known deterministic storage path. '' until an upload attempt set it —
   *  not load-bearing (RPC idempotency keys on clientMessageId). */
  storagePath: string
  metadata: MediaOutboxMetadata
  createdAt: number
  /** Upload attempts so far — drives the backoff schedule in the drain-worker. */
  attempts: number
  lastAttemptAt: number | null
  state: MediaOutboxState
}

/**
 * Window event the repository / session-resume dispatch to nudge the
 * drain-worker (which lives in the workflow layer). Decouples the layers: the
 * repository never imports the workflow, and the drain-worker subscribes to a
 * plain DOM event (WKWebView-safe). Both sides share this constant to avoid a
 * typo drift.
 */
export const CHAT_OUTBOX_DRAIN_EVENT = 'fixup:chat-drain-outbox'

/** Fire-and-forget: ask the drain-worker to flush the media outbox now. */
export function requestOutboxDrain(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    window.dispatchEvent(new Event(CHAT_OUTBOX_DRAIN_EVENT))
  } catch {
    // Non-DOM env / CustomEvent unsupported — the timer/online triggers cover it.
  }
}

const runInStore = createResilientIdbStore({
  dbName: DB_NAME,
  storeName: STORE,
  version: DB_VERSION,
  upgrade: (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'clientMessageId' })
    }
  },
  // Idempotent — the extra sweeps after a WebKit reconnect are harmless.
  onOpen: (db) => {
    void sweepStaleRecords(db)
  },
})

function sweepStaleRecords(db: IDBDatabase): Promise<void> {
  const cutoff = Date.now() - STALE_AFTER_MS
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(); return }
        const entry = cursor.value as MediaOutboxRecord
        if (entry.createdAt < cutoff) cursor.delete()
        cursor.continue()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Insert or replace an outbox record. Called BEFORE the first upload attempt
 * (state 'queued') so an app-kill mid-upload leaves a durable record behind.
 */
export async function enqueue(record: MediaOutboxRecord): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await runInStore('readwrite', (store) => {
      store.put(record)
      return transactionDone(store.transaction)
    })
  } catch (err) {
    logWarning('media.outbox.enqueue_failed', {
      clientMessageId: record.clientMessageId,
      error: String(err),
    })
  }
}

export async function get(clientMessageId: string): Promise<MediaOutboxRecord | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const result = await runInStore('readonly', (store) =>
      promisifyIdbRequest(store.get(clientMessageId)),
    )
    return (result as MediaOutboxRecord | undefined) ?? null
  } catch (err) {
    logWarning('media.outbox.get_failed', { clientMessageId, error: String(err) })
    return null
  }
}

export async function listAll(): Promise<MediaOutboxRecord[]> {
  if (typeof indexedDB === 'undefined') return []
  try {
    const result = await runInStore<MediaOutboxRecord[]>('readonly', (store) => {
      return new Promise<MediaOutboxRecord[]>((resolve, reject) => {
        const out: MediaOutboxRecord[] = []
        const cursorReq = store.openCursor()
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (cursor) {
            out.push(cursor.value as MediaOutboxRecord)
            cursor.continue()
          } else {
            resolve(out)
          }
        }
        // Reject so a connection-class cursor failure goes through the
        // wrapper's reopen+retry once; a final failure resolves [] below.
        cursorReq.onerror = () =>
          reject(cursorReq.error ?? new Error('media outbox cursor failed'))
      })
    })
    return result ?? []
  } catch (err) {
    logWarning('media.outbox.list_failed', { error: String(err) })
    return []
  }
}

export async function listForThread(threadId: string): Promise<MediaOutboxRecord[]> {
  const all = await listAll()
  return all.filter((r) => r.threadId === threadId)
}

/** Read-modify-write helper inside a single transaction. Best-effort. */
async function mutate(
  clientMessageId: string,
  apply: (record: MediaOutboxRecord) => MediaOutboxRecord,
  logKey: string,
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await runInStore('readwrite', (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.get(clientMessageId)
        req.onsuccess = () => {
          const existing = req.result as MediaOutboxRecord | undefined
          if (!existing) { resolve(); return }
          const put = store.put(apply(existing))
          put.onsuccess = () => resolve()
          put.onerror = () => reject(put.error ?? new Error('media outbox put failed'))
        }
        req.onerror = () => reject(req.error ?? new Error('media outbox get failed'))
      })
    })
  } catch (err) {
    logWarning(logKey, { clientMessageId, error: String(err) })
  }
}

/** Records a fresh upload attempt: bumps `attempts`, stamps `lastAttemptAt`,
 *  and keeps the record `queued` (a transient failure never terminalises). */
export async function markAttempt(clientMessageId: string): Promise<void> {
  await mutate(
    clientMessageId,
    (r) => ({ ...r, attempts: r.attempts + 1, lastAttemptAt: Date.now(), state: 'queued' }),
    'media.outbox.mark_attempt_failed',
  )
}

/** Terminalises a record (permanent, non-retryable failure) → red bubble. */
export async function markFailed(clientMessageId: string): Promise<void> {
  await mutate(
    clientMessageId,
    (r) => ({ ...r, state: 'failed' }),
    'media.outbox.mark_failed_failed',
  )
}

/** Persists the storage path once an upload attempt succeeded, so discard can
 *  clean the orphan blob even when the send later fails permanently (e.g. the
 *  RPC is rejected after the bytes already landed). */
export async function setUploadedPath(
  clientMessageId: string,
  storagePath: string,
  posterStoragePath?: string | null,
): Promise<void> {
  await mutate(
    clientMessageId,
    (r) => ({
      ...r,
      storagePath,
      metadata: {
        ...r.metadata,
        posterStoragePath: posterStoragePath ?? r.metadata.posterStoragePath ?? null,
      },
    }),
    'media.outbox.set_uploaded_path_failed',
  )
}

/** Resets a `failed` record back to `queued` for a user-initiated retry. */
export async function requeue(clientMessageId: string): Promise<void> {
  await mutate(
    clientMessageId,
    (r) => ({ ...r, state: 'queued' }),
    'media.outbox.requeue_failed',
  )
}

export async function remove(clientMessageId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await runInStore('readwrite', (store) => {
      store.delete(clientMessageId)
      return transactionDone(store.transaction)
    })
  } catch (err) {
    logWarning('media.outbox.remove_failed', { clientMessageId, error: String(err) })
  }
}
