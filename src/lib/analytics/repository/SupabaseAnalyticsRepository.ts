import { supabase } from '../../supabase'
import { logError } from '../../observability'
import { getAuthSession } from '../../auth/authSingleFlight'
import type { AnalyticsEvent, AnalyticsEventType } from '../analyticsTypes'
import type { AnalyticsRepository } from './AnalyticsRepository'

type Listener = () => void

/**
 * Supabase-backed analytics repository.
 *
 * Follows the same optimistic-cache pattern used by other SaFix repositories:
 * - Synchronous reads from an in-memory cache
 * - Async writes with fire-and-forget persistence
 * - Errors logged but never thrown to callers
 */
export class SupabaseAnalyticsRepository implements AnalyticsRepository {
  private events: AnalyticsEvent[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0

  async initialize(): Promise<void> {
    if (this._initPromise) return this._initPromise
    const generation = ++this._loadGeneration
    const p: Promise<void> = (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (generation !== this._loadGeneration) return
      if (!session?.user) {
        this.resetState()
        this._hydrated = true
        this.notify()
        return
      }
      await this.loadForUser(session.user.id, generation)
      this._hydrated = true
      this.notify()
      this.ensureAuthListener()
    })()
    this._initPromise = p
    void p.then(
      () => { if (this._initPromise === p) this._initPromise = null },
      () => { if (this._initPromise === p) this._initPromise = null },
    )
    return p
  }

  isHydrated(): boolean {
    return this._hydrated
  }

  private async loadForUser(uid: string, generationSnapshot: number): Promise<void> {
    this.currentUid = uid
    try {
      const { data, error } = await supabase
        .from('analytics_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5000)

      if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
      if (error) {
        logError('repository.analytics.initialize_failed', error)
        return
      }

      this.events = (data ?? []).map(mapRowToEvent)
      this.notify()
    } catch (err) {
      logError('repository.analytics.initialize_failed', err)
    }
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.events = []
    this.notify()
  }

  private ensureAuthListener(): void {
    if (this.authUnsubscribe) return
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user?.id
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && uid && (uid !== this.currentUid || !this._hydrated)) {
        void this.loadForUser(uid, this._loadGeneration)
      }
      if (event === 'SIGNED_OUT') {
        this.currentUid = null
        this.resetState()
      }
    })
    this.authUnsubscribe = subscription?.unsubscribe
      ? subscription.unsubscribe.bind(subscription)
      : null
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): AnalyticsEvent[] {
    return [...this.events]
  }

  getByEventType(eventType: AnalyticsEventType): AnalyticsEvent[] {
    return this.events.filter((e) => e.eventType === eventType)
  }

  getByEntityId(entityId: string): AnalyticsEvent[] {
    return this.events.filter((e) => e.entityId === entityId)
  }

  getSince(since: number): AnalyticsEvent[] {
    return this.events.filter((e) => e.createdAt >= since)
  }

  add(event: AnalyticsEvent): void {
    this.events = [event, ...this.events]
    this.notify()

    // Single authoritative chokepoint for EVERY analytics writer — track(),
    // `signup` in auth.ts, ProviderShowcase, all workflows. Never attempt the
    // network insert unless the supabase CLIENT currently holds an authenticated
    // session. The analytics_events INSERT policy is `TO authenticated` only (no
    // anon grant), so an anon insert is a guaranteed Postgres 42501 — pure noise
    // that previously surfaced as the login-screen "sync failed" banner (e.g.
    // app_open on a logged-out boot, or `signup` while email confirmation is
    // pending and data.session is still null → client still anon). We check the
    // live client session (getAuthSession — single-flight, imports `supabase`
    // only, so no session.ts pull / barrel side-effect in offline tests) because
    // that JWT is exactly what authorizes the insert. Best-effort: a failed
    // insert is LOGGED, never recorded as a persistence failure — analytics must
    // not drive the SyncStatusBar.
    void (async () => {
      try {
        const {
          data: { session },
        } = await getAuthSession()
        if (!session?.user) return
        const { error } = await supabase.from('analytics_events').insert({
          event_id: event.eventId,
          event_type: event.eventType,
          entity_type: event.entityType,
          entity_id: event.entityId,
          actor_user_id: event.actorUserId ?? null,
          metadata: event.metadata ?? null,
          created_at: event.createdAt,
        })
        if (error) {
          logError('repository.analytics.insert_failed', error, { eventId: event.eventId })
        }
      } catch {
        // Auth read failed (lock-stolen / timeout) — skip the best-effort insert
        // silently; analytics must never escalate or spam.
      }
    })()
  }
}

function mapRowToEvent(row: Record<string, unknown>): AnalyticsEvent {
  return {
    eventId: row.event_id as string,
    eventType: row.event_type as AnalyticsEvent['eventType'],
    entityType: row.entity_type as AnalyticsEvent['entityType'],
    entityId: row.entity_id as string,
    actorUserId: (row.actor_user_id as string) ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    createdAt: row.created_at as number,
  }
}
