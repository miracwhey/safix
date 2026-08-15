/**
 * Photo-Upload Queue Runner · Block FU-A
 *
 * Drains the offline `photoUploadQueue` while the app is online. Pattern
 * mirrors `src/lib/media/outboxRunner.ts`:
 *   - 15 s slow polling tick
 *   - `online`-Event triggers an immediate run
 *   - per-entry: markAttempt (counts toward MAX_ATTEMPTS=5 + age cap),
 *     direct Storage+DB upload, on success removePhotoUpload, on failure
 *     leave entry — next tick retries until cap is reached
 *
 * Recursion guard: the runner does NOT route through
 * `photoCaptureService.uploadJobPhoto`, because that path enqueues on
 * failure — calling it from the runner would create a duplicate-enqueue
 * loop on persistent errors. The runner uses the same Supabase storage
 * + repo primitives directly.
 *
 * Single-runner invariant: `startPhotoUploadQueueRunner` is idempotent —
 * subsequent calls return the existing stop-fn.
 */

import { supabase } from '../supabase'
import { logInfo, logWarning } from '../observability'
import {
  peekPhotoUploads,
  markPhotoUploadAttempt,
  removePhotoUpload,
  MAX_ATTEMPTS,
  type PendingPhotoUpload,
} from './photoUploadQueue'
import {
  SupabaseJobPhotoRepository,
  type JobPhotoRepository,
} from './repository/JobPhotoRepository'

const STORAGE_BUCKET = 'worker-doku-photos'
const TICK_INTERVAL_MS = 15_000

type RunnerHandle = {
  stop: () => void
  /** Force a tick — used by the `online` handler and by tests. */
  triggerNow: () => Promise<void>
}

let activeRunner: RunnerHandle | null = null
let tickInFlight = false

interface RunnerDeps {
  repository: JobPhotoRepository
}

async function runOnce(deps: RunnerDeps): Promise<void> {
  if (tickInFlight) return
  // Skip nur wenn der Browser **explizit** offline meldet. `undefined`
  // (jsdom oder ältere Capacitor-WebViews) wird als „unbekannt → versuchen"
  // behandelt — der Storage/DB-Call schlägt eh fehl wenn wirklich offline,
  // und wir wollen nicht dauerhaft skippen weil ein Test-Env das Property
  // nicht setzt.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  tickInFlight = true
  try {
    // Session einmal pro Tick holen — nicht per Entry. Kein Upload wenn kein
    // aktiver User (Queue bleibt, nächster Tick nach Re-Login).
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) return

    const currentUserId = session.user.id
    const queue = await peekPhotoUploads()
    if (queue.length === 0) return
    for (const entry of queue) {
      await processEntry(entry, currentUserId, deps)
    }
  } finally {
    tickInFlight = false
  }
}

async function processEntry(
  entry: PendingPhotoUpload,
  currentUserId: string,
  deps: RunnerDeps,
): Promise<void> {
  // FU.8 — Auth-Mismatch-Guard: Entry wurde unter einem anderen Account
  // eingereiht (Logout + Re-Login als anderer User). Kein Upload unter
  // falschem Account → Entry sofort verwerfen, kein attempts-Inkrement.
  if (entry.uploadedBy !== currentUserId) {
    logWarning('worker.photo_queue.dropped_user_mismatch', {
      clientUuid: entry.clientUuid,
      uploadedBy: entry.uploadedBy,
    })
    await removePhotoUpload(entry.clientUuid)
    return
  }

  // markAttempt liefert null zurück, wenn der Eintrag durch Pruning weggefallen
  // ist (MAX_ATTEMPTS=5 oder MAX_AGE_MS=7d). Dann nichts mehr tun.
  const updated = await markPhotoUploadAttempt(entry.clientUuid)
  if (!updated) return

  try {
    // 1. Storage-Upload (Blob ist bereits post-pipeline aus dem captureService).
    //    upsert: false → wenn ein vorheriger Versuch den Path schon beschrieben
    //    hat (Crash mid-flight) bricht der Upload ab; der DB-Insert weiter
    //    unten ist trotzdem idempotent durch UNIQUE(job_id, client_uuid),
    //    sodass wir den Eintrag dann sicher entfernen können.
    const { error: storageError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(updated.storagePath, updated.blob, {
        contentType: updated.contentType,
        upsert: false,
      })

    // Storage „resource already exists" = Path existiert schon. In dem Fall
    // versuchen wir den DB-Insert trotzdem (der ist der Quell-of-Truth). Andere
    // Storage-Errors → leave-in-queue + retry.
    const isAlreadyExists =
      storageError !== null &&
      typeof storageError.message === 'string' &&
      /already exists|duplicate|409/i.test(storageError.message)

    if (storageError && !isAlreadyExists) {
      logWarning('worker.photo_queue_runner.storage_failed', {
        clientUuid: entry.clientUuid,
        attempt: updated.attempts,
        error: storageError.message,
      })
      if (updated.attempts >= MAX_ATTEMPTS) {
        logWarning('worker.photo_queue_runner.dropped_final_fail', {
          clientUuid: entry.clientUuid,
          attempts: updated.attempts,
          lastError: storageError.message,
        })
      }
      return
    }

    // 2. DB-Insert. UNIQUE(job_id, client_uuid) macht das idempotent gegen
    //    einen vorherigen erfolgreichen Insert. Wenn 23505 → schon
    //    geschrieben, Eintrag ist drained.
    try {
      await deps.repository.add({
        jobId: updated.jobId,
        providerId: updated.providerId,
        uploadedBy: updated.uploadedBy,
        storagePath: updated.storagePath,
        clientUuid: updated.clientUuid,
        ...(updated.sizeBytes !== undefined && { sizeBytes: updated.sizeBytes }),
        ...(updated.widthPx !== undefined && { widthPx: updated.widthPx }),
        ...(updated.heightPx !== undefined && { heightPx: updated.heightPx }),
      })
    } catch (dbError) {
      const code = (dbError as { code?: string } | null)?.code
      if (code !== '23505') {
        logWarning('worker.photo_queue_runner.db_failed', {
          clientUuid: entry.clientUuid,
          attempt: updated.attempts,
          code,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        })
        return
      }
    }

    // 3. Erfolgreich (oder bereits-vorhanden) → Eintrag aus der Queue entfernen.
    await removePhotoUpload(entry.clientUuid)
    logInfo('worker.photo_queue_runner.drained', {
      clientUuid: entry.clientUuid,
      attempts: updated.attempts,
    })
  } catch (err) {
    logWarning('worker.photo_queue_runner.entry_failed', {
      clientUuid: entry.clientUuid,
      attempt: updated.attempts,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export interface StartRunnerOptions {
  /** Test-Hook — Repo-Override, sonst SupabaseJobPhotoRepository. */
  repository?: JobPhotoRepository
}

/**
 * Startet den Runner falls noch nicht aktiv. Idempotent — subsequent
 * Aufrufe liefern dieselbe stop-Funktion. Bootstrap-Hook (z.B.
 * AppBootstrap.tsx oder App.tsx) ruft das einmal pro Session auf.
 */
export function startPhotoUploadQueueRunner(
  options: StartRunnerOptions = {},
): () => void {
  if (activeRunner) return activeRunner.stop

  const deps: RunnerDeps = {
    repository: options.repository ?? new SupabaseJobPhotoRepository(),
  }

  // Initial-Tick beim Start (rebooted nach Online-Reconnect).
  void runOnce(deps)

  const interval = setInterval(() => {
    void runOnce(deps)
  }, TICK_INTERVAL_MS)

  const onOnline = () => {
    void runOnce(deps)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
  }

  const stop = () => {
    clearInterval(interval)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
    }
    activeRunner = null
  }

  activeRunner = {
    stop,
    triggerNow: () => runOnce(deps),
  }
  return stop
}

/** Test-only: drained the queue synchronously, ohne Scheduler. */
export async function runPhotoUploadQueueNowForTest(
  options: StartRunnerOptions = {},
): Promise<void> {
  const deps: RunnerDeps = {
    repository: options.repository ?? new SupabaseJobPhotoRepository(),
  }
  await runOnce(deps)
}

/** Test-only: clears the active-runner singleton without keeping the timer. */
export function __testOnly_resetRunner(): void {
  if (activeRunner) {
    activeRunner.stop()
    activeRunner = null
  }
  tickInFlight = false
}
