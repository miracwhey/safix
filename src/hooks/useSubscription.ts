/**
 * useSubscription — Block 6
 *
 * Reactive hook for subscription state. Owner-first scope:
 *   - craftsmanRole === 'owner' → fetches subscription row, resolves effective state
 *   - anything else → returns scope='not_applicable', no fetch
 *
 * Data flow:
 *   Direct Supabase query → resolveEffectiveState → state
 *   No ad-hoc singleton cache. No new second source of truth.
 *   Refresh via refetch() — called by ProActionGuard after trial start.
 *
 * The hook re-fetches when session changes (login, role change).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from './useSession'
import { supabase } from '../lib/supabase'
import { subscribeSubscriptionRealtime } from '../lib/subscription/subscriptionRealtime'
import { resolveEffectiveState } from '../lib/subscription/resolveEffectiveState'
import type {
  SubscriptionRow,
  EffectiveSubscriptionStatus,
  SubscriptionScope,
} from '../lib/subscription/types'

export type UseSubscriptionResult = {
  effectiveState: EffectiveSubscriptionStatus | null
  row: SubscriptionRow | null
  scope: SubscriptionScope
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function useSubscription(): UseSubscriptionResult {
  const { user, role, craftsmanRole, sessionValidated } = useSession()
  const [row, setRow] = useState<SubscriptionRow | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchIdRef = useRef(0)

  const isOwner = !!(
    user &&
    sessionValidated &&
    role === 'craftsman' &&
    craftsmanRole === 'owner'
  )

  const fetchSubscription = useCallback(async () => {
    if (!user) return

    const fetchId = ++fetchIdRef.current
    setIsLoading(true)
    setError(null)

    try {
      const { data, error: queryError } = await supabase
        .from('craftsman_subscriptions')
        .select('*')
        .eq('profile_id', user.id)
        .maybeSingle()

      // Stale response guard
      if (fetchId !== fetchIdRef.current) return

      if (queryError) {
        setError(queryError.message)
        setRow(null)
        return
      }

      setRow(data as SubscriptionRow | null)
    } catch (e) {
      if (fetchId !== fetchIdRef.current) return
      setError(e instanceof Error ? e.message : 'Subscription konnte nicht geladen werden')
      setRow(null)
    } finally {
      if (fetchId === fetchIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [user])

  useEffect(() => {
    if (!isOwner || !user) {
      setRow(null)
      setIsLoading(false)
      setError(null)
      return
    }

    fetchSubscription()

    // Realtime: re-fetch whenever the subscription row changes in the DB.
    // Closes the race where Pro lapses mid-session (webhook UPDATE fires → UI flips).
    // REPLICA IDENTITY FULL on the table ensures profile_id is in OLD.* for filtered DELETEs.
    // Channel ownership lives in subscriptionRealtime so the resume cascade
    // (session.ts) can restart it after an iOS suspend — the previous bare
    // in-effect channel had no status handling and froze Pro state after
    // backgrounding until remount.
    const unsubscribe = subscribeSubscriptionRealtime(user.id, () => { fetchSubscription() })

    return () => { unsubscribe() }
  }, [isOwner, user, fetchSubscription])

  // Non-owner passthrough
  if (!isOwner) {
    return {
      effectiveState: null,
      row: null,
      scope: 'not_applicable',
      isLoading: false,
      error: null,
      refetch: () => {},
    }
  }

  const effectiveState = row ? resolveEffectiveState(row) : null

  return {
    effectiveState,
    row,
    scope: 'owner',
    isLoading,
    error,
    refetch: fetchSubscription,
  }
}
