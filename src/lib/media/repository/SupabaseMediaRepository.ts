import { supabase } from '../../supabase'
import { recordPersistenceFailure, enqueuePendingMutation, hasPendingMutationForEntity, getPendingMutations, isServerSideError, isDuplicateKeyError } from '../../persistence'
import { logError, logInfo } from '../../observability'
import type { MediaArtifact, MediaArtifactKind } from '../types'
import type { MediaRepository } from './MediaRepository'

type Listener = () => void

interface MediaArtifactRow {
  id: string
  job_id: string
  kind: string
  label: string
  filename: string
  mime_type: string
  uploaded_at: number
  uploaded_by: string
  notes: string | null
  dispute_id: string | null
  timeline_event_id: string | null
}

function rowToArtifact(row: MediaArtifactRow): MediaArtifact {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind as MediaArtifactKind,
    label: row.label,
    filename: row.filename,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
    ...(row.notes != null && { notes: row.notes }),
    ...(row.dispute_id != null && { disputeId: row.dispute_id }),
    ...(row.timeline_event_id != null && {
      timelineEventId: row.timeline_event_id,
    }),
  }
}

function artifactToRow(artifact: MediaArtifact): MediaArtifactRow {
  return {
    id: artifact.id,
    job_id: artifact.jobId,
    kind: artifact.kind,
    label: artifact.label,
    filename: artifact.filename,
    mime_type: artifact.mimeType,
    uploaded_at: artifact.uploadedAt,
    uploaded_by: artifact.uploadedBy,
    notes: artifact.notes ?? null,
    dispute_id: artifact.disputeId ?? null,
    timeline_event_id: artifact.timelineEventId ?? null,
  }
}

/**
 * Supabase-backed implementation of the MediaRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `media_artifacts` table asynchronously.
 *
 * Write durability: add() is queue-durable via enqueuePendingMutation.
 * A pre-flight guard prevents duplicate writes when a pending INSERT
 * already exists for the same artifact ID.
 */
export class SupabaseMediaRepository implements MediaRepository {
  private artifacts: MediaArtifact[] = []
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
      .from('media_artifacts')
      .select('*')
      .order('uploaded_at', { ascending: false })
      .limit(500)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.artifacts = ((data ?? []) as MediaArtifactRow[]).map(rowToArtifact)
    this.hydrateFromQueue(uid)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.artifacts = []
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

  notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): MediaArtifact[] {
    return [...this.artifacts]
  }

  getByJobId(jobId: string): MediaArtifact[] {
    return this.artifacts
      .filter((a) => a.jobId === jobId)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
  }

  getById(id: string): MediaArtifact | undefined {
    return this.artifacts.find((a) => a.id === id)
  }

  getByDisputeId(disputeId: string): MediaArtifact[] {
    return this.artifacts
      .filter((a) => a.disputeId === disputeId)
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
  }

  private hydrateFromQueue(uid: string): void {
    const pending = getPendingMutations()
    for (const m of pending) {
      if (m.table !== 'media_artifacts' || m.operation !== 'insert') continue
      if (m.userId && m.userId !== uid) continue
      if (this.artifacts.some((a) => a.id === m.entityId)) continue
      try {
        const artifact = rowToArtifact(m.payload as unknown as MediaArtifactRow)
        this.artifacts = [artifact, ...this.artifacts]
      } catch { /* malformed payload */ }
    }
  }

  add(artifact: MediaArtifact): void {
    const alreadyExists = this.artifacts.some((a) => a.id === artifact.id)
    if (alreadyExists) return

    this.artifacts = [...this.artifacts, artifact].sort(
      (a, b) => b.uploadedAt - a.uploadedAt,
    )
    this.notify()

    // Pending guard: if a prior add() for this artifact already failed and is
    // queued for replay, skip the write — the queue covers it.
    if (hasPendingMutationForEntity('media_artifacts', artifact.id)) {
      logInfo('repository.media.add_skipped_pending', { entityId: artifact.id })
      return
    }

    supabase
      .from('media_artifacts')
      .insert(artifactToRow(artifact))
      .then(({ error }) => {
        if (error) {
          if (isServerSideError(error)) {
            this.artifacts = this.artifacts.filter((a) => a.id !== artifact.id)
            this.notify()
            if (isDuplicateKeyError(error)) {
              void supabase.from('media_artifacts').select('*').eq('id', artifact.id).single().then(({ data }) => {
                if (data) {
                  this.artifacts = [rowToArtifact(data as MediaArtifactRow), ...this.artifacts]
                  this.notify()
                }
              })
              return
            }
            logError('repository.media.add_failed', error, { entityId: artifact.id, kind: artifact.kind })
            recordPersistenceFailure({ domain: 'media', operation: 'add', entityId: artifact.id, error, occurredAt: Date.now() })
            return
          }
          logError('repository.media.add_failed', error, { entityId: artifact.id, kind: artifact.kind })
          recordPersistenceFailure({
            domain: 'media',
            operation: 'add',
            entityId: artifact.id,
            error,
            occurredAt: Date.now(),
          })
          enqueuePendingMutation({
            operation: 'insert',
            table: 'media_artifacts',
            payload: artifactToRow(artifact) as unknown as Record<string, unknown>,
            domain: 'media',
            entityId: artifact.id,
          })
        }
      })
  }
}
