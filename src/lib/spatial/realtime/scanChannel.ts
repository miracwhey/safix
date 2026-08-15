/**
 * Spatial Core · Block E2 · Per-Scan Realtime Channel
 *
 * Thin wrapper around `supabase.channel('scan:${scanId}', { private: true })`
 * for the broadcast-from-DB pattern introduced in Block A.1 (migration
 * `20260518000007_scan_realtime_broadcast`). Triggers on
 * `scans` / `scan_events` / `scan_quality_reports` emit a broadcast carrying
 * the row payload — clients listen instead of being granted
 * postgres_changes access to those tables.
 *
 * Synchronous by design: `supabase.channel(...).subscribe()` returns the
 * channel handle immediately, so the unsubscribe fn is available the
 * instant the caller's `useEffect` cleanup might fire. This closes the
 * race the async version had where the channel could outlive the consumer
 * if the parent unmounted during the dynamic `await import()` window.
 */

import { supabase } from '../../supabase'
import type { ScanEventAction } from '../types'

export interface ScanChannelEvent {
  /** Action label emitted by the broadcast trigger — matches `ScanEventAction`
   *  when the source row is `scan_events`, plus `scan_updated` and
   *  `quality_report_inserted` for the other two source tables. */
  action: ScanEventAction | 'scan_updated' | 'quality_report_inserted' | string
  /** Free-form payload mirrored from the SQL trigger. */
  payload: Record<string, unknown>
}

export type ScanChannelListener = (event: ScanChannelEvent) => void

/**
 * Subscribe to the per-scan broadcast channel. Returns an unsubscribe fn
 * the caller MUST invoke from its effect cleanup. Idempotent — second
 * unsubscribe() is a no-op via supabase's internal channel tracking.
 *
 * The listener fires for every broadcast event on the channel; callers
 * filter by `event.action` (e.g. only refresh on `annotation_added`).
 */
export function subscribeScanChannel(
  scanId: string,
  listener: ScanChannelListener,
): () => void {
  const channel = supabase.channel(`scan:${scanId}`, { config: { private: true } })
  channel
    .on('broadcast', { event: '*' }, payload => {
      const raw = (payload?.payload ?? {}) as Record<string, unknown>
      const action =
        typeof raw.action === 'string' ? raw.action : (payload.event ?? 'unknown')
      listener({ action, payload: raw })
    })
    .subscribe()

  let removed = false
  return () => {
    if (removed) return
    removed = true
    void supabase.removeChannel(channel)
  }
}
