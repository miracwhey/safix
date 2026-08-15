import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logError, logInfo } from '../../observability'
import type { Rating } from '../types'
import type { RatingRepository } from './RatingRepository'

type Listener = () => void

interface RatingRow {
  id: string
  job_id: string
  provider_user_id: string
  customer_user_id: string
  rating_score: number
  rating_comment: string | null
  created_at: string
}

function rowToRating(row: RatingRow): Rating {
  return {
    id: row.id,
    jobId: row.job_id,
    providerUserId: row.provider_user_id,
    customerUserId: row.customer_user_id,
    ratingScore: row.rating_score as 1 | 2 | 3 | 4 | 5,
    createdAt: new Date(row.created_at).getTime(),
    ...(row.rating_comment != null && { ratingComment: row.rating_comment }),
  }
}

function ratingToRow(rating: Rating): Omit<RatingRow, 'created_at'> & { created_at: string } {
  return {
    id: rating.id,
    job_id: rating.jobId,
    provider_user_id: rating.providerUserId,
    customer_user_id: rating.customerUserId,
    rating_score: rating.ratingScore,
    rating_comment: rating.ratingComment ?? null,
    created_at: new Date(rating.createdAt).toISOString(),
  }
}

/**
 * Supabase-backed implementation of RatingRepository.
 *
 * Uses a local in-memory cache to serve synchronous reads while writes are
 * persisted to the `ratings` table asynchronously (optimistic pattern).
 *
 * Write durability: add() is queue-durable via enqueuePendingMutation.
 * A pre-flight guard prevents duplicate writes when a pending INSERT
 * already exists for the same rating ID.
 */
export class SupabaseRatingRepository implements RatingRepository {
  private ratings: Rating[] = []
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
    const { data, error } = await supabase
      .from('ratings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.ratings = ((data ?? []) as RatingRow[]).map(rowToRating)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.ratings = []
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

  getAll(): Rating[] {
    return [...this.ratings]
  }

  getById(id: string): Rating | undefined {
    return this.ratings.find((rating) => rating.id === id)
  }

  getByJobId(jobId: string): Rating | undefined {
    return this.ratings.find((rating) => rating.jobId === jobId)
  }

  getByProviderUserId(providerUserId: string): Rating[] {
    return this.ratings.filter((rating) => rating.providerUserId === providerUserId)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'ratings' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.ratings.some((r) => r.id === m.entityId)) continue
      try {
        const rating = rowToRating(m.payload as unknown as RatingRow)
        this.ratings = [rating, ...this.ratings]
      } catch { /* malformed payload */ }
    }
  }

  add(rating: Rating): void {
    this.ratings = [rating, ...this.ratings]
    this.notify()

    // Pending guard: if a prior add() for this rating already failed and is
    // queued for replay, skip the write — the queue covers it.
    if (hasPendingMutationForEntity('ratings', rating.id)) {
      logInfo('repository.ratings.add_skipped_pending', { entityId: rating.id })
      return
    }

    supabase
      .from('ratings')
      .insert(ratingToRow(rating))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.ratings = this.ratings.filter((r) => r.id !== rating.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('ratings').select('*').eq('id', rating.id).single().then(({ data }) => {
                if (data) {
                  this.ratings = [rowToRating(data as RatingRow), ...this.ratings]
                  this.notify()
                }
              })
              return
            }
            logError('repository.ratings.add_failed', error, { entityId: rating.id, jobId: rating.jobId })
            recordPersistenceFailure({ domain: 'ratings', operation: 'add', entityId: rating.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.ratings.add_failed', error, {
            entityId: rating.id,
            jobId: rating.jobId,
          })
          recordPersistenceFailure({
            domain: 'ratings',
            operation: 'add',
            entityId: rating.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'ratings',
            payload: ratingToRow(rating) as unknown as Record<string, unknown>,
            domain: 'ratings',
            entityId: rating.id,
          })
        }
      })
  }

  async addAsync(rating: Rating): Promise<{ ok: boolean }> {
    this.ratings = [rating, ...this.ratings]
    this.notify()

    // Pending guard: a prior add() for this rating already failed and is
    // queued for replay — the queue covers durability, treat as success.
    if (hasPendingMutationForEntity('ratings', rating.id)) {
      logInfo('repository.ratings.add_skipped_pending', { entityId: rating.id })
      return { ok: true }
    }

    const { error } = await supabase.from('ratings').insert(ratingToRow(rating))
    if (!error) return { ok: true }

    if (isServerSideError(error)) {
      // Non-retryable: roll back the optimistic row and surface failure.
      this.ratings = this.ratings.filter((r) => r.id !== rating.id)
      this.notify()
      if (isDuplicateKeyError(error)) {
        // A rating for this id already exists server-side — reconcile and
        // treat as success (idempotent re-submit).
        const { data } = await supabase
          .from('ratings')
          .select('*')
          .eq('id', rating.id)
          .single()
        if (data) {
          this.ratings = [rowToRating(data as RatingRow), ...this.ratings]
          this.notify()
          return { ok: true }
        }
      }
      logError('repository.ratings.add_failed', error, {
        entityId: rating.id,
        jobId: rating.jobId,
      })
      recordPersistenceFailure({
        domain: 'ratings',
        operation: 'add',
        entityId: rating.id,
        error,
        occurredAt: Date.now(),
      })
      return { ok: false }
    }

    // Transient (network / 5xx): keep the optimistic row, enqueue durable
    // replay, and report success — the queue guarantees eventual persistence.
    logError('repository.ratings.add_failed', error, {
      entityId: rating.id,
      jobId: rating.jobId,
    })
    recordPersistenceFailure({
      domain: 'ratings',
      operation: 'add',
      entityId: rating.id,
      error,
      occurredAt: Date.now(),
    })
    enqueuePendingMutation({
      operation: 'insert',
      table: 'ratings',
      payload: ratingToRow(rating) as unknown as Record<string, unknown>,
      domain: 'ratings',
      entityId: rating.id,
    })
    return { ok: true }
  }
}
