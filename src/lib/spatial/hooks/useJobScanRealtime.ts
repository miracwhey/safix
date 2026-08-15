/**
 * Spatial · Lane 3 V1.6 Block 2 · Hook · useJobScanRealtime (D1)
 *
 * Subscribe-only React hook that fires `onChange()` whenever the Postgres
 * `scans` table emits an UPDATE for a row with the given `job_id`. The hook
 * holds no state of its own — the consumer (typically
 * `CraftsmanJobSpatialDetailScreen`) wires this into an existing read hook's
 * refresh callback (`useSpatialScan.refresh()`) so the single-source read
 * path stays the truth.
 *
 * Why a separate hook (D1 · explicit user decision over the recommended
 * "extend useSpatialScan" option):
 *   - Read-source and subscription concerns stay cleanly split. Tests and
 *     mocks for `useSpatialScan` are unaffected by realtime plumbing.
 *   - The same realtime stream can drive additional consumers in future
 *     (audit log, push debugger) without entangling the read hook.
 *   - The mutation hook (`useShareScanWithCustomer`) stays pure too — it
 *     does the write, this hook listens, the read hook refreshes. Three
 *     concerns, three files.
 *
 * Block-1 server-side requirements (already shipped):
 *   - `ALTER PUBLICATION supabase_realtime ADD TABLE public.scans;`
 *   - `ALTER TABLE public.scans REPLICA IDENTITY FULL;` — needed so a
 *     filtered subscription on a non-PK column does not silently drop
 *     events (see [[feedback_postgres_replica_identity_realtime]]).
 *
 * Pattern reference: `SupabaseJobRepository.startRealtimeSubscription` —
 * latest-ref for the callback so a stable `useEffect` dep list keeps the
 * channel alive across re-renders.
 */

import { useEffect, useRef } from 'react'

import { supabase } from '../../supabase'

export type JobScanRealtimeListener = () => void

export function useJobScanRealtime(
  jobId: string | undefined,
  onChange: JobScanRealtimeListener,
): void {
  // Latest-ref pattern — keeps the effect's dep list down to `jobId`, so a
  // listener identity change in the parent does NOT churn the channel
  // subscription on every render.
  const listenerRef = useRef(onChange)
  useEffect(() => {
    listenerRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!jobId) return undefined

    const channel = supabase
      .channel(`scans-job:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'scans',
          filter: `job_id=eq.${jobId}`,
        },
        () => {
          listenerRef.current()
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [jobId])
}
