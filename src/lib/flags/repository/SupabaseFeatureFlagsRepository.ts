import { supabase } from '../../supabase'
import { logBreadcrumb, logInfo, logWarning } from '../../observability'
import type { FeatureFlag, FeatureFlagsRepository } from '../types'

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY = 3000

type FeatureFlagRow = {
  key: string
  enabled: boolean
  rollout_pct: number
  target_roles: string[] | null
  target_regions: string[] | null
}

function mapRow(row: FeatureFlagRow): FeatureFlag {
  return {
    key: row.key,
    enabled: row.enabled,
    rolloutPct: row.rollout_pct,
    targetRoles: row.target_roles ?? [],
    targetRegions: row.target_regions ?? [],
  }
}

/**
 * Supabase feature-flags repository.
 *
 * Hydrates an in-memory cache once at bootstrap (so reads are synchronous) and
 * keeps it live via a single global realtime channel on `feature_flags`: any
 * change refetches the whole (tiny) table and notifies subscribers — this is
 * the remote kill-switch. Realtime mechanics (status handler, capped reconnect,
 * generation-guarded teardown) mirror subscriptionRealtime.ts.
 *
 * Reads never throw: a failed fetch leaves the last-known cache in place (or an
 * empty cache on cold failure), and isFlagEnabled fail-closes on absent flags.
 */
export class SupabaseFeatureFlagsRepository implements FeatureFlagsRepository {
  private cache = new Map<string, FeatureFlag>()
  private hydrated = false
  private readonly listeners = new Set<() => void>()

  private realtimeChannel: ReturnType<typeof supabase.channel> | null = null
  private isConnected = false
  private reconnectAttempts = 0
  private channelGeneration = 0

  async initialize(): Promise<void> {
    await this.fetchAll()
    this.hydrated = true
    this.startRealtime()
  }

  getFlag(key: string): FeatureFlag | undefined {
    return this.cache.get(key)
  }

  getAllFlags(): FeatureFlag[] {
    return [...this.cache.values()]
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isHydrated(): boolean {
    return this.hydrated
  }

  private notify(): void {
    this.listeners.forEach((l) => l())
  }

  private async fetchAll(): Promise<void> {
    const { data, error } = await supabase
      .from('feature_flags')
      .select('key, enabled, rollout_pct, target_roles, target_regions')
    if (error) {
      // Keep the last-known cache; fail-closed happens at evaluation time.
      logWarning('flags.fetch_failed', { error: error.message })
      return
    }
    const next = new Map<string, FeatureFlag>()
    for (const row of (data ?? []) as FeatureFlagRow[]) next.set(row.key, mapRow(row))
    this.cache = next
  }

  /** Refetch + notify — used by the realtime channel on any change. */
  private async refresh(): Promise<void> {
    await this.fetchAll()
    this.notify()
  }

  private startRealtime(fromReconnection = false): void {
    const myGeneration = ++this.channelGeneration
    if (this.realtimeChannel) {
      void supabase.removeChannel(this.realtimeChannel)
    }
    this.realtimeChannel = supabase
      .channel('feature_flags:all')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'feature_flags' },
        () => {
          if (myGeneration !== this.channelGeneration) return
          void this.refresh()
        },
      )
      .subscribe((status) => {
        if (myGeneration !== this.channelGeneration) return
        if (status === 'SUBSCRIBED') {
          this.isConnected = true
          this.reconnectAttempts = 0
          logInfo('flags.realtime_connected', {})
          // A change that landed while the channel was down would be missed —
          // refetch once on (re)connect to reconcile.
          if (fromReconnection) void this.refresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.isConnected = false
          logBreadcrumb('flags.realtime_disconnected', 'warning', { status })
          this.attemptReconnection()
        }
      })
  }

  private attemptReconnection(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logWarning('flags.realtime_reconnect_exhausted', { attempts: this.reconnectAttempts })
      return
    }
    this.reconnectAttempts++
    setTimeout(() => {
      if (!this.isConnected) this.startRealtime(true)
    }, RECONNECT_DELAY * this.reconnectAttempts)
  }

  /**
   * Resume-cascade hook (mirrors restartSubscriptionRealtimeIfDead): on a real
   * background stay the socket can be dead while isConnected still reads true,
   * so force-restart pessimistically. The kill-switch must keep working after
   * an iOS resume.
   */
  restartRealtimeIfDead(options?: { force?: boolean }): void {
    if (!this.hydrated) return
    if (!options?.force && this.isConnected) return
    this.isConnected = false
    this.reconnectAttempts = 0
    this.startRealtime(true)
  }
}
