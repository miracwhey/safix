import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError } from '../../persistence'
import { logError, logInfo } from '../../observability'
import type { JobFeedback } from '../types'
import type { FeedbackRepository } from './FeedbackRepository'

type Listener = () => void

/**
 * Shape of a `job_feedback` row as stored in the Supabase database.
 * customer_user_id was added in migration 20240900000000 to support
 * ownership-based RLS: only the submitting customer can upsert their row.
 */
interface FeedbackRow {
  id: string
  job_id: string
  craftsman_user_id: string
  customer_user_id: string | null
  would_hire_again: boolean
  note: string | null
  created_at: number
}

function rowToFeedback(row: FeedbackRow): JobFeedback {
  return {
    id: row.id,
    jobId: row.job_id,
    craftsmanUserId: row.craftsman_user_id,
    ...(row.customer_user_id != null && { customerUserId: row.customer_user_id }),
    wouldHireAgain: row.would_hire_again,
    ...(row.note != null ? { note: row.note } : {}),
    createdAt: row.created_at,
  }
}

function feedbackToRow(feedback: JobFeedback): FeedbackRow {
  return {
    id: feedback.id,
    job_id: feedback.jobId,
    craftsman_user_id: feedback.craftsmanUserId,
    customer_user_id: feedback.customerUserId ?? null,
    would_hire_again: feedback.wouldHireAgain,
    note: feedback.note ?? null,
    created_at: feedback.createdAt,
  }
}

/**
 * Supabase-backed implementation of the FeedbackRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while writes are also persisted
 * to the `job_feedback` table asynchronously.
 *
 * Write durability: save() is queue-durable via enqueuePendingMutation.
 * The queue operation is 'insert' (flushPendingMutations uses upsert with
 * onConflict: 'id'), which is idempotent since feedback.id is a unique UUID.
 * A pre-flight guard prevents duplicate writes when a pending INSERT exists.
 */
export class SupabaseFeedbackRepository implements FeedbackRepository {
  private feedbacks: JobFeedback[] = []
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
      .from('job_feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.feedbacks = ((data ?? []) as FeedbackRow[]).map(rowToFeedback)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.feedbacks = []
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

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'job_feedback' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.feedbacks.some((f) => f.id === m.entityId)) continue
      try {
        const feedback = rowToFeedback(m.payload as unknown as FeedbackRow)
        this.feedbacks = [feedback, ...this.feedbacks]
      } catch { /* malformed payload */ }
    }
  }

  getByJobId(jobId: string): JobFeedback | undefined {
    return this.feedbacks.find((f) => f.jobId === jobId)
  }

  getByCraftsmanId(craftsmanUserId: string): JobFeedback[] {
    return this.feedbacks.filter((f) => f.craftsmanUserId === craftsmanUserId)
  }

  save(feedback: JobFeedback): void {
    const idx = this.feedbacks.findIndex((f) => f.jobId === feedback.jobId)
    if (idx >= 0) {
      this.feedbacks[idx] = feedback
    } else {
      this.feedbacks = [...this.feedbacks, feedback]
    }
    this.notify()

    // Pending guard: if a prior save() for this feedback already failed and
    // is queued for replay, the DB row does not exist yet. A second DB upsert
    // attempt would also fail (offline) and produce a stale second enqueue,
    // but more critically the local state has already changed — if we just skip,
    // the queued INSERT would eventually replay the old note/wouldHireAgain values.
    // Instead, merge the latest row into the existing INSERT payload so replay
    // produces the correct final state.
    if (hasPendingMutationForEntity('job_feedback', feedback.id)) {
      enqueuePendingMutation({
        operation: 'insert',
        table: 'job_feedback',
        payload: feedbackToRow(feedback) as unknown as Record<string, unknown>,
        domain: 'feedback',
        entityId: feedback.id,
      })
      logInfo('repository.feedback.save_merged_pending', { entityId: feedback.id })
      return
    }

    supabase
      .from('job_feedback')
      .upsert(feedbackToRow(feedback), { onConflict: 'job_id' })
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            logError('repository.feedback.save_failed', error, { entityId: feedback.id })
            recordPersistenceFailure({ domain: 'feedback', operation: 'add', entityId: feedback.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.feedback.save_failed', error, { entityId: feedback.id })
          recordPersistenceFailure({
            domain: 'feedback',
            operation: 'add',
            entityId: feedback.id,
            error,
            occurredAt: Date.now(),
          })
          // Queue as 'insert': flushPendingMutations uses upsert(onConflict: 'id')
          // which is idempotent for rows with a unique UUID id field.
          enqueuePendingMutation({
            operation: 'insert',
            table: 'job_feedback',
            payload: feedbackToRow(feedback) as unknown as Record<string, unknown>,
            domain: 'feedback',
            entityId: feedback.id,
          })
        }
      })
  }

}
