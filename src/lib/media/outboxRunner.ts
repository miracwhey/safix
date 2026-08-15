/**
 * Outbox runner — drains the upload outbox while the app is online.
 *
 * Runs at app startup (started from AppBootstrap) and stays alive for the
 * session. It does three things:
 *   - On `online` events and at a slow polling interval, scans the outbox
 *     for due entries (status='pending', nextAttemptAt <= now) and uploads
 *     them via the underlying mediaUploadService.
 *   - On success, removes the entry. On failure, applies exponential
 *     backoff and increments the retry counter; after `maxRetries` the
 *     entry is marked 'failed' and stays in the outbox for the user to see.
 *   - Surfaces lifecycle events through observability so we can see queue
 *     drain telemetry without instrumenting every call site.
 *
 * Recursion guard
 *   The runner calls `uploadMediaFileDirect`, the network-level function
 *   that does NOT route through the outbox. Routing back through the
 *   queue-aware wrapper would create an infinite enqueue loop on persistent
 *   failures.
 */

import {
  listOutbox,
  removeOutboxEntry,
  updateOutboxEntry,
  reconcileOutboxIndex,
  type OutboxEntry,
} from './uploadOutbox'
import { uploadMediaFileDirect } from './mediaUploadService'
import { supabase } from '../supabase'
import {
  recordPersistenceFailure,
  clearPersistenceFailureForEntity,
  hasPersistenceFailureForEntity,
} from '../persistence/persistenceErrorStore'
import { logInfo, logWarning } from '../observability'

/** Domain label used for media-outbox failures in the persistence error store. */
const MEDIA_FAILURE_DOMAIN = 'media'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slow tick — fast enough to feel responsive after an `online` event but
 *  not so fast that idle apps burn battery. */
const TICK_INTERVAL_MS = 15_000

/** Backoff schedule per retry: 2s, 4s, 8s, 16s, 32s. */
function backoffMs(retries: number): number {
  return Math.min(2 ** Math.max(retries, 1), 32) * 1000
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

type RunnerHandle = {
  stop: () => void
  /** Force a tick — used by the network 'online' handler. */
  triggerNow: () => Promise<void>
}

let activeRunner: RunnerHandle | null = null

// ---------------------------------------------------------------------------
// Tick logic
// ---------------------------------------------------------------------------

let tickInFlight = false

async function runOnce(): Promise<void> {
  if (tickInFlight) return
  tickInFlight = true
  try {
    // Only drain entries that belong to the currently signed-in user. The
    // runner is started once at bootstrap and lives for the whole app session,
    // so on a shared device it keeps ticking after a user switch. Without this
    // guard user A's queued photo would upload under user B's session (whose
    // auth.uid the upload rebinds to) — a cross-account leak plus a permanent
    // loss for A. Foreign-owner entries stay 'pending' (implicit quarantine)
    // and drain only once their owner is signed in again — we never clear them,
    // mirroring how the pendingMutation queue filters by userId instead of
    // dropping cross-user work.
    const { data: sessionData } = await supabase.auth.getSession()
    const uid = sessionData?.session?.user?.id
    if (!uid) return

    const entries = await listOutbox()
    const now = Date.now()

    // Restore failure visibility after a reload / app-kill. The durable
    // 'failed' entry survives in IndexedDB, but the permanent-failure record
    // that drives the SyncStatusBar lives only in memory and is lost on
    // restart — leaving the user with neither a failure banner nor a retry
    // path after the optimistic "Foto eingereiht" toast. Re-record (permanent)
    // for the current owner's failed entries that have no live record yet.
    // Owner-scoped so a shared device never shows user A's loss to user B,
    // and dedup-guarded so steady-state ticks don't churn the store. Runs
    // before the connectivity gate — a failed upload must stay visible offline.
    for (const entry of entries) {
      if (
        entry.status === 'failed' &&
        entry.ownerUserId === uid &&
        !hasPersistenceFailureForEntity(MEDIA_FAILURE_DOMAIN, entry.id)
      ) {
        recordPersistenceFailure(
          {
            domain: MEDIA_FAILURE_DOMAIN,
            operation: 'add',
            entityId: entry.id,
            error: new Error(entry.lastError ?? 'Upload failed'),
            occurredAt: now,
          },
          { permanent: true },
        )
      }
    }

    // Draining requires connectivity; the visibility restore above does not.
    if (typeof navigator !== 'undefined' && !navigator.onLine) return

    const due = entries.filter(
      (e) => e.status === 'pending' && e.nextAttemptAt <= now && e.ownerUserId === uid
    )
    if (due.length === 0) return
    for (const entry of due) {
      await processEntry(entry)
    }
  } finally {
    tickInFlight = false
  }
}

async function processEntry(entry: OutboxEntry): Promise<void> {
  // Mark in-flight so a second tick (or another tab) does not double-upload.
  await updateOutboxEntry(entry.id, { status: 'in_flight' })

  try {
    await uploadMediaFileDirect({
      file: entry.file,
      entityType: entry.entityType,
      entityId: entry.entityId,
      ownerUserId: entry.ownerUserId,
      mediaRole: entry.mediaRole,
      // Stable key → retries re-target the same object/row, never duplicate.
      idempotencyKey: entry.idempotencyKey,
    })
    await removeOutboxEntry(entry.id)
    // Clear any prior permanent-failure banner for this entry — a later retry
    // (or a re-armed entry) succeeded, so the escalation must not linger.
    clearPersistenceFailureForEntity(MEDIA_FAILURE_DOMAIN, entry.id)
    logInfo('media.outbox_entry_drained', {
      id: entry.id,
      retries: entry.retries,
      label: entry.label,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const nextRetries = entry.retries + 1

    if (nextRetries >= entry.maxRetries) {
      await updateOutboxEntry(entry.id, {
        status: 'failed',
        retries: nextRetries,
        lastError: reason,
      })
      // Surface the exhausted upload to the user via the SyncStatusBar instead
      // of dying silently after the optimistic "Foto eingereiht" toast. Keyed
      // by the unique outbox entry id (not entityId) so each lost photo counts
      // once. `permanent` forces escalation regardless of age/retry policy.
      recordPersistenceFailure(
        {
          domain: MEDIA_FAILURE_DOMAIN,
          operation: 'add',
          entityId: entry.id,
          error: err instanceof Error ? err : new Error(reason),
          occurredAt: Date.now(),
        },
        { permanent: true },
      )
      logWarning('media.outbox_entry_failed_permanently', {
        id: entry.id,
        reason,
      })
      return
    }

    await updateOutboxEntry(entry.id, {
      status: 'pending',
      retries: nextRetries,
      nextAttemptAt: Date.now() + backoffMs(nextRetries),
      lastError: reason,
    })
  }
}

/**
 * Reset entries that were left in `in_flight` from a prior session.
 * The browser/app could have been killed between marking the entry and
 * the upload completing, leaving the queue stuck.
 */
async function resurrectInFlight(): Promise<void> {
  const entries = await listOutbox()
  const stuck = entries.filter((e) => e.status === 'in_flight')
  for (const entry of stuck) {
    await updateOutboxEntry(entry.id, {
      status: 'pending',
      nextAttemptAt: Date.now(),
    })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the runner if it is not already running. Returns a cleanup
 * function that stops it. Safe to call multiple times — only one runner
 * is active at a time.
 */
export function startOutboxRunner(): () => void {
  if (activeRunner) return activeRunner.stop

  // Best-effort cleanup before the first tick.
  void reconcileOutboxIndex()
  void resurrectInFlight().then(() => runOnce())

  const interval = setInterval(() => {
    void runOnce()
  }, TICK_INTERVAL_MS)

  const onOnline = () => {
    void runOnce()
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
    triggerNow: runOnce,
  }
  return stop
}

/**
 * Re-arms every entry that exhausted its retries (status='failed') back to
 * 'pending' with a fresh retry budget, then kicks a drain tick. Wired into the
 * SyncStatusBar "Erneut versuchen" action so a user-initiated retry covers
 * media uploads too — not only the pendingMutation queue. Idempotent and a
 * no-op when there is nothing failed.
 */
export async function retryFailedUploads(): Promise<void> {
  // Owner-scoped, mirroring the drain guard in runOnce: on a shared device a
  // retry tap must only re-arm the signed-in user's failed uploads. Re-arming
  // a foreign-owner entry would clear its banner but never drain (runOnce
  // filters by owner), stranding it invisibly.
  const { data: sessionData } = await supabase.auth.getSession()
  const uid = sessionData?.session?.user?.id
  if (!uid) return
  const entries = await listOutbox()
  const failed = entries.filter((e) => e.status === 'failed' && e.ownerUserId === uid)
  if (failed.length === 0) return
  for (const entry of failed) {
    await updateOutboxEntry(entry.id, {
      status: 'pending',
      retries: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
    })
    // Drop the escalated banner record; the runner re-records if it fails again.
    clearPersistenceFailureForEntity(MEDIA_FAILURE_DOMAIN, entry.id)
  }
  await runOnce()
}

/** Test hook — drains the outbox synchronously without scheduling a tick. */
export async function runOutboxNowForTest(): Promise<void> {
  await runOnce()
}
