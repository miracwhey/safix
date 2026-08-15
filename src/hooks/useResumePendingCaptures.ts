/**
 * Spatial · Lane 2.5 · Stream A · useResumePendingCaptures
 *
 * Subscribes to the local capture cache, exposes the list of resumable
 * entries (anything not `uploaded`) plus discard / resume handlers wired
 * to the matching workflows. Mounted by the Spatial Hub at session start
 * so a Save-Failure or App-Kill never silently swallows a user's USDZ.
 *
 * Reactivity: a single subscription to `subscribeToCaptureCache` keeps the
 * `entries` snapshot live across captures + resumes in other tabs/windows
 * — the listener pattern matches the upload-outbox queue used for media.
 *
 * Auto-purge: on first mount we kick `purgeStaleCaptureUploads()` so
 * old `uploaded` rows past TTL never accumulate quota.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { logError } from '../lib/observability'
import {
  type CaptureCacheEntry,
  listCaptureCache,
  markCaptureAborted,
  purgeStaleCaptureUploads,
  reconcileCaptureCacheIndex,
  subscribeToCaptureCache,
} from '../lib/spatial/storage'
import {
  discardPendingCapture,
  resumePendingCapture,
  type ResumePendingCaptureResult,
} from '../lib/spatial/workflow/resumePendingCapture'

/**
 * `pending` entries older than this are assumed to belong to a session that
 * was killed (tab closed, iOS app suspended-and-killed, native crash) — the
 * Resume sheet relabels them as `aborted` so the user sees "Abgebrochen"
 * instead of the misleading "Wartet". Two minutes is comfortably longer
 * than any realistic single-USDZ upload (typical 5-50 MB blob → 10-60 s on
 * cellular) so we don't flip in-flight rows by accident.
 */
const STALE_PENDING_THRESHOLD_MS = 2 * 60 * 1000

export interface UseResumePendingCapturesApi {
  /** All resumable entries (`pending`, `failed`, `aborted`), oldest first. */
  entries: CaptureCacheEntry[]
  /** True until the first cache snapshot arrived. */
  loading: boolean
  /** Re-upload one cached capture against a fresh scan-row. */
  resume: (entry: CaptureCacheEntry) => Promise<ResumePendingCaptureResult>
  /** Drop the cache entry without uploading. Irreversible. */
  discard: (entry: CaptureCacheEntry) => Promise<void>
  /** scan-ids currently being resumed — drives per-row spinners. */
  busyScanIds: Set<string>
}

export function useResumePendingCaptures(): UseResumePendingCapturesApi {
  const [entries, setEntries] = useState<CaptureCacheEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busyScanIds, setBusyScanIds] = useState<Set<string>>(() => new Set())

  // First-mount maintenance: drop stale uploaded rows + repair half-written
  // index pairs + relabel orphan `pending` rows as `aborted`. Fire-and-forget
  // — failures here are not user-blocking.
  useEffect(() => {
    void purgeStaleCaptureUploads().catch((err) =>
      logError('spatial.capture_cache.purge_failed', err),
    )
    void reconcileCaptureCacheIndex().catch((err) =>
      logError('spatial.capture_cache.reconcile_failed', err),
    )
    void sweepStalePending().catch((err) =>
      logError('spatial.capture_cache.stale_pending_sweep_failed', err),
    )
  }, [])

  // Live subscription. Initial snapshot lands synchronously after the
  // microtask, then again on every cache mutation.
  useEffect(() => {
    const unsubscribe = subscribeToCaptureCache((all) => {
      const resumable = all
        .filter((e) => e.status !== 'uploaded')
        .sort((a, b) => a.capturedAt - b.capturedAt)
      setEntries(resumable)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  const markBusy = useCallback((scanId: string, busy: boolean) => {
    setBusyScanIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(scanId)
      else next.delete(scanId)
      return next
    })
  }, [])

  const resume = useCallback(
    async (entry: CaptureCacheEntry): Promise<ResumePendingCaptureResult> => {
      markBusy(entry.scanId, true)
      try {
        return await resumePendingCapture(entry)
      } finally {
        markBusy(entry.scanId, false)
      }
    },
    [markBusy],
  )

  const discard = useCallback(
    async (entry: CaptureCacheEntry): Promise<void> => {
      markBusy(entry.scanId, true)
      try {
        await discardPendingCapture(entry)
      } finally {
        markBusy(entry.scanId, false)
      }
    },
    [markBusy],
  )

  return useMemo<UseResumePendingCapturesApi>(
    () => ({ entries, loading, resume, discard, busyScanIds }),
    [entries, loading, resume, discard, busyScanIds],
  )
}

/**
 * Lane-2.5 Stream A4 · stale-pending sweep. A capture entry that's still
 * marked `pending` 2 min after capture cannot be in-flight (TUS-retry tops
 * out around 38 s of backoff and the upload itself is bounded by the
 * platform's network stack). The only honest classification is "the
 * session that wrote this entry is gone" — so we flip the label to
 * `aborted` with reason `session_ended` so the Resume sheet renders the
 * accurate state. The blob bytes + linkage remain untouched, so the user
 * can still resume.
 */
async function sweepStalePending(now: number = Date.now()): Promise<void> {
  const all = await listCaptureCache()
  const stale = all.filter(
    (e) => e.status === 'pending' && now - e.capturedAt > STALE_PENDING_THRESHOLD_MS,
  )
  if (stale.length === 0) return
  await Promise.all(
    stale.map((e) => markCaptureAborted(e.scanId, 'session_ended')),
  )
}
