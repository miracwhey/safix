/**
 * Spatial V1.6.1 · Item #3 · useDetectPendingCustomerCapture
 *
 * Hub-mount detection: at most ONE pending Customer-LiDAR capture (the
 * oldest resumable cache row that belongs to the calling customer) is
 * surfaced via the `pending` field. The Hub mounts `CaptureResumeSheet`
 * iff `pending != null` AND the user has not dismissed it this session.
 *
 * Idempotence — session dismissed-flag:
 *   - `dismissForSession()` flips a sessionStorage entry so a manual close
 *     does not re-pop on the next Hub-Mount inside the same tab. Reload
 *     clears it (sessionStorage scope) so the next visit re-evaluates.
 *
 * Cross-tab reactivity:
 *   - `subscribeToCaptureCache(...)` lands a fresh snapshot whenever any
 *     tab mutates the cache (cacheCapture / markUploaded / markAborted /
 *     removeCacheEntry / clearCaptureCache). The hook re-filters on every
 *     snapshot.
 *
 * Workflow boundary:
 *   - Detection list comes from `listResumablePendingCustomerCaptures` —
 *     RBAC + owner-filter live there, not in this hook.
 *   - Resume / Discard are thin wrappers around the existing
 *     `resumePendingCustomerCapture` / `removeCaptureCacheEntry` calls;
 *     log + workflow-layer errors are logged through `logError` and
 *     surfaced to the consumer via the typed `Result` return values so
 *     the Hub can toast — silent failures would re-arm the sheet on the
 *     next snapshot without telling the user why.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { logError } from '../lib/observability'
import {
  type CaptureCacheEntry,
  removeCaptureCacheEntry,
  subscribeToCaptureCache,
} from '../lib/spatial/storage'
import {
  listResumablePendingCustomerCaptures,
  type ResumableCustomerCapture,
} from '../lib/spatial/workflow/listResumablePendingCustomerCaptures'
import {
  resumePendingCustomerCapture,
  type ResumePendingCustomerCaptureResult,
} from '../lib/spatial/workflow/resumePendingCustomerCapture'

/**
 * sessionStorage key — `sessionStorage` (not localStorage) so the dismiss
 * is per-tab + cleared on close. A user who explicitly clicks "Später
 * entscheiden" should not be re-prompted in the same session, but a fresh
 * visit (reload, app cold-boot) re-evaluates.
 *
 * Versioned (v1) so a future copy revision can force a re-prompt.
 */
export const CUSTOMER_RESUME_DISMISS_KEY =
  'spatial-customer-resume-dismissed-v1'

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.sessionStorage?.getItem(CUSTOMER_RESUME_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function persistDismissed(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage?.setItem(CUSTOMER_RESUME_DISMISS_KEY, '1')
  } catch (err) {
    logError('spatial.customer_resume.dismiss_persist_failed', err)
  }
}

export interface UseDetectPendingCustomerCaptureArgs {
  /** Current `auth.uid()` of the customer. `null` while the Hub is still
   *  resolving the auth state — detection skips entirely until set. */
  userId: string | null
}

/**
 * Result envelope returned by `discard()` so the consumer can toast on a
 * cache-IO failure instead of silently re-arming. `ok=true` covers both the
 * happy path and the no-op (pending=null) early-return — the consumer never
 * needs to special-case the latter.
 */
export type DiscardPendingCustomerCaptureResult =
  | { ok: true }
  | { ok: false; error: Error }

export interface UseDetectPendingCustomerCaptureApi {
  /** Oldest resumable capture for this customer, or `null` when none. */
  pending: ResumableCustomerCapture | null
  /** True until the first snapshot has been resolved. */
  loading: boolean
  /** True iff the sheet should currently be open (pending != null AND not
   *  dismissed). The Hub uses this directly as the sheet's `open` prop. */
  shouldShow: boolean
  /** True while the resume workflow is in-flight. */
  resuming: boolean
  /** True while the discard call is in-flight. */
  discarding: boolean
  /** Run one resume cycle against the cached blob. Resolves with the
   *  typed workflow result so the caller can navigate / toast on ok. */
  resume: () => Promise<ResumePendingCustomerCaptureResult | null>
  /** Drop the cache entry without uploading. Returns a typed Result so the
   *  caller can toast on cache-IO failure; success path closes the sheet
   *  via the natural pending=null transition fed by the cache subscriber. */
  discard: () => Promise<DiscardPendingCustomerCaptureResult>
  /** Soft-dismiss for this session. Sheet hides but the cache entry
   *  remains; next visit re-evaluates. */
  dismissForSession: () => void
}

export function useDetectPendingCustomerCapture({
  userId,
}: UseDetectPendingCustomerCaptureArgs): UseDetectPendingCustomerCaptureApi {
  const [pending, setPending] = useState<ResumableCustomerCapture | null>(null)
  const [loading, setLoading] = useState(true)
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())
  const [resuming, setResuming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  // Guard against late snapshot updates landing AFTER the consumer unmounted.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refreshFromCache = useCallback(
    async (_entries?: CaptureCacheEntry[]) => {
      // `entries` is passed by the subscribe callback for reactivity, but
      // the workflow re-reads via the repo so we keep the source-of-truth
      // single (server + RLS). Ignored argument named `_entries` to satisfy
      // the subscribe signature without lint warnings.
      void _entries
      try {
        const list = await listResumablePendingCustomerCaptures(userId)
        if (!aliveRef.current) return
        setPending(list.length > 0 ? list[0] : null)
        setLoading(false)
      } catch (err) {
        logError('spatial.customer_resume.detect_failed', err, {
          userId: userId ?? null,
        })
        if (!aliveRef.current) return
        setPending(null)
        setLoading(false)
      }
    },
    [userId],
  )

  // First-mount detection + cache subscription. The subscriber fires once
  // synchronously after registration with the current cache snapshot, so
  // we get an initial pass without a separate boot effect.
  useEffect(() => {
    // Reset loading on userId change so the next user's first read shows
    // a fresh "loading" state rather than a stale `false`.
    setLoading(true)
    const unsubscribe = subscribeToCaptureCache((entries) => {
      void refreshFromCache(entries)
    })
    return unsubscribe
  }, [refreshFromCache])

  // Cross-tab dismiss-sync intentionally NOT implemented: `sessionStorage`
  // is per-tab scope and never fires `storage` events across tabs, so a
  // listener here is dead-code. If we ever need cross-tab dismiss-sync,
  // we have to migrate the persistence to `localStorage` first — at which
  // point we add the listener back together with the storage swap.

  const dismissForSession = useCallback(() => {
    persistDismissed()
    setDismissed(true)
  }, [])

  const resume = useCallback(async (): Promise<
    ResumePendingCustomerCaptureResult | null
  > => {
    if (!pending || !userId) return null
    setResuming(true)
    try {
      const result = await resumePendingCustomerCapture({
        entry: pending.entry,
        callerUserId: userId,
      })
      // Re-derive `pending` from the cache once the workflow has cleaned up
      // its old entry. The subscriber will also fire, but an explicit
      // refresh keeps the consumer's open-state in lockstep with the
      // returned result on the next render tick.
      await refreshFromCache()
      return result
    } finally {
      if (aliveRef.current) setResuming(false)
    }
  }, [pending, userId, refreshFromCache])

  const discard = useCallback(async (): Promise<DiscardPendingCustomerCaptureResult> => {
    if (!pending) return { ok: true }
    setDiscarding(true)
    try {
      await removeCaptureCacheEntry(pending.entry.scanId)
      await refreshFromCache()
      return { ok: true }
    } catch (err) {
      logError('spatial.customer_resume.discard_failed', err, {
        scanId: pending.entry.scanId,
      })
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }
    } finally {
      if (aliveRef.current) setDiscarding(false)
    }
  }, [pending, refreshFromCache])

  const shouldShow = pending !== null && !dismissed && !loading

  return {
    pending,
    loading,
    shouldShow,
    resuming,
    discarding,
    resume,
    discard,
    dismissForSession,
  }
}
