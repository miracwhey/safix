import { useCallback, useEffect, useState } from 'react'
import {
  getPersistenceFailures,
  hasPersistenceFailures,
  needsUserAttention,
  getEscalationTimeoutMs,
  subscribeToPersistenceFailures,
  isRecovering,
  subscribeToRecoveryStatus,
  type PersistenceFailure,
} from '../lib/persistence'

export interface PersistenceErrorState {
  /** True when there is at least one uncleared write failure. */
  hasErrors: boolean
  /** Snapshot of all recorded write failures (newest last). */
  failures: PersistenceFailure[]
  /**
   * Failures that have passed the escalation threshold and warrant
   * user attention via the SyncStatusBar.
   *
   * Permanent failures (dropped after MAX_RETRIES): always escalated.
   * Queued domains (calendar, schedules): ≥ 2 auto-recovery attempts AND ≥ 15 s old.
   * Non-queued domains (payments, jobs, …): ≥ 15 s old.
   */
  escalatedFailures: PersistenceFailure[]
  /** True when at least one failure has been escalated. */
  hasEscalatedErrors: boolean
}

/**
 * React hook that subscribes to the shared persistence error store.
 * Re-renders whenever a new failure is recorded or failures are cleared.
 *
 * Two re-render triggers:
 * 1. Store subscription — fires when `recordPersistenceFailure` / `clearPersistenceFailures`
 *    is called (covers retry increments, new failures, successful replays).
 * 2. Grace-period timer — when a failure exists but has not yet crossed the age
 *    threshold, a `setTimeout` fires at the exact moment it does, ensuring the
 *    SyncStatusBar becomes visible even if no further store event occurs (e.g. a
 *    non-queued payment failure recorded once while offline).
 *
 * `escalatedFailures` / `hasEscalatedErrors` are the primary signals for the
 * SyncStatusBar — they suppress the banner during transient errors that will
 * self-heal via background flushes.  `failures` / `hasErrors` remain available
 * for internal recovery logic (e.g. deciding whether to call resyncRepositories).
 */
export function usePersistenceErrors(): PersistenceErrorState {
  const [state, setState] = useState<PersistenceErrorState>(() => {
    const failures = getPersistenceFailures()
    const escalated = failures.filter(needsUserAttention)
    return {
      hasErrors: hasPersistenceFailures(),
      failures,
      escalatedFailures: escalated,
      hasEscalatedErrors: escalated.length > 0,
    }
  })

  const recompute = useCallback(() => {
    const failures = getPersistenceFailures()
    const escalated = failures.filter(needsUserAttention)
    setState({
      hasErrors: hasPersistenceFailures(),
      failures,
      escalatedFailures: escalated,
      hasEscalatedErrors: escalated.length > 0,
    })
  }, [])

  // Re-evaluate whenever the store fires (new failure, retry, clear).
  useEffect(() => {
    return subscribeToPersistenceFailures(recompute)
  }, [recompute])

  // Re-evaluate when the grace period expires for time-gated failures.
  // Fires at most once per failure state — resets whenever failures change.
  useEffect(() => {
    const ms = getEscalationTimeoutMs()
    if (ms === null) return
    const id = setTimeout(recompute, ms)
    return () => clearTimeout(id)
  }, [state.failures, recompute])

  // Re-evaluate when a resume-driven recovery cycle completes.  iOS
  // suspends JS timers while the WebView is backgrounded, so a failure
  // that crossed the 15 s age threshold during sleep would otherwise
  // remain hidden until the next store notification.  After recovery
  // settles we recompute once so the banner reflects fresh state.
  useEffect(() => {
    return subscribeToRecoveryStatus(() => {
      if (!isRecovering()) recompute()
    })
  }, [recompute])

  return state
}
