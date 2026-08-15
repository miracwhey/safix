/**
 * Upload Outbox — durable retry queue for media uploads that failed
 * because the device was offline or the network died mid-flight.
 *
 * Design
 *   - Each entry holds the original File blob plus the parameters needed
 *     to call uploadMediaFile (entity, role, owner). IndexedDB supports
 *     structured-clone of Blob/File, so the file body is persisted across
 *     reloads without base64 conversion.
 *   - One key per entry, plus an index key listing all entry IDs in
 *     enqueue order. Reads and writes go through `idb-keyval` so the
 *     storage layer stays a single dependency.
 *   - Subscribers are notified after every mutation. The UI uses the
 *     subscription to show pending counts and toast "X queued" feedback
 *     without polling.
 *
 * Quota
 *   IndexedDB on iOS Safari starts around 50 MB for non-installed PWAs.
 *   {@link MAX_OUTBOX_TOTAL_BYTES} is the soft cap enforced by `enqueueUpload`
 *   to keep the queue from being silently rejected by the storage layer.
 *
 * Status lifecycle
 *   pending → in_flight → (removed) on success
 *           → pending  with backoff on transient failure
 *           → failed    after maxRetries exceeded
 *
 * Failed entries stay in the outbox so the user can see and dismiss them —
 * we never delete data we cannot prove was uploaded successfully elsewhere.
 */

import { get, set, del, keys } from 'idb-keyval'
import type { MediaEntityType } from './mediaUploadService'
import { logError, logWarning } from '../observability'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Index key listing every entry ID in enqueue order. */
const INDEX_KEY = 'media:upload-outbox:index:v1'

/** Per-entry key prefix. */
const ENTRY_KEY_PREFIX = 'media:upload-outbox:entry:v1:'

export const MAX_OUTBOX_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB

export const DEFAULT_MAX_RETRIES = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutboxStatus = 'pending' | 'in_flight' | 'failed'

export type OutboxEntry = {
  id: string
  enqueuedAt: number
  retries: number
  maxRetries: number
  /** Earliest UTC ms timestamp for the next attempt (used by the runner). */
  nextAttemptAt: number
  status: OutboxStatus
  lastError: string | null
  /** Original picker file blob — persisted across reloads via IndexedDB. */
  file: File
  entityType: MediaEntityType
  entityId: string
  ownerUserId: string
  mediaRole: string
  /**
   * Stable idempotency key for the upload. Generated once at enqueue time and
   * passed through to uploadMediaFile on every drain attempt so retries
   * re-target the same storage object + media_uploads row instead of
   * duplicating them.
   */
  idempotencyKey: string
  /** Diagnostic only — descriptive label shown in UI badges. */
  label: string
}

export type EnqueueInput = Omit<
  OutboxEntry,
  'id' | 'enqueuedAt' | 'retries' | 'maxRetries' | 'nextAttemptAt' | 'status' | 'lastError'
> & {
  /** Override the default retry budget. */
  maxRetries?: number
}

type OutboxListener = (entries: OutboxEntry[]) => void

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function entryKey(id: string): string {
  return `${ENTRY_KEY_PREFIX}${id}`
}

async function readIndex(): Promise<string[]> {
  const value = (await get<string[]>(INDEX_KEY)) ?? []
  return Array.isArray(value) ? value : []
}

async function writeIndex(ids: string[]): Promise<void> {
  await set(INDEX_KEY, ids)
}

// ---------------------------------------------------------------------------
// Subscriber registry — local to this module so consumers stay decoupled.
// ---------------------------------------------------------------------------

const listeners = new Set<OutboxListener>()

async function notifyListeners(): Promise<void> {
  if (listeners.size === 0) return
  const entries = await listOutbox()
  for (const listener of listeners) {
    try {
      listener(entries)
    } catch (err) {
      logError('media.outbox_listener_failed', err)
    }
  }
}

export function subscribeToOutbox(listener: OutboxListener): () => void {
  listeners.add(listener)
  // Fire immediately so the new subscriber receives the current snapshot.
  void listOutbox().then((entries) => listener(entries))
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listOutbox(): Promise<OutboxEntry[]> {
  const ids = await readIndex()
  if (ids.length === 0) return []
  const entries = await Promise.all(
    ids.map((id) => get<OutboxEntry>(entryKey(id)))
  )
  return entries.filter((e): e is OutboxEntry => Boolean(e))
}

export async function getOutboxEntry(id: string): Promise<OutboxEntry | undefined> {
  return get<OutboxEntry>(entryKey(id))
}

export async function enqueueUpload(input: EnqueueInput): Promise<OutboxEntry> {
  const existing = await listOutbox()
  const existingTotal = existing.reduce((sum, e) => sum + e.file.size, 0)
  if (existingTotal + input.file.size > MAX_OUTBOX_TOTAL_BYTES) {
    throw new Error(
      'Offline-Upload-Speicher voll. Bitte stelle eine Internetverbindung her und versuche es erneut.'
    )
  }

  const id = crypto.randomUUID()
  const entry: OutboxEntry = {
    id,
    enqueuedAt: Date.now(),
    retries: 0,
    maxRetries: input.maxRetries ?? DEFAULT_MAX_RETRIES,
    nextAttemptAt: Date.now(),
    status: 'pending',
    lastError: null,
    file: input.file,
    entityType: input.entityType,
    entityId: input.entityId,
    ownerUserId: input.ownerUserId,
    mediaRole: input.mediaRole,
    idempotencyKey: input.idempotencyKey,
    label: input.label,
  }

  await set(entryKey(id), entry)
  const ids = await readIndex()
  await writeIndex([...ids, id])
  void notifyListeners()
  return entry
}

export async function updateOutboxEntry(
  id: string,
  patch: Partial<Pick<OutboxEntry, 'status' | 'retries' | 'nextAttemptAt' | 'lastError'>>
): Promise<OutboxEntry | undefined> {
  const current = await getOutboxEntry(id)
  if (!current) return undefined
  const next: OutboxEntry = { ...current, ...patch }
  await set(entryKey(id), next)
  void notifyListeners()
  return next
}

export async function removeOutboxEntry(id: string): Promise<void> {
  await del(entryKey(id))
  const ids = await readIndex()
  const filtered = ids.filter((existing) => existing !== id)
  if (filtered.length !== ids.length) {
    await writeIndex(filtered)
  }
  void notifyListeners()
}

/**
 * Removes every entry, including failed ones. Used by the "Clear queue"
 * action in settings or when the user signs out.
 */
export async function clearOutbox(): Promise<void> {
  const ids = await readIndex()
  await Promise.all(ids.map((id) => del(entryKey(id))))
  await writeIndex([])
  void notifyListeners()
}

/**
 * Sweep helper — drops any entry whose key the index has lost track of.
 * Should never trigger in normal operation; provides a safety net against
 * a half-finished mutation leaving an orphan record.
 */
export async function reconcileOutboxIndex(): Promise<void> {
  const indexed = new Set(await readIndex())
  const all = await keys()
  const orphans = all
    .map((k) => String(k))
    .filter((k) => k.startsWith(ENTRY_KEY_PREFIX))
    .map((k) => k.slice(ENTRY_KEY_PREFIX.length))
    .filter((id) => !indexed.has(id))
  if (orphans.length === 0) return
  logWarning('media.outbox_orphan_entries_dropped', { count: orphans.length })
  await Promise.all(orphans.map((id) => del(entryKey(id))))
}
