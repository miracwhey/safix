/**
 * Spatial · Canonical · Workflow · useRescanRequests (Phase C · C-7 · Seam 6)
 *
 * React hook backing the bidirectional re-scan loop. Phase B kept re-scan
 * requests in component `useState`. This hook persists them to
 * `spatial_rescan_requests`, loads the history, and subscribes to realtime so
 * the provider sees the customer's accept / reject response WITHOUT a manual
 * refresh — the loop-closure the Rev-1 plan was missing.
 *
 * Error contract: `create` resolves to a boolean (it never rejects) and a
 * failed write surfaces through `error`. A write that persisted but whose
 * follow-up `reload()` failed is NOT reported as an error — realtime / the next
 * mount refreshes the list — so the caller never shows a false "send failed".
 *
 * All `setState` runs in async continuations so the hook stays
 * `react-hooks/set-state-in-effect`-clean.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../supabase.ts'
import { getSpatialSceneRepository, resolveSpatialDataSource } from '../repository/registry.ts'
import type {
  CreateRescanRequestInput,
  SpatialRescanRequest,
} from '../repository/SpatialSceneRepository.ts'

export interface RescanRequestsApi {
  /** Re-scan requests for the scene, newest first. */
  requests: SpatialRescanRequest[]
  loading: boolean
  /** True while a create write is in flight. */
  submitting: boolean
  /** Last create-write failure message, or `null`. Cleared on the next create. */
  error: string | null
  /** True when an open (pending) request already exists — max 1 per scene. */
  hasPending: boolean
  /** Re-fetch the request list. */
  reload: () => Promise<void>
  /** Persist a new re-scan request. Resolves `true` when the write persisted. */
  create: (input: CreateRescanRequestInput) => Promise<boolean>
}

export function useRescanRequests(sceneId: string): RescanRequestsApi {
  const [requests, setRequests] = useState<SpatialRescanRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Synchronous in-flight guard — closes the double-submit race a `submitting`
   *  state dependency leaves open (two taps in one render frame). */
  const inFlightRef = useRef(false)

  const reload = useCallback(async () => {
    setRequests(await getSpatialSceneRepository().listRescanRequests(sceneId))
  }, [sceneId])

  useEffect(() => {
    let cancelled = false

    getSpatialSceneRepository()
      .listRescanRequests(sceneId)
      .then((rows) => {
        if (cancelled) return
        setRequests(rows)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    // Realtime — only meaningful against the Supabase backend.
    if (resolveSpatialDataSource() !== 'supabase') {
      return () => {
        cancelled = true
      }
    }
    const channel = supabase
      .channel(`spatial-rescan-${sceneId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'spatial_rescan_requests',
          filter: `scene_id=eq.${sceneId}`,
        },
        () => {
          getSpatialSceneRepository()
            .listRescanRequests(sceneId)
            .then((rows) => {
              if (!cancelled) setRequests(rows)
            })
            .catch(() => {})
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [sceneId])

  const create = useCallback(
    async (input: CreateRescanRequestInput): Promise<boolean> => {
      if (inFlightRef.current) return false
      inFlightRef.current = true
      setSubmitting(true)
      setError(null)

      let persisted = false
      try {
        await getSpatialSceneRepository().createRescanRequest(input)
        persisted = true
        // Best-effort refresh — a failure here does NOT invalidate the write
        // (realtime / next mount reconciles the list).
        await reload()
      } catch (e) {
        if (!persisted) {
          setError(
            e instanceof Error
              ? e.message
              : 'Re-Scan-Anfrage konnte nicht gesendet werden.',
          )
        }
      } finally {
        inFlightRef.current = false
        setSubmitting(false)
      }
      return persisted
    },
    [reload],
  )

  const hasPending = useMemo(
    () => requests.some((r) => r.status === 'pending'),
    [requests],
  )

  return { requests, loading, submitting, error, hasPending, reload, create }
}
