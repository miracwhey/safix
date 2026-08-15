/**
 * craftsman_subscriptions realtime — module-level channel manager.
 *
 * Owns the single realtime channel for the current owner's subscription row
 * so the resume cascade (session.ts handleAppResume) can restart it like
 * every repository channel. Previously the channel lived inside
 * useSubscription's effect with a bare `.subscribe()` — no status handling,
 * no reconnect: after an iOS suspend the socket died silently and the Pro
 * entitlement froze until remount.
 *
 * Mirrors the repository realtime pattern (status handler + fallback signal +
 * capped reconnection + generation-guarded teardown) without introducing a
 * second source of truth: listeners (the hook) re-fetch on every signal —
 * the manager never caches rows.
 */

import { supabase } from '../supabase'
import { logBreadcrumb, logInfo, logWarning } from '../observability'

type Listener = () => void

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY = 3000

const listeners = new Set<Listener>()
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null
let currentUid: string | null = null
let isRealtimeConnected = false
let reconnectAttempts = 0
/**
 * Monotonically increasing counter. Incremented before any intentional
 * channel teardown (replace or last-listener removal). Each subscribe
 * callback closes over the generation value at creation time and exits early
 * if it no longer matches — preventing stale CLOSED callbacks from
 * triggering reconnect/fallback on an already-replaced channel.
 */
let channelGeneration = 0

function notify(): void {
  listeners.forEach((listener) => listener())
}

function startRealtimeSubscription(uid: string, fromReconnection = false): void {
  // Increment generation BEFORE removing the old channel so its async CLOSED
  // callback is treated as stale instead of triggering a spurious reconnect.
  const myGeneration = ++channelGeneration
  if (realtimeChannel) {
    void supabase.removeChannel(realtimeChannel)
  }
  realtimeChannel = supabase
    .channel(`craftsman_subscriptions:${uid}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'craftsman_subscriptions',
        filter: `profile_id=eq.${uid}`,
      },
      () => {
        if (myGeneration !== channelGeneration) return
        notify()
      },
    )
    .subscribe((status) => {
      if (myGeneration !== channelGeneration) return
      if (status === 'SUBSCRIBED') {
        isRealtimeConnected = true
        reconnectAttempts = 0
        logInfo('subscription.realtime_connected', { userId: uid })
        // Fallback refresh: signal listeners once so the hook re-fetches the
        // row — any webhook UPDATE that fired while the channel was down
        // would otherwise be lost.
        if (fromReconnection) notify()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        isRealtimeConnected = false
        logBreadcrumb(
          'repository.craftsman_subscriptions.realtime_disconnected',
          'warning',
          { userId: uid, status },
        )
        notify()
        attemptReconnection(uid)
      }
    })
}

function attemptReconnection(uid: string): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    logWarning(
      'repository.craftsman_subscriptions.realtime_reconnect_exhausted',
      { userId: uid, attempts: reconnectAttempts },
    )
    return
  }

  reconnectAttempts++
  logInfo('subscription.realtime_reconnect_attempt', {
    userId: uid,
    attempt: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
  })

  setTimeout(() => {
    if (!isRealtimeConnected && currentUid === uid) {
      startRealtimeSubscription(uid, true)
    }
  }, RECONNECT_DELAY * reconnectAttempts)
}

function teardown(): void {
  channelGeneration++
  if (realtimeChannel) {
    void supabase.removeChannel(realtimeChannel)
    realtimeChannel = null
  }
  currentUid = null
  isRealtimeConnected = false
  reconnectAttempts = 0
}

/**
 * Registers a change listener for `uid`'s subscription row. The first
 * listener (or a uid switch) opens the channel; removing the last listener
 * tears it down. Returns an unsubscribe function.
 */
export function subscribeSubscriptionRealtime(uid: string, listener: Listener): () => void {
  listeners.add(listener)
  if (currentUid !== uid) {
    currentUid = uid
    reconnectAttempts = 0
    startRealtimeSubscription(uid)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) teardown()
  }
}

/**
 * Resume-cascade hook — same contract as the repository registries: no-op
 * while the channel reads healthy unless `force` is set (pessimistic restart
 * after a real background stay — the socket can be dead while
 * isRealtimeConnected still reads true). On restart the channel is torn down
 * and re-subscribed; listeners are signalled once on the fresh SUBSCRIBED.
 */
export function restartSubscriptionRealtimeIfDead(options?: { force?: boolean }): void {
  if (!currentUid || listeners.size === 0) return
  if (!options?.force && isRealtimeConnected) return
  isRealtimeConnected = false
  reconnectAttempts = 0
  startRealtimeSubscription(currentUid, true)
}
