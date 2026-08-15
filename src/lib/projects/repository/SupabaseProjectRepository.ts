import { supabase } from '../../supabase'
import { recordPersistenceFailure } from '../../persistence'
import { logError } from '../../observability'
import type { Project } from '../projectTypes'
import type { ProjectRepository } from './ProjectRepository'
import { isValidProjectId } from '../projectId'

type Listener = () => void

/**
 * Shape of a `projects` row as stored in the Supabase database.
 * Nested objects are persisted as JSONB.
 * Timestamps are persisted as timestamptz strings; the domain model
 * uses millisecond epoch numbers, so the repository converts on
 * read (ISO → ms) and write (ms → ISO).
 *
 * The table is created by the migration in
 * supabase/migrations/20240101000000_jobs_projects_schema.sql.
 */
interface ProjectRow {
  id: string
  source_job_id: string | null
  title: string
  location: string
  status: string
  created_at: string | null
  updated_at: string | null
  customer_profile_id: string | null
  customer_user_id: string | null
  craftsman_user_id: string | null
  // Legacy columns kept optional for legacy rows returned by Supabase.
  customer?: string
  craftsman?: string
  date_label?: string
  price?: string
  payment_state?: string
  message_count?: number | null
  note_count?: number | null
  photo_count?: number | null
  source?: string | null
  description?: string | null
  requested_budget?: string | null
  requested_timing?: string | null
  category?: string | null
  room_scan_url?: string | null
  room_scan_metadata?: Record<string, unknown> | null
}

function rowToProject(row: ProjectRow): Project {
  const createdAtMs = row.created_at ? new Date(row.created_at).getTime() : Date.now()
  const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  const ownerId = row.customer_profile_id ?? row.customer_user_id ?? null

  return {
    id: row.id ?? '',
    sourceJobId: row.source_job_id ?? '',
    title: row.title ?? '',
    customer: row.customer ?? '',
    craftsman: row.craftsman ?? '',
    location: row.location ?? '',
    dateLabel: row.date_label ?? 'Termin offen',
    price: row.price ?? '',
    status: (row.status ?? 'request') as Project['status'],
    paymentState: (row.payment_state ?? 'none') as Project['paymentState'],
    messageCount: row.message_count ?? 0,
    noteCount: row.note_count ?? 0,
    photoCount: row.photo_count ?? 0,
    createdAt: createdAtMs,
    updatedAt: updatedAtMs,
    ...(row.source != null && { source: row.source as Project['source'] }),
    ...(row.description != null && { description: row.description }),
    ...(row.requested_budget != null && { requestedBudget: row.requested_budget }),
    ...(row.requested_timing != null && { requestedTiming: row.requested_timing }),
    ...(row.category != null && { category: row.category }),
    ...(row.craftsman_user_id != null && { craftsmanUserId: row.craftsman_user_id }),
    ...(ownerId != null && { customerUserId: ownerId }),
    ...(row.room_scan_url != null && { roomScanUrl: row.room_scan_url }),
    ...(row.room_scan_metadata != null && { roomScanMetadata: row.room_scan_metadata as unknown as import('../../roomScan/types').RoomScanMetadata }),
  }
}

function normalizeOptionalUuid(value?: string | null): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function projectToRow(project: Project): ProjectRow {
  return {
    id: project.id,
    source_job_id: normalizeOptionalUuid(project.sourceJobId),
    title: project.title,
    location: project.location,
    status: project.status,
    created_at: new Date(project.createdAt).toISOString(),
    updated_at: new Date(project.updatedAt).toISOString(),
    customer_profile_id: normalizeOptionalUuid(project.customerUserId),
    customer_user_id: normalizeOptionalUuid(project.customerUserId),
    craftsman_user_id: normalizeOptionalUuid(project.craftsmanUserId),
    // Block 2B: builder identity — must survive reload so isBuilderProject
    // resolves correctly and builder-specific content (description, budget,
    // timing) is not lost after a page reload.
    source: project.source ?? null,
    description: project.description ?? null,
    requested_budget: project.requestedBudget ?? null,
    requested_timing: project.requestedTiming ?? null,
    category: project.category ?? null,
    // Block 2B: payment state — written durably so reload does not briefly
    // or persistently show the stale DB default ('deposit_required') instead
    // of the true payment state.
    payment_state: project.paymentState,
  }
}

function normalizeSupabaseError(error: unknown): Error {
  if (error instanceof Error) return error

  if (error && typeof error === 'object') {
    const { code, message, details, hint } = error as {
      code?: string
      message?: string
      details?: string
      hint?: string
    }
    const parts = [code, message, details, hint].filter((part): part is string => Boolean(part))
    if (parts.length > 0) {
      return new Error(parts.join(' | '))
    }
  }

  return new Error('Project insert failed')
}

/**
 * Supabase-backed implementation of the ProjectRepository interface.
 *
 * Uses a local in-memory cache to serve synchronous reads, keeping
 * the reactive subscription model intact while all writes are also
 * persisted to the `projects` table asynchronously.
 *
 * Bootstrap sequence:
 * 1. Construct the repository.
 * 2. Register it via `setProjectRepository()`.
 * 3. Await `initializeProjectRepository()` (or `repo.initialize()` directly) to
 *    load the initial dataset from Supabase before the UI first renders.
 *
 * Write path (optimistic):
 * - `add()` / `update()` update the local cache and notify subscribers
 *   immediately so the UI stays responsive.
 * - The corresponding Supabase mutation is fired in the background.
 *   Failures are recorded via `recordPersistenceFailure`.
 */
export class SupabaseProjectRepository implements ProjectRepository {
  private projects: Project[] = []
  private authUnsubscribe: (() => void) | null = null
  private readonly listeners = new Set<Listener>()
  private _hydrated = false
  private currentUid: string | null = null
  private _initPromise: Promise<void> | null = null
  private _loadGeneration = 0
  /** De-dupes concurrent lazy-by-id fetches (see ensureLoaded). */
  private readonly inFlightById = new Map<string, Promise<void>>()

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
      if (generation !== this._loadGeneration) return
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
    // Ownership identity MUST mirror the projects RLS policy "Projects: read own"
    // and rowToProject's owner derivation — both key the customer on
    // customer_profile_id (= auth.uid()), NOT customer_user_id. App-created rows
    // set both columns to the same uid, but rows created via other paths can carry
    // only customer_profile_id; filtering on customer_user_id alone makes the client
    // stricter than RLS and silently under-fetches profile-only-owned projects.
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .or(`customer_profile_id.eq.${uid},customer_user_id.eq.${uid},craftsman_user_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) throw error
    if (this.currentUid !== uid || generationSnapshot !== this._loadGeneration) return
    this.projects = (data as ProjectRow[]).map(rowToProject)
    this.notify()
  }

  private resetState(): void {
    this._initPromise = null
    this.currentUid = null
    this.projects = []
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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  getAll(): Project[] {
    return [...this.projects]
  }

  getById(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  /**
   * Lazy-fetch a single project by id when it is absent from the owner-scoped
   * initial cache (loadForUser only loads own/linked projects). RLS gates the
   * read: a recipient craftsman only receives the row if the project was
   * shared into a chat thread they participate in
   * (`projects_select_shared_in_chat_thread`). Best-effort + idempotent — a
   * missing/forbidden row resolves silently (the card stays a skeleton) and
   * concurrent calls for the same id share one request.
   */
  async ensureLoaded(id: string): Promise<void> {
    if (!id || this.getById(id)) return
    const inFlight = this.inFlightById.get(id)
    if (inFlight) return inFlight
    const promise = (async () => {
      try {
        const { data, error } = await supabase
          .from('projects')
          .select('*')
          .eq('id', id)
          .maybeSingle()
        if (error) {
          logError('repository.projects.ensure_loaded_failed', error, { entityId: id })
          return
        }
        // No row (genuinely absent or RLS-filtered), or it raced into the
        // cache via another path — nothing to merge.
        if (!data || this.getById(id)) return
        this.projects = [rowToProject(data as ProjectRow), ...this.projects]
        this.notify()
      } catch (err) {
        logError('repository.projects.ensure_loaded_failed', err, { entityId: id })
      } finally {
        this.inFlightById.delete(id)
      }
    })()
    this.inFlightById.set(id, promise)
    return promise
  }

  getByJobId(jobId: string): Project | undefined {
    return this.projects.find((p) => p.sourceJobId === jobId)
  }

  async add(project: Project): Promise<void> {
    const {
      data: { session },
      error: authError,
    } = await supabase.auth.getSession()

    if (authError) {
      const normalized = normalizeSupabaseError(authError)
      logError('repository.projects.add_failed', normalized, { entityId: project.id, reason: 'auth_session_error' })
      throw normalized
    }

    if (!session?.access_token) {
      const missingAuthError = new Error('Project insert failed: missing authenticated session.')
      logError('repository.projects.add_failed', missingAuthError, { entityId: project.id, reason: 'auth_session_missing' })
      throw missingAuthError
    }

    if (!isValidProjectId(project.id)) {
      const invalidIdError = new Error('Project insert failed: id must be a valid UUID.')
      logError('repository.projects.add_failed', invalidIdError, { entityId: project.id, reason: 'invalid_project_id' })
      throw invalidIdError
    }

    this.projects = [...this.projects, project]
    this.notify()

    const rollbackOptimisticInsert = () => {
      this.projects = this.projects.filter((p) => p.id !== project.id)
      this.notify()
    }

    const insertPayload = {
      id: project.id,
      source_job_id: normalizeOptionalUuid(project.sourceJobId),
      title: project.title,
      customer_profile_id: normalizeOptionalUuid(project.customerUserId),
      customer_user_id: normalizeOptionalUuid(project.customerUserId),
      craftsman_user_id: normalizeOptionalUuid(project.craftsmanUserId),
      location: project.location,
      status: project.status,
      created_at: new Date(project.createdAt).toISOString(),
      updated_at: new Date(project.updatedAt).toISOString(),
      // These fields must be written on insert so a reload before the first
      // update() doesn't produce a row with wrong DB defaults.
      payment_state: project.paymentState,
      source: project.source ?? null,
      description: project.description ?? null,
      requested_budget: project.requestedBudget ?? null,
      requested_timing: project.requestedTiming ?? null,
      category: project.category ?? null,
    }

    let supabaseError: unknown = null
    try {
      const { error } = await supabase.from('projects').insert(insertPayload)
      supabaseError = error
    } catch (err) {
      supabaseError = err
    }

    if (supabaseError) {
      // Duplicate-key errors indicate the project already exists in persistence.
      // Treat this as idempotent success and keep the optimistic insert intact.
      if ((supabaseError as { code?: string }).code === '23505') return

      rollbackOptimisticInsert()

      const normalizedError = normalizeSupabaseError(supabaseError)

      logError('repository.projects.add_failed', normalizedError, { entityId: project.id })
      recordPersistenceFailure({
        domain: 'projects',
        operation: 'add',
        entityId: project.id,
        error: normalizedError,
        occurredAt: Date.now(),
      })
      throw normalizedError
    }
  }

  async update(projectId: string, updates: Partial<Project>): Promise<Project | undefined> {
    const previous = this.projects.find((p) => p.id === projectId)
    let updatedProject: Project | undefined

    this.projects = this.projects.map((project) => {
      if (project.id !== projectId) return project

      updatedProject = {
        ...project,
        ...updates,
        updatedAt: Date.now(),
      }

      return updatedProject
    })

    if (updatedProject) {
      this.notify()
      const { error } = await supabase
        .from('projects')
        .update(projectToRow(updatedProject))
        .eq('id', projectId)
      if (error) {
        // Roll back the optimistic update so the in-memory cache does not
        // permanently diverge from persisted truth after a failed write.
        if (previous) {
          this.projects = this.projects.map((p) => (p.id === projectId ? previous : p))
          this.notify()
        }
        logError('repository.projects.update_failed', error, { entityId: projectId })
        recordPersistenceFailure({ domain: 'projects', operation: 'update', entityId: projectId, error, occurredAt: Date.now() })
        throw error
      }
    }

    return updatedProject
  }

  reset(): void {
    this.resetState()
  }

  prepareForResync(): void {
    this._initPromise = null
    this._loadGeneration++
  }
}
