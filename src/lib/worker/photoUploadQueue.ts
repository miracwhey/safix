/**
 * Photo-Upload Offline-Queue · Block C.2
 *
 * IndexedDB-Persisted Queue für post-pipeline Foto-Files, deren Upload
 * (Storage + DB-INSERT) fehlgeschlagen ist — typischerweise wegen Netz-
 * Verbindungsverlust auf der Baustelle. Spiegelt den Pattern aus
 * `pendingPushAction.ts`.
 *
 * Entries enthalten den **post-Pipeline**-Blob (EXIF-stripped, JPEG q=0.92,
 * max 2560px) plus alle Felder die der Replay-Runner braucht. clientUuid
 * doppelt als Storage-Path-Suffix UND Idempotenz-Key in `job_photos`,
 * sodass ein zweimal gefeuerter Replay (Race) per UNIQUE-Constraint die
 * zweite Insert kollidieren lässt — kein doppeltes Foto.
 *
 * Cleanup: jeder Read filtert Entries mit `attempts > MAX_ATTEMPTS` und
 * Entries älter als `MAX_AGE_MS` raus — verhindert Tagelange-Retry-Loops
 * bei dauerhaftem RLS-Fehler.
 */

import { get, set, del } from 'idb-keyval'

import { logWarning } from '../observability'

const STORAGE_KEY = 'fixup.worker.pending-photo-uploads:v1'
const MAX_QUEUE_SIZE = 50
/** Nach 5 fehlgeschlagenen Versuchen wird die Queue-Row gedroppt — typischerweise
 *  ein RLS-Fehler oder corrupted blob, der nicht durch Retry behoben wird. */
export const MAX_ATTEMPTS = 5
/** Nach 7 Tagen wird gedroppt — länger ist die Capture-Intent stale. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface PendingPhotoUpload {
  /** UUID v4, doppelt als Storage-Path-Suffix UND DB-Idempotenz-Key. */
  clientUuid: string
  jobId: string
  providerId: string
  uploadedBy: string
  /** Pfad innerhalb worker-doku-photos: `jobs/{jobId}/{clientUuid}.jpg`. */
  storagePath: string
  /** Post-Pipeline File-Blob (EXIF-stripped, komprimiert). */
  blob: Blob
  contentType: string
  widthPx?: number
  heightPx?: number
  sizeBytes?: number
  enqueuedAt: number
  /** Retry-Counter — nach MAX_ATTEMPTS wird Entry verworfen. */
  attempts: number
}

async function readQueue(): Promise<PendingPhotoUpload[]> {
  const raw = await get<unknown>(STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(isPendingPhotoUpload)
}

async function writeQueue(queue: PendingPhotoUpload[]): Promise<void> {
  if (queue.length === 0) {
    await del(STORAGE_KEY)
    return
  }
  await set(STORAGE_KEY, queue)
}

function pruneStale(queue: PendingPhotoUpload[], now: number): PendingPhotoUpload[] {
  return queue.filter((entry) => {
    if (entry.attempts >= MAX_ATTEMPTS) {
      logWarning('worker.photo_queue.dropped_max_attempts', {
        clientUuid: entry.clientUuid,
        attempts: entry.attempts,
      })
      return false
    }
    if (now - entry.enqueuedAt > MAX_AGE_MS) {
      logWarning('worker.photo_queue.dropped_stale', {
        clientUuid: entry.clientUuid,
        ageHours: Math.round((now - entry.enqueuedAt) / 3_600_000),
      })
      return false
    }
    return true
  })
}

function enforceMaxSize(queue: PendingPhotoUpload[]): PendingPhotoUpload[] {
  if (queue.length <= MAX_QUEUE_SIZE) return queue
  return queue.slice(queue.length - MAX_QUEUE_SIZE)
}

export async function enqueuePhotoUpload(
  upload: Omit<PendingPhotoUpload, 'enqueuedAt' | 'attempts'>,
  now: number = Date.now(),
): Promise<void> {
  const existing = await readQueue()
  const pruned = pruneStale(existing, now)
  // Idempotenz: wenn dieselbe clientUuid schon in der Queue steht, nicht
  // doppelt enqueuen.
  if (pruned.some((entry) => entry.clientUuid === upload.clientUuid)) {
    return
  }
  const next = enforceMaxSize([
    ...pruned,
    { ...upload, enqueuedAt: now, attempts: 0 },
  ])
  await writeQueue(next)
}

export async function peekPhotoUploads(
  now: number = Date.now(),
): Promise<PendingPhotoUpload[]> {
  const existing = await readQueue()
  const pruned = pruneStale(existing, now)
  if (pruned.length !== existing.length) {
    await writeQueue(pruned)
  }
  return pruned
}

/**
 * Markiert eine Queue-Row als gerade-versucht. Increments `attempts` und
 * persistiert. Wird vom Replay-Runner vor jedem Upload-Versuch gerufen,
 * damit ein Crash mid-flight nicht zu einem Endlos-Retry führt (Counter
 * läuft trotzdem hoch).
 */
export async function markPhotoUploadAttempt(
  clientUuid: string,
  now: number = Date.now(),
): Promise<PendingPhotoUpload | null> {
  const existing = await readQueue()
  const idx = existing.findIndex((e) => e.clientUuid === clientUuid)
  if (idx < 0) return null
  const entry = existing[idx]!
  const updated: PendingPhotoUpload = {
    ...entry,
    attempts: entry.attempts + 1,
    enqueuedAt: entry.enqueuedAt,
  }
  const next = [...existing]
  next[idx] = updated
  const pruned = pruneStale(next, now)
  await writeQueue(pruned)
  return pruned.find((e) => e.clientUuid === clientUuid) ?? null
}

/**
 * Entfernt eine Row aus der Queue — Aufruf nach erfolgreichem Replay.
 */
export async function removePhotoUpload(clientUuid: string): Promise<void> {
  const existing = await readQueue()
  const next = existing.filter((e) => e.clientUuid !== clientUuid)
  await writeQueue(next)
}

export async function clearPhotoUploads(): Promise<void> {
  await writeQueue([])
}

function isPendingPhotoUpload(value: unknown): value is PendingPhotoUpload {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<PendingPhotoUpload>
  return (
    typeof v.clientUuid === 'string' &&
    typeof v.jobId === 'string' &&
    typeof v.providerId === 'string' &&
    typeof v.uploadedBy === 'string' &&
    typeof v.storagePath === 'string' &&
    v.blob instanceof Blob &&
    typeof v.contentType === 'string' &&
    typeof v.enqueuedAt === 'number' &&
    typeof v.attempts === 'number'
  )
}

/**
 * Test-only: garantiert leeren Queue-State.
 */
export async function __testOnly_resetQueue(): Promise<void> {
  await del(STORAGE_KEY)
}
