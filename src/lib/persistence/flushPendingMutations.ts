import { supabase } from '../supabase'
import {
  getPendingMutations,
  removePendingMutation,
  incrementRetryCount,
  clearPendingMutations,
  prunePendingMutations,
  migratePendingMutationsIfNeeded,
  getPendingMutationsSnapshot,
  MAX_PENDING_AGE_MS,
  type PendingMutation,
} from './pendingMutationStore'
import {
  clearPersistenceFailureForEntity,
  recordPersistenceFailure,
} from './persistenceErrorStore'
import {
  classifyFailure,
  isPermanentKind,
} from './classifyFailure'
import { describeError } from './serverErrors'
import { logError, logInfo } from '../observability'

const MAX_RETRIES = 5

/**
 * Records permanent failures for stale orphan mutations and removes them.
 *
 * `prunePendingMutations` strips the entries from localStorage; here we
 * surface what was lost via the failure store so the SyncStatusBar shows
 * a concrete count and observability captures the breadcrumb.
 *
 * Called from inside the inflight flush so concurrency is handled by the
 * outer promise — the prune itself is synchronous on top of localStorage.
 */
function recordStaleDrops(stale: PendingMutation[]): number {
  if (stale.length === 0) return 0
  for (const m of stale) {
    const recordOp: 'add' | 'update' = (m.operation ?? 'insert') === 'insert' ? 'add' : 'update'
    recordPersistenceFailure(
      {
        domain: m.domain,
        operation: recordOp,
        entityId: m.entityId,
        error: new Error(`Sync dropped after ${MAX_PENDING_AGE_MS / 86_400_000} days in queue`),
        occurredAt: Date.now(),
        kind: 'unknown',
      },
      { permanent: true },
    )
    logError(
      'persistence.pending_mutation.dropped_stale',
      new Error('Pending mutation TTL exceeded'),
      {
        domain: m.domain,
        entityId: m.entityId,
        ageMs: Date.now() - m.enqueuedAt,
        retryCount: m.retryCount,
        userId: m.userId ?? null,
      },
    )
  }
  return stale.length
}

/**
 * Handles a single replay failure with full kind-driven policy:
 *
 *   - `auth-not-ready`              → silent skip (mutation stays, no retry++,
 *                                     no record).  The next flush after
 *                                     `refreshSession` resolves will replay it.
 *   - `permission-denied` /
 *     `business-rejected` /
 *     `validation`                  → drop pending mutation, record permanent
 *                                     failure with the classified kind.  These
 *                                     errors will not self-heal — repeating the
 *                                     write returns the same error.
 *   - `transient` / `retryable` /
 *     `unknown`                     → increment retry count, record with
 *                                     `fromAutoRecovery: true` (drives the 2-
 *                                     attempts-before-banner threshold).
 *
 * Centralised here so both the supabase-error path and the catch-block path
 * share identical classification semantics.  Every branch logs structured
 * fields (kind, retryCount, age, userId, code, status, name) so a stuck
 * mutation can be triaged from Sentry / console without redeploying.
 */
function handleReplayFailure(args: {
  error: unknown
  mutation: PendingMutation
  recordOp: 'add' | 'update'
  currentUid: string | null
  context: 'supabase_error' | 'flush_error'
  onDrop: () => void
}): void {
  const { error, mutation, recordOp, currentUid, context, onDrop } = args
  const kind = classifyFailure(error, {
    currentUid,
    mutationUserId: mutation.userId ?? null,
  })
  const errInfo = describeError(error)
  const ageMs = Date.now() - mutation.enqueuedAt

  // Auth-not-ready: leave the mutation in place, do not surface a banner.
  // The refreshSession path inside handleAppResume will re-attempt the
  // flush once the auth state is valid.
  if (kind === 'auth-not-ready') {
    logInfo('persistence.pending_mutation.auth_not_ready_skip', {
      domain: mutation.domain,
      entityId: mutation.entityId,
      attempt: mutation.retryCount + 1,
      ageMs,
      userId: mutation.userId ?? null,
      context,
      ...errInfo,
    })
    return
  }

  // Permanent kinds: replaying produces the same error.  Drop the entry
  // from the queue and record a permanent failure so the SyncStatusBar
  // surfaces an actionable banner without waiting for MAX_RETRIES.
  if (isPermanentKind(kind)) {
    recordPersistenceFailure(
      {
        domain: mutation.domain,
        operation: recordOp,
        entityId: mutation.entityId,
        error,
        occurredAt: Date.now(),
        kind,
      },
      { permanent: true },
    )
    removePendingMutation(mutation.id)
    onDrop()
    logError(`persistence.pending_mutation.${context}_permanent`, error as Error, {
      domain: mutation.domain,
      entityId: mutation.entityId,
      kind,
      ageMs,
      retryCount: mutation.retryCount,
      userId: mutation.userId ?? null,
      ...errInfo,
    })
    return
  }

  // Retryable: count this attempt, record so the escalation threshold can
  // surface the banner after MIN_AUTO_RECOVERY_ATTEMPTS.
  incrementRetryCount(mutation.id)
  recordPersistenceFailure(
    {
      domain: mutation.domain,
      operation: recordOp,
      entityId: mutation.entityId,
      error,
      occurredAt: Date.now(),
      kind,
    },
    { fromAutoRecovery: true },
  )
  logError(`persistence.pending_mutation.${context}`, error as Error, {
    domain: mutation.domain,
    entityId: mutation.entityId,
    attempt: mutation.retryCount + 1,
    kind,
    ageMs,
    userId: mutation.userId ?? null,
    ...errInfo,
  })
}

/**
 * The in-flight flush promise.
 *
 * Multiple concurrent callers — e.g. the `online` event and `fixup:app-resume`
 * firing simultaneously on iOS, or `resyncRepositories` arriving while a
 * background flush is already running — all receive the SAME promise and
 * genuinely await its completion.
 *
 * Previous behaviour: a second call while a flush was running returned
 *   { flushed: 0, remaining: N, dropped: 0 }
 * immediately, so `resyncRepositories` could proceed to reload repository
 * caches from a pre-flush DB snapshot, leaving locally-optimistic state
 * behind the DB after the original flush committed.
 *
 * With this approach every caller waits for the current flush to finish
 * before the caller continues — no stale snapshot can slip through.
 */
let inflightFlush: Promise<FlushResult> | null = null

export interface FlushResult {
  flushed: number
  remaining: number
  /** Mutations dropped after MAX_RETRIES — DB-side state did not receive the write. */
  dropped: number
}

/**
 * Replays all pending mutations that belong to the currently signed-in user.
 *
 * User scoping: the current uid is read from the Supabase session at flush
 * time. Mutations tagged with a different userId are cross-session leftovers;
 * they are removed without replay (RLS would reject them anyway) and logged.
 * Mutations without a userId (legacy entries) are treated as belonging to the
 * current user and replayed normally.
 *
 * Operation types:
 *   'insert' → upsert (INSERT ON CONFLICT DO UPDATE) — idempotent, requires INSERT
 *   'update' → update().eq('id', ...) — only requires UPDATE policy (safe for workers)
 *
 * On successful replay: the PersistenceFailure for that specific (domain, entityId)
 * is cleared via clearPersistenceFailureForEntity — unrelated non-queued failures
 * (e.g. payment updates) are left intact.
 *
 * On replay failure: recordPersistenceFailure is called with fromAutoRecovery: true
 * so the escalation counter increments and the SyncStatusBar only appears after
 * multiple failed background attempts, not on the first transient error.
 *
 * On MAX_RETRIES exceeded: a PersistenceFailure is recorded before dropping the
 * mutation, so the user has a visible recovery path via resyncRepositories().
 *
 * Dropped mutations do NOT auto-clear the failure store — the caller (SyncStatusBar)
 * must trigger resyncRepositories() to reconcile DB-side truth.
 *
 * Concurrency: if a flush is already in progress all additional callers receive the
 * same promise and await its completion — no caller returns with a stale no-op result.
 */
export async function flushPendingMutations(): Promise<FlushResult> {
  if (inflightFlush) return inflightFlush

  // Build the work promise WITHOUT cleanup-in-finally.  If the body returns
  // synchronously (e.g. when prune drains the queue and `pending.length === 0`
  // short-circuits the replay loop), a `finally { inflightFlush = null }` block
  // inside the IIFE runs BEFORE the outer `inflightFlush = (await ...)`
  // assignment — so cleanup writes null first, then the assignment overwrites
  // it with the resolved promise, leaving `inflightFlush` permanently truthy
  // and every subsequent caller receiving the cached first-call result.
  // Move the cleanup to a `.finally()` on the promise itself, registered
  // AFTER the assignment, to guarantee correct ordering.
  const work = (async (): Promise<FlushResult> => {
    // One-time migration: clear orphan mutations queued by the pre-v1
    // store before the schema-version stamp existed.  Idempotent — once
    // the version is bumped, this is a no-op.  Counted into `dropped`
    // alongside the rolling TTL prune below.
    const migrated = migratePendingMutationsIfNeeded()
    const migratedDropped = recordStaleDrops(migrated)

    // Prune stale mutations BEFORE the replay loop.  An orphan that has
    // sat in the queue for > MAX_PENDING_AGE_MS will keep failing with
    // the same error every resume — recording it as a permanent failure
    // and dropping it breaks the loop.  Counted into `dropped` so the
    // SyncStatusBar caller still triggers a resync to reconcile cache.
    const stale = prunePendingMutations()
    const staleDropped = recordStaleDrops(stale) + migratedDropped

    const pending = getPendingMutations()
    const beforeSnapshot = getPendingMutationsSnapshot()
    logInfo('persistence.flush.start', {
      pendingCount: pending.length,
      staleDropped,
      snapshot: beforeSnapshot,
    })
    if (pending.length === 0) {
      const result: FlushResult = { flushed: 0, remaining: 0, dropped: staleDropped }
      logInfo('persistence.flush.end', { ...result })
      return result
    }

    // Determine the authenticated user so we can skip cross-user mutations.
    const { data: { session } } = await supabase.auth.getSession()
    const currentUid = session?.user?.id ?? null

    let flushed = 0
    let dropped = staleDropped

    for (const mutation of pending) {
      // User-scoped mutation: skip if no session (currentUid null) or if the
      // session belongs to a different user.  These skips are auth-not-ready
      // by definition — never recorded as a banner failure, never counted
      // towards autoRecoveryAttempts.  Leave queued for the owning user.
      if (mutation.userId && (!currentUid || mutation.userId !== currentUid)) {
        continue
      }

      const op = mutation.operation ?? 'insert'
      const recordOp: 'add' | 'update' = op === 'insert' ? 'add' : 'update'

      if (mutation.retryCount >= MAX_RETRIES) {
        // Mark as permanent: no more retries will follow, so the failure must be
        // immediately visible regardless of autoRecoveryAttempts or age threshold.
        recordPersistenceFailure(
          {
            domain: mutation.domain,
            operation: recordOp,
            entityId: mutation.entityId,
            error: new Error('Sync failed permanently after maximum retries'),
            occurredAt: Date.now(),
            kind: 'unknown',
          },
          { permanent: true },
        )
        removePendingMutation(mutation.id)
        dropped++
        logError(
          'persistence.pending_mutation.dropped',
          new Error('Max retries exceeded'),
          { domain: mutation.domain, entityId: mutation.entityId, retryCount: mutation.retryCount },
        )
        continue
      }

      try {
        let supabaseError: unknown = null

        if (op === 'insert') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await supabase.from(mutation.table as any).upsert(mutation.payload, { onConflict: 'id' })
          supabaseError = result.error
        } else {
          // op === 'update' — only requires UPDATE policy (safe for worker roles)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await supabase.from(mutation.table as any)
            .update(mutation.payload)
            .eq('id', mutation.payload['id'] as string)
          supabaseError = result.error
        }

        if (supabaseError) {
          handleReplayFailure({
            error: supabaseError,
            mutation,
            recordOp,
            currentUid,
            context: 'supabase_error',
            onDrop: () => { dropped++ },
          })
        } else {
          removePendingMutation(mutation.id)
          // Precisely clear only the failure for this entity — leaves unrelated
          // non-queued failures (e.g. payment updates) intact.
          clearPersistenceFailureForEntity(mutation.domain, mutation.entityId)
          flushed++
          logInfo('persistence.pending_mutation.flushed', {
            domain: mutation.domain,
            entityId: mutation.entityId,
            operation: op,
          })
        }
      } catch (err) {
        // Thrown exception (network, abort, JS error) — same classification
        // path as a returned PostgrestError.  Auth-not-ready short-circuits
        // are handled inside handleReplayFailure via the context.
        handleReplayFailure({
          error: err,
          mutation,
          recordOp,
          currentUid,
          context: 'flush_error',
          onDrop: () => { dropped++ },
        })
      }
    }

    const remaining = getPendingMutations().length

    if (remaining === 0 && dropped === 0) {
      // Per-entity clears in the success branch above already removed the
      // PersistenceFailure entry for each replayed mutation. Only drain the
      // pending queue itself. Non-queued failures are intentionally preserved.
      clearPendingMutations()
    }

    const result: FlushResult = { flushed, remaining, dropped }
    logInfo('persistence.flush.end', { ...result })
    return result
  })()

  inflightFlush = work
  // Cleanup AFTER the assignment is committed.  Using `.finally()` on the
  // promise schedules the slot-clear as a microtask that will run after this
  // function returns, regardless of whether the IIFE resolved synchronously
  // or via real awaits.  Without this — i.e. with `try { ... } finally
  // { inflightFlush = null }` inside the IIFE — a synchronously-resolving
  // body runs the cleanup BEFORE `inflightFlush = work` is reached, which
  // means the assignment then traps a stale resolved promise that every
  // future call returns instead of running a fresh flush.
  void work.finally(() => {
    inflightFlush = null
  })
  return work
}
