/**
 * Spatial Lane 3 V1.6 Block 3 · useCustomerSpatialScans
 *
 * Customer-side hook for the Konto-Tab list + Home-Card.
 * Returns scans the authenticated customer can see — HW-shared scans on
 * their jobs + their own Self-Scans (Block 4 forward-compat).
 *
 * Hydration discipline: `isHydrated` flips to `true` after the first load
 * (success, error, or unauthenticated) so UI never flashes empty before we
 * actually know.
 *
 * Direct import path (NOT via `lib/spatial/workflow/index.ts`) — see
 * `feedback_spatial_barrel_no_session_imports`.
 *
 * V1.6.1 Phase 3b · Live-Sync:
 *   - Realtime-Subscription auf `scans` (eigene captured_by + shared_with_customer=true)
 *     refresht den State sobald HW oder Customer einen Scan anlegt/ändert. Ohne das
 *     blieb der Hub auf der initial-snapshot stehen — User scant, "Meine Räume 1"
 *     bleibt stehen obwohl DB schon 2 hat.
 *   - `visibilitychange` + `focus`: iOS Background→Foreground triggert kein
 *     Realtime-replay (Capacitor-WebView pausiert WebSocket), also reload-Trigger
 *     beim App-Resume zusätzlich.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { supabase } from '../../supabase'
import { listCustomerScans, NotAuthenticatedError } from '../workflow/listCustomerScans'
import type { Scan } from '../types'

export type CustomerSpatialScansStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'unauthenticated'

export interface UseCustomerSpatialScansResult {
  scans: Scan[]
  status: CustomerSpatialScansStatus
  isHydrated: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useCustomerSpatialScans(): UseCustomerSpatialScansResult {
  const [scans, setScans] = useState<Scan[]>([])
  const [status, setStatus] = useState<CustomerSpatialScansStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const mountedRef = useRef(true)

  const reload = useCallback(async () => {
    setStatus('loading')
    setError(null)
    try {
      const result = await listCustomerScans()
      if (!mountedRef.current) return
      setScans(result)
      setStatus('ready')
    } catch (e) {
      if (!mountedRef.current) return
      if (e instanceof NotAuthenticatedError) {
        setScans([])
        setStatus('unauthenticated')
        return
      }
      const msg = e instanceof Error ? e.message : 'unknown_error'
      setError(msg)
      setStatus('error')
    } finally {
      if (mountedRef.current) setIsHydrated(true)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void reload()
    return () => {
      mountedRef.current = false
    }
  }, [reload])

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mountedRef.current) return
      if (session?.user) {
        void reload()
      } else {
        setScans([])
        setStatus('unauthenticated')
        setError(null)
        setIsHydrated(true)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [reload])

  // Realtime: scans-changes propagate live. Channel covers both Self-Scan
  // creates (captured_by=me) and HW-share toggles (shared_with_customer=true).
  // We don't filter at the subscription level because Postgres-Changes
  // filters can't do OR across columns — we trigger reload() on any change
  // and let RLS narrow the visible set.
  useEffect(() => {
    let active = true
    let channelHandle: ReturnType<typeof supabase.channel> | null = null
    void (async () => {
      const { data } = await supabase.auth.getUser()
      if (!active || !data.user) return
      const channel = supabase
        .channel(`spatial-scans-${data.user.id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'scans' },
          () => {
            if (!mountedRef.current) return
            void reload()
          },
        )
        .subscribe()
      channelHandle = channel
    })()
    return () => {
      active = false
      if (channelHandle) {
        void supabase.removeChannel(channelHandle)
      }
    }
  }, [reload])

  // App-Resume + Tab-Focus: Capacitor pausiert Realtime WebSocket im
  // Background, also reload-Trigger sobald WebView wieder visible wird.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && mountedRef.current) {
        void reload()
      }
    }
    const onFocus = () => {
      if (mountedRef.current) void reload()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])

  return { scans, status, isHydrated, error, reload }
}
