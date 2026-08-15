/**
 * Block D Slice B — Attachment-pending IndexedDB cache.
 *
 * Mirrors recordingCache.ts but for image / document File blobs so an
 * app-kill between the optimistic insert and the completed upload does not
 * lose the user's file. Failed-bubble retry reads from here.
 *
 * One entry per in-flight or failed send, keyed by clientMessageId.
 * Stale entries (> 7 days) are swept on first open — same policy as voice.
 *
 * Connection handling lives in src/lib/idb/resilientIdb.ts: WebKit kills the
 * IDB server connection while backgrounded (Sentry FIXUP-WEB-6Q/6T); the
 * wrapper reopens + retries once so this cache no longer degrades into a
 * silent no-op for the rest of the page lifetime. Public semantics are
 * unchanged: every function tolerates absent/broken IDB by resolving
 * void/null and logging — it never rejects.
 */

import { logWarning } from '../observability'
import {
  createResilientIdbStore,
  promisifyIdbRequest,
  transactionDone,
} from '../idb/resilientIdb'
import type { ChatChannelType } from './types'

const DB_NAME = 'fixup_attachment_pending'
const DB_VERSION = 1
const STORE = 'attachments'
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface CachedAttachment {
  clientMessageId: string
  threadId: string
  channelType: ChatChannelType
  /** Original File blob — used to re-run the upload on retry. */
  blobData: Blob
  /** Original filename for display + extension derivation. */
  fileName: string
  mimeType: string
  sizeBytes: number
  kind: 'image' | 'document' | 'video'
  caption?: string | null
  /** Authoritative duration for video entries — used on retry to pass to sendVideoMessageWorkflow. */
  durationMs?: number | null
  createdAt: number
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
  // Runs after every (re)open — idempotent, so the extra sweeps after a
  // WebKit connection kill are harmless.
  onOpen: (db) => {
    void sweepStaleAttachments(db)
  },
})

async function sweepStaleAttachments(db: IDBDatabase): Promise<void> {
  const cutoff = Date.now() - STALE_AFTER_MS
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(); return }
        const entry = cursor.value as CachedAttachment
        if (entry.createdAt < cutoff) cursor.delete()
        cursor.continue()
      }
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

export async function cacheAttachment(entry: CachedAttachment): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await runInStore('readwrite', (store) => {
      store.put(entry)
      return transactionDone(store.transaction)
    })
  } catch (err) {
    logWarning('attachment.cache.put_failed', {
      clientMessageId: entry.clientMessageId,
      error: String(err),
    })
  }
}

export async function getCachedAttachment(clientMessageId: string): Promise<CachedAttachment | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const result = await runInStore('readonly', (store) =>
      promisifyIdbRequest(store.get(clientMessageId)),
    )
    return (result as CachedAttachment | undefined) ?? null
  } catch (err) {
    logWarning('attachment.cache.get_failed', {
      clientMessageId,
      error: String(err),
    })
    return null
  }
}

export async function clearCachedAttachment(clientMessageId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    await runInStore('readwrite', (store) => {
      store.delete(clientMessageId)
      return transactionDone(store.transaction)
    })
  } catch (err) {
    logWarning('attachment.cache.delete_failed', {
      clientMessageId,
      error: String(err),
    })
  }
}
