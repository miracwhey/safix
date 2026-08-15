/**
 * Recovery Status Store — App resume / connectivity restore lifecycle.
 *
 * Tracks whether the app is currently inside a resume-driven recovery window
 * (resyncRepositories + flushPendingMutations).  The SyncStatusBar reads
 * this flag to suppress the persistence-failure banner while recovery is
 * still running — preventing a 1–2 s flash on iOS where:
 *
 *   - background suspends JS timers,
 *   - resume fires three concurrent restart events (visibilitychange,
 *     fixup:app-resume, online),
 *   - flushPendingMutations briefly increments autoRecoveryAttempts on a
 *     stale failure before the resync wave clears it.
 *
 * Reference-counted: `markRecoveryStarted` is paired 1:1 with the returned
 * finish handle.  Multiple concurrent recoveries are folded into one banner-
 * suppression window.
 *
 * Ephemeral by design — never persisted to localStorage / sessionStorage.
 * A fresh module load starts at zero, which is the correct initial state.
 */

type Listener = () => void

let activeRecoveries = 0
let recoveryStartedAt: number | null = null
const listeners = new Set<Listener>()

function notify(): void {
  listeners.forEach((l) => l())
}

/**
 * Increment the recovery-active counter and return a one-shot finish handle.
 *
 * The handle is the only safe way to decrement: it carries a `finished`
 * latch so a caller can put it inside a `try/finally` without worrying about
 * accidentally dropping the counter below zero on cancellation paths.
 *
 * If `clearRecoveryStatus()` (e.g. sign-out) has already reset the counter,
 * the returned handle becomes a no-op — the recovery cycle can still
 * complete cleanly without re-incrementing the counter.
 */
export function markRecoveryStarted(): () => void {
  if (activeRecoveries === 0) {
    recoveryStartedAt = Date.now()
  }
  activeRecoveries += 1
  notify()
  let finished = false
  return () => {
    if (finished) return
    finished = true
    if (activeRecoveries === 0) return
    activeRecoveries -= 1
    if (activeRecoveries === 0) {
      recoveryStartedAt = null
    }
    notify()
  }
}

/** True while at least one recovery cycle is active. */
export function isRecovering(): boolean {
  return activeRecoveries > 0
}

/**
 * Timestamp (ms) of the first markRecoveryStarted in the current run, or
 * null if no recovery is active.  Used by tests and observability.
 */
export function getRecoveryStartedAt(): number | null {
  return recoveryStartedAt
}

/**
 * Force-reset the recovery counter.  Used by the sign-out path so a stuck
 * recovery from the previous session cannot keep the SyncStatusBar
 * suppressed for the next user.  Outstanding finish handles become no-ops.
 */
export function clearRecoveryStatus(): void {
  if (activeRecoveries === 0 && recoveryStartedAt === null) return
  activeRecoveries = 0
  recoveryStartedAt = null
  notify()
}

export function subscribeToRecoveryStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only reset.  Internal — production code must not call this. */
export function _resetRecoveryStatusForTest(): void {
  activeRecoveries = 0
  recoveryStartedAt = null
  listeners.clear()
}
