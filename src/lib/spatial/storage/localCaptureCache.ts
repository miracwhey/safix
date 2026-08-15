/**
 * Spatial · Lane 2.5 · Stream A · Local Capture Cache (IndexedDB)
 *
 * Durable pre-upload cache for RoomPlan USDZ captures. Survives reloads,
 * iOS-App-Background-Kills, lost-network, and TUS-flake by persisting the
 * raw USDZ Blob alongside enough metadata to resume the upload against the
 * same `scan_id` (idempotent — content-addressed dedup at the storage layer).
 *
 * Why a cache, not just a retry queue:
 *   - `captureScan()` already creates the scans row before the upload, so the
 *     server-side anchor is durable from step 1. What we lose on a crash is
 *     the in-memory `Blob` reference. This module keeps that blob alive.
 *   - The TUS upload itself is resumable, but only while the `Upload` instance
 *     lives in the page tab. Once the tab is gone, we need a fresh `Upload`
 *     against the same path — and that fresh call only works if we still have
 *     the source Blob bytes locally. IndexedDB gives us that with zero extra
 *     server round-trip.
 *
 * Lifecycle of one entry:
 *   captureScan() starts ─→ cacheCapture()    status='pending'
 *   uploadScanAsset() ok ─→ markUploaded()    status='uploaded'  (TTL: 7d)
 *   uploadScanAsset() fail → markFailed(err)  status='failed'
 *   iOS app-kill / dismiss → markAborted()    status='aborted'  (via bridge)
 *
 * `pending`, `failed`, and `aborted` are all *resumable* — listResumable()
 * surfaces them to the ResumePendingScanSheet at Hub-Mount. `uploaded` rows
 * stick around for 7 days as a forensics + Sentry-correlation aid; the
 * 7-day window is short enough that we never bump into the soft quota cap.
 *
 * Quota: IndexedDB on iOS Safari starts around 50 MB for PWAs (more once
 * installed via Capacitor). RoomPlan USDZ files are typically 5-50 MB each.
 * MAX_CACHE_TOTAL_BYTES soft-caps the cache at 200 MB; cacheCapture() drops
 * the oldest `uploaded` entry FIFO to make room before refusing.
 *
 * Concurrency: idb-keyval reads/writes are serialised by the underlying
 * IndexedDB transaction, so two captures in quick succession both land. The
 * index-write happens AFTER the entry-write so a crash mid-pair leaves a
 * recoverable orphan (reconcileIndex() sweeps those).
 *
 * Mirrors `src/lib/media/uploadOutbox.ts` patterns (constants, listeners,
 * reconcile) so the two queues stay shape-coherent for ops.
 */

import { get, set, del, keys } from 'idb-keyval'

import { createResilientIdbStore } from '../../idb/resilientIdb'
import { logError, logInfo, logWarning } from '../../observability'
import type { ScanDeviceMeta } from '../types'

// ──────────────────────────────────────────────────────────────────────────────
// Connection — resilient against iOS background connection kills
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Self-healing connection for the shared idb-keyval database, passed as the
 * `customStore` argument to every idb-keyval call below.
 *
 * Why: WebKit kills the IndexedDB server connection while the app is
 * backgrounded; idb-keyval's default store caches its connection and only
 * resets on the (unreliably fired) `close` event, so every later operation
 * rejected unhandled with InvalidStateError ("connection is closing") or
 * UnknownError ("Connection to Indexed Database server lost") — Sentry
 * FIXUP-WEB-6Q / FIXUP-WEB-6T on /customer/spatial/list. The wrapper reopens
 * and retries exactly once on those connection-class errors.
 *
 * Same DB + object store as idb-keyval's default ('keyval-store'/'keyval'),
 * so all existing cached entries stay addressable and other idb-keyval
 * consumers keep working against the same data.
 */
const captureCacheStore = createResilientIdbStore({
  dbName: 'keyval-store',
  storeName: 'keyval',
})

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/** Index key listing every scanId in the cache, oldest first. */
const INDEX_KEY = 'spatial:capture-cache:index:v1'

/** Per-entry key prefix. */
const ENTRY_KEY_PREFIX = 'spatial:capture-cache:entry:v1:'

/** Schema version stamped on every entry so a future migration can fan-out. */
const SCHEMA_VERSION = 1 as const

/**
 * Soft cap. Above this, cacheCapture() FIFO-evicts the oldest `uploaded`
 * entries before refusing. We never evict `pending|failed|aborted` rows
 * because those are the recoverable ones — losing them would silently
 * delete the user's work.
 */
export const MAX_CACHE_TOTAL_BYTES = 200 * 1024 * 1024 // 200 MB

/** Auto-purge `uploaded` rows older than this. */
export const UPLOADED_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type CaptureCacheStatus = 'pending' | 'uploaded' | 'aborted' | 'failed'

/**
 * One row in the cache. `scanId` is the primary key — captureScan() inserts
 * exactly one entry per scan, before the upload starts.
 */
export interface CaptureCacheEntry {
  /** Mirrors `scans.id`. UUID. */
  scanId: string
  /** Linkage — at least one of these is set, matching CHECK on `scans`. */
  presalesProjectId: string | null
  jobId: string | null
  projectId: string | null
  /** auth.uid() of the capturing user — needed to rebuild the storage path. */
  userId: string
  /** Raw USDZ bytes. Persisted via structured-clone. */
  usdzBlob: Blob
  /** Bytes — duplicated from `usdzBlob.size` so list queries skip blob reads. */
  bytes: number
  /** Device + capture telemetry that captureScan() would have stamped on
   *  `scans.device_meta`. Forwarded to the resume retry so the audit trail
   *  reflects the original capture, not the resume moment. */
  deviceMeta: ScanDeviceMeta
  /**
   * Pre-serialised mesh-classification JSON when the capture had one.
   * Strings (not blobs) so structured-clone is cheap; resume rehydrates it
   * back into MeshClassification before forwarding to captureScan's
   * meshSummary path. `null` on non-LiDAR captures.
   */
  meshClassificationJson: string | null
  capturedAt: number
  uploadedAt: number | null
  abortedAt: number | null
  failedAt: number | null
  status: CaptureCacheStatus
  lastError: string | null
  /** Free-text bucket for diagnostic data — Stream A4 (iOS kill) writes a
   *  `dismiss_reason` string here, ResumePendingScanSheet renders it. */
  abortReason: string | null
  /** Schema version, for forward-migrations. */
  schemaVersion: typeof SCHEMA_VERSION
}

export interface CacheCaptureInput {
  scanId: string
  presalesProjectId?: string | null
  jobId?: string | null
  projectId?: string | null
  userId: string
  usdzBlob: Blob
  deviceMeta?: ScanDeviceMeta
  meshClassificationJson?: string | null
}

type CacheListener = (entries: CaptureCacheEntry[]) => void

// ──────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ──────────────────────────────────────────────────────────────────────────────

function entryKey(scanId: string): string {
  return `${ENTRY_KEY_PREFIX}${scanId}`
}

async function readIndex(): Promise<string[]> {
  const value = (await get<string[]>(INDEX_KEY, captureCacheStore)) ?? []
  return Array.isArray(value) ? value : []
}

async function writeIndex(ids: string[]): Promise<void> {
  await set(INDEX_KEY, ids, captureCacheStore)
}

// ──────────────────────────────────────────────────────────────────────────────
// Subscriber registry — local to this module so consumers stay decoupled.
// ──────────────────────────────────────────────────────────────────────────────

const listeners = new Set<CacheListener>()

/**
 * Fire-and-forget by design (`void notifyListeners()` at every write site) —
 * so it must NEVER reject: a listAll failure here was one of the two
 * unhandled-rejection producers behind FIXUP-WEB-6Q/6T. The triggering write
 * has already settled at this point; a failed re-read only costs one
 * listener refresh.
 */
async function notifyListeners(): Promise<void> {
  if (listeners.size === 0) return
  let entries: CaptureCacheEntry[]
  try {
    entries = await listAll()
  } catch (err) {
    logWarning('spatial.capture_cache.notify_list_failed', {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    })
    return
  }
  for (const listener of listeners) {
    try {
      listener(entries)
    } catch (err) {
      logError('spatial.capture_cache.listener_failed', err)
    }
  }
}

export function subscribeToCaptureCache(listener: CacheListener): () => void {
  listeners.add(listener)
  // Initial emit is fire-and-forget — must not produce an unhandled
  // rejection when IDB is unavailable (second FIXUP-WEB-6Q/6T producer).
  // The subscription itself stays active; the next successful write
  // delivers the state via notifyListeners().
  void listAll()
    .then((entries) => listener(entries))
    .catch((err: unknown) => {
      logWarning('spatial.capture_cache.subscribe_initial_list_failed', {
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    })
  return () => {
    listeners.delete(listener)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Reads
// ──────────────────────────────────────────────────────────────────────────────

export async function listAll(): Promise<CaptureCacheEntry[]> {
  const ids = await readIndex()
  if (ids.length === 0) return []
  const entries = await Promise.all(
    ids.map((id) => get<CaptureCacheEntry>(entryKey(id), captureCacheStore)),
  )
  return entries.filter((e): e is CaptureCacheEntry => Boolean(e))
}

export async function getCacheEntry(
  scanId: string,
): Promise<CaptureCacheEntry | undefined> {
  return get<CaptureCacheEntry>(entryKey(scanId), captureCacheStore)
}

/**
 * Rows the Resume sheet should surface — anything not in `uploaded` state,
 * sorted oldest-first so the user resolves the longest-pending one first.
 */
export async function listResumable(): Promise<CaptureCacheEntry[]> {
  const all = await listAll()
  return all
    .filter((e) => e.status !== 'uploaded')
    .sort((a, b) => a.capturedAt - b.capturedAt)
}

// ──────────────────────────────────────────────────────────────────────────────
// Writes
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Insert one capture into the cache. Called by `captureScan()` AFTER the
 * `scans` row exists (so we have a stable scanId) and BEFORE the upload
 * starts. Idempotent on scanId — re-calling with the same id rewrites the
 * blob in-place (covers the retry-after-soft-failure path).
 *
 * Returns the inserted entry.
 */
export async function cacheCapture(input: CacheCaptureInput): Promise<CaptureCacheEntry> {
  // Make room: drop the oldest `uploaded` rows FIFO until we fit. Never evict
  // recoverable rows here — the user's work is more valuable than the quota.
  await ensureQuotaForBytes(input.usdzBlob.size)

  const entry: CaptureCacheEntry = {
    scanId: input.scanId,
    presalesProjectId: input.presalesProjectId ?? null,
    jobId: input.jobId ?? null,
    projectId: input.projectId ?? null,
    userId: input.userId,
    usdzBlob: input.usdzBlob,
    bytes: input.usdzBlob.size,
    deviceMeta: input.deviceMeta ?? {},
    meshClassificationJson: input.meshClassificationJson ?? null,
    capturedAt: Date.now(),
    uploadedAt: null,
    abortedAt: null,
    failedAt: null,
    status: 'pending',
    lastError: null,
    abortReason: null,
    schemaVersion: SCHEMA_VERSION,
  }

  await set(entryKey(input.scanId), entry, captureCacheStore)

  // Append to the index iff the scanId is new — re-cache of the same id
  // keeps its original index position so FIFO ordering is intuitive.
  const ids = await readIndex()
  if (!ids.includes(input.scanId)) {
    await writeIndex([...ids, input.scanId])
  }

  logInfo('spatial.capture_cache.cached', {
    scanId: input.scanId,
    bytes: input.usdzBlob.size,
    presalesProjectId: input.presalesProjectId ?? null,
  })
  void notifyListeners()
  return entry
}

export async function markUploaded(scanId: string): Promise<CaptureCacheEntry | undefined> {
  const current = await getCacheEntry(scanId)
  if (!current) return undefined
  const next: CaptureCacheEntry = {
    ...current,
    status: 'uploaded',
    uploadedAt: Date.now(),
    lastError: null,
  }
  await set(entryKey(scanId), next, captureCacheStore)
  logInfo('spatial.capture_cache.marked_uploaded', { scanId })
  void notifyListeners()
  return next
}

export async function markFailed(
  scanId: string,
  error: unknown,
): Promise<CaptureCacheEntry | undefined> {
  const current = await getCacheEntry(scanId)
  if (!current) return undefined
  const message = errorToMessage(error)
  const next: CaptureCacheEntry = {
    ...current,
    status: 'failed',
    failedAt: Date.now(),
    lastError: message,
  }
  await set(entryKey(scanId), next, captureCacheStore)
  logWarning('spatial.capture_cache.marked_failed', { scanId, message })
  void notifyListeners()
  return next
}

export async function markAborted(
  scanId: string,
  reason: string,
): Promise<CaptureCacheEntry | undefined> {
  const current = await getCacheEntry(scanId)
  if (!current) return undefined
  // Once `uploaded`, an abort signal is stale (the bytes landed already);
  // we keep the uploaded state and just breadcrumb the late signal.
  if (current.status === 'uploaded') {
    logInfo('spatial.capture_cache.abort_ignored_already_uploaded', {
      scanId,
      reason,
    })
    return current
  }
  const next: CaptureCacheEntry = {
    ...current,
    status: 'aborted',
    abortedAt: Date.now(),
    abortReason: reason,
  }
  await set(entryKey(scanId), next, captureCacheStore)
  logInfo('spatial.capture_cache.marked_aborted', { scanId, reason })
  void notifyListeners()
  return next
}

export async function removeCacheEntry(scanId: string): Promise<void> {
  await del(entryKey(scanId), captureCacheStore)
  const ids = await readIndex()
  const filtered = ids.filter((id) => id !== scanId)
  if (filtered.length !== ids.length) {
    await writeIndex(filtered)
  }
  logInfo('spatial.capture_cache.removed', { scanId })
  void notifyListeners()
}

/** Remove every cache entry. Use on sign-out. */
export async function clearCaptureCache(): Promise<void> {
  const ids = await readIndex()
  await Promise.all(ids.map((id) => del(entryKey(id), captureCacheStore)))
  await writeIndex([])
  void notifyListeners()
}

// ──────────────────────────────────────────────────────────────────────────────
// Maintenance
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Purge `uploaded` entries older than {@link UPLOADED_TTL_MS}. Idempotent —
 * call from Hub-Mount or a Capacitor app-state listener. Returns the number
 * of rows removed.
 */
export async function purgeStaleUploaded(
  now: number = Date.now(),
): Promise<number> {
  const all = await listAll()
  const stale = all.filter(
    (e) =>
      e.status === 'uploaded' &&
      e.uploadedAt !== null &&
      now - e.uploadedAt > UPLOADED_TTL_MS,
  )
  if (stale.length === 0) return 0
  await Promise.all(stale.map((e) => removeCacheEntry(e.scanId)))
  logInfo('spatial.capture_cache.purged_stale', { count: stale.length })
  return stale.length
}

/**
 * Sweep helper — removes index entries that point at missing rows, and
 * removes rows whose index entry is gone. Defensive against a crash that
 * left the pair half-written.
 */
export async function reconcileCaptureCacheIndex(): Promise<void> {
  const indexed = await readIndex()
  const indexedSet = new Set(indexed)
  const allKeys = await keys(captureCacheStore)
  const orphanIds = allKeys
    .map((k) => String(k))
    .filter((k) => k.startsWith(ENTRY_KEY_PREFIX))
    .map((k) => k.slice(ENTRY_KEY_PREFIX.length))
    .filter((id) => !indexedSet.has(id))

  // Drop entry rows that are not referenced from the index.
  if (orphanIds.length > 0) {
    logWarning('spatial.capture_cache.orphan_entries_dropped', {
      count: orphanIds.length,
    })
    await Promise.all(orphanIds.map((id) => del(entryKey(id), captureCacheStore)))
  }

  // Drop index ids that no longer have a backing entry.
  const present = await Promise.all(
    indexed.map(async (id) => {
      const row = await get<CaptureCacheEntry>(entryKey(id), captureCacheStore)
      return row ? id : null
    }),
  )
  const filtered = present.filter((id): id is string => id !== null)
  if (filtered.length !== indexed.length) {
    logWarning('spatial.capture_cache.stale_index_ids_dropped', {
      count: indexed.length - filtered.length,
    })
    await writeIndex(filtered)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Drop oldest `uploaded` rows until adding `bytes` fits under the cap. Never
 * touches recoverable rows (pending/failed/aborted) — preserving user work
 * always wins over honouring the soft cap precisely. If even after evicting
 * every uploaded row we still wouldn't fit, the cache accepts the entry
 * anyway and emits a warning; IndexedDB will reject the write at the
 * platform-level if quota truly runs out, and that error bubbles up to
 * `cacheCapture()` as the natural failure path.
 */
async function ensureQuotaForBytes(needBytes: number): Promise<void> {
  const all = await listAll()
  const total = all.reduce((sum, e) => sum + e.bytes, 0)
  if (total + needBytes <= MAX_CACHE_TOTAL_BYTES) return

  const candidates = all
    .filter((e) => e.status === 'uploaded')
    .sort((a, b) => (a.uploadedAt ?? 0) - (b.uploadedAt ?? 0))

  let freed = 0
  for (const e of candidates) {
    if (total - freed + needBytes <= MAX_CACHE_TOTAL_BYTES) break
    await removeCacheEntry(e.scanId)
    freed += e.bytes
  }

  if (total - freed + needBytes > MAX_CACHE_TOTAL_BYTES) {
    logWarning('spatial.capture_cache.over_soft_cap', {
      totalBytes: total - freed,
      needBytes,
      capBytes: MAX_CACHE_TOTAL_BYTES,
    })
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}
