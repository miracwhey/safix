/**
 * Spatial · Canonical · Repository · InMemorySpatialSceneRepository
 *
 * Single-process implementation used by unit / integration tests. Keeps the
 * same FSM + validation behaviour as the Supabase implementation so test-
 * green here closely predicts production behaviour.
 *
 * IDs are uuid v4 strings; the in-memory implementation uses `crypto.randomUUID()`
 * (available in Node ≥ 14.17 and in every modern browser).
 */

import { CanonicalError } from '../types/errors.ts'
import type {
  AppendEditHistoryInput,
  CreateChangeOrderInput,
  CreateRescanRequestInput,
  CreateSpatialSceneInput,
  PinReview,
  SpatialChangeOrder,
  SpatialEditHistoryEntry,
  SpatialRescanRequest,
  SpatialScene,
  SpatialSceneRepository,
  UpdateCustomerVerifyStateInput,
  UpdateSpatialSceneInput,
  UpsertPinReviewInput,
} from './SpatialSceneRepository.ts'
import {
  assertChangeOrderStatusTransition,
  assertCustomerVerifyStateTransition,
  assertValidationStateTransition,
  type ChangeOrderStatus,
} from './spatialSceneFsm.ts'

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return crypto.randomUUID()
}

/**
 * Deep-clone a stored row before crossing the repository boundary. Using
 * structuredClone (Node 17+, all evergreen browsers) ensures callers cannot
 * mutate the internal store by mutating a returned value (H-B4 audit-fix).
 *
 * The cast is safe — every shape the repository handles is structured-
 * clone-compatible (no functions, no DOM nodes, no class instances besides
 * plain objects).
 */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Optional configuration accepted by {@link InMemorySpatialSceneRepository}
 * so the in-memory implementation can match the Supabase repository's
 * actor-attribution semantics in tests.
 *
 * - `actorIdProvider` — invoked at every audit-write to determine the
 *   acting user. Mirrors Supabase's `auth.uid()`; when absent, edit-history
 *   rows have `actor_id = null` (V1 default — same as Supabase when called
 *   from an unauthenticated context). H-B1 audit-fix.
 * - `enforceProposerIdMatchesActor` — when true, `createChangeOrder`
 *   rejects payloads whose `proposerId` doesn't match the actor. Mirrors
 *   the Supabase RLS WITH CHECK enforcement so test-time misuse of the
 *   InMemory repository surfaces as a clear error. H-B2 audit-fix.
 */
export interface InMemorySpatialSceneRepositoryOptions {
  actorIdProvider?: () => string | null
  enforceProposerIdMatchesActor?: boolean
}

export class InMemorySpatialSceneRepository implements SpatialSceneRepository {
  private scenes = new Map<string, SpatialScene>()
  private history: SpatialEditHistoryEntry[] = []
  private changeOrders = new Map<string, SpatialChangeOrder>()
  /** Keyed `${sceneId}|${annotationNodeId}|${providerOrgId}` (the UNIQUE tuple). */
  private pinReviews = new Map<string, PinReview>()
  private rescanRequests = new Map<string, SpatialRescanRequest>()
  private readonly actorIdProvider: () => string | null
  private readonly enforceProposerIdMatchesActor: boolean

  constructor(options: InMemorySpatialSceneRepositoryOptions = {}) {
    this.actorIdProvider = options.actorIdProvider ?? (() => null)
    this.enforceProposerIdMatchesActor = options.enforceProposerIdMatchesActor ?? false
  }

  async create(input: CreateSpatialSceneInput): Promise<SpatialScene> {
    if (!input.parametricStoragePath) {
      throw new CanonicalError('INVALID_INPUT', 'parametricStoragePath is required')
    }
    if (
      (input.sourceScanId === undefined || input.sourceScanId === null) &&
      (input.sourceJobId === undefined || input.sourceJobId === null)
    ) {
      throw new CanonicalError(
        'INVALID_INPUT',
        'At least one of sourceScanId or sourceJobId must be set (R4)',
      )
    }

    // ── D2 · B7 · Re-scan-request linkage (mirror of the RPC body) ────────
    // The InMemory implementation enforces the same data-shape invariants
    // the Supabase RPC enforces: request must exist, must be accepted, the
    // parent_scene_id must match the request's scene_id when both are
    // supplied, and the request is short-circuited idempotently when a
    // resulting scene already exists. Auth (customer-only check) is NOT
    // mirrored — InMemory has no real auth.uid().
    let effectiveParent: string | null = input.parentSceneId ?? null
    if (input.rescanRequestId) {
      const request = this.rescanRequests.get(input.rescanRequestId)
      if (!request) {
        throw new CanonicalError(
          'INVALID_INPUT',
          `rescanRequest ${input.rescanRequestId} not found`,
        )
      }
      if (request.resultingSceneId) {
        // Idempotent: a fulfilled request returns its previously-linked scene.
        const existing = this.scenes.get(request.resultingSceneId)
        if (existing) return clone(existing)
      }
      if (request.status !== 'accepted') {
        throw new CanonicalError(
          'INVALID_INPUT',
          `rescanRequest status must be accepted (got ${request.status})`,
        )
      }
      if (effectiveParent === null) {
        effectiveParent = request.sceneId
      } else if (effectiveParent !== request.sceneId) {
        throw new CanonicalError(
          'INVALID_INPUT',
          'parentSceneId must match rescanRequest.sceneId',
        )
      }
    }

    // Source-scan idempotency — one scan → one scene (mirrors the partial
    // unique index on the Postgres side).
    if (input.sourceScanId) {
      const sceneForScan = [...this.scenes.values()].find(
        (s) => s.sourceScanId === input.sourceScanId,
      )
      if (sceneForScan) return clone(sceneForScan)
    }

    const now = nowIso()
    const hasReport =
      input.validationReport !== undefined &&
      Object.keys(input.validationReport).length > 0
    const scene: SpatialScene = {
      // Accept a client-generated id so the InMemory path matches the Supabase
      // path, where promoteScanToScene generates the uuid up-front to embed it
      // in the Storage blob path. Falls back to a fresh uuid when omitted.
      id: input.id ?? newId(),
      sourceScanId: input.sourceScanId ?? null,
      sourceJobId: input.sourceJobId ?? null,
      parametricStoragePath: input.parametricStoragePath,
      parametricSizeBytes: input.parametricSizeBytes ?? null,
      parametricSha256: input.parametricSha256 ?? null,
      // H1 audit-fix · new rows start at version 0 (mirrors the DB DEFAULT).
      parametricVersion: 0,
      schemaVersion: input.schemaVersion ?? '1.0',
      validationState: input.validationState ?? 'pending',
      isRenderable: input.isRenderable ?? false,
      requiresUserConfirmation: input.requiresUserConfirmation ?? false,
      customerVerifyState: input.customerVerifyState ?? 'not_started',
      customerVerifyLastStage: input.customerVerifyLastStage ?? null,
      customerVerifyLastActiveAt: input.customerVerifyLastActiveAt ?? null,
      customerId: input.customerId ?? null,
      providerId: input.providerId ?? null,
      // InMemory has no `providers` table, so it cannot replicate the DB
      // trigger's provider_id → provider_org_id derivation. Tests that need an
      // org link pass `providerOrgId` explicitly.
      providerOrgId: input.providerOrgId ?? null,
      parentSceneId: effectiveParent,
      // Mirror the spatial_create_scene RPC: a non-empty validationReport is
      // folded into metadata.validation_report (there is no dedicated column).
      metadata: hasReport
        ? { ...(input.metadata ?? {}), validation_report: input.validationReport }
        : (input.metadata ?? {}),
      // Lane-2.5 · Stream B — InMemory create() is only reached for the legacy
      // roomplan path (manual scenes go through spatial_create_manual_scene
      // which the InMemory repo does not surface). Default 'roomplan'.
      origin: 'roomplan',
      createdAt: now,
      updatedAt: now,
    }
    if (this.scenes.has(scene.id)) {
      throw new CanonicalError('INVALID_INPUT', `SpatialScene ${scene.id} already exists`)
    }
    this.scenes.set(scene.id, clone(scene))

    // Atomically link the new scene back to the rescan_request (D2 · B7).
    // Mirrors the RPC's post-insert UPDATE.
    if (input.rescanRequestId) {
      const request = this.rescanRequests.get(input.rescanRequestId)
      if (request) {
        this.rescanRequests.set(input.rescanRequestId, {
          ...request,
          resultingSceneId: scene.id,
          updatedAt: nowIso(),
        })
      }
    }

    return clone(scene)
  }

  async findById(id: string): Promise<SpatialScene | null> {
    const found = this.scenes.get(id)
    return found ? clone(found) : null
  }

  async findBySourceScan(scanId: string): Promise<SpatialScene | null> {
    // `source_scan_id` is UNIQUE in the schema — at most one scene matches.
    const found = [...this.scenes.values()].find((s) => s.sourceScanId === scanId)
    return found ? clone(found) : null
  }

  async findBySourceJob(jobId: string): Promise<SpatialScene | null> {
    const found = [...this.scenes.values()]
      .filter((s) => s.sourceJobId === jobId)
      // Newest first — mirrors the Supabase `order created_at desc` so a job
      // with several scenes resolves the same scene in both implementations.
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    return found ? clone(found) : null
  }

  async findByPresalesProject(presalesProjectId: string): Promise<SpatialScene | null> {
    // Lane-2.5 · Stream B — manual scenes anchor via metadata.presales_project_id.
    const found = [...this.scenes.values()]
      .filter(
        (s) =>
          (s.origin === 'manual' || s.origin === 'example_room') &&
          (s.metadata as Record<string, unknown>)?.presales_project_id ===
            presalesProjectId,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    return found ? clone(found) : null
  }

  async listByCustomer(customerId: string): Promise<SpatialScene[]> {
    return [...this.scenes.values()]
      .filter((s) => s.customerId === customerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone)
  }

  async listByProvider(providerId: string): Promise<SpatialScene[]> {
    return [...this.scenes.values()]
      .filter((s) => s.providerId === providerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone)
  }

  async listByProviderOrg(providerOrgId: string): Promise<SpatialScene[]> {
    return [...this.scenes.values()]
      .filter((s) => s.providerOrgId === providerOrgId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone)
  }

  async update(id: string, input: UpdateSpatialSceneInput): Promise<SpatialScene> {
    const existing = this.scenes.get(id)
    if (!existing) throw new CanonicalError('NOT_FOUND', `SpatialScene ${id} not found`)

    if (input.validationState !== undefined) {
      assertValidationStateTransition(existing.validationState, input.validationState)
    }
    if (input.customerVerifyState !== undefined) {
      assertCustomerVerifyStateTransition(
        existing.customerVerifyState,
        input.customerVerifyState,
      )
    }

    const updated: SpatialScene = {
      ...existing,
      ...(input.parametricStoragePath !== undefined && {
        parametricStoragePath: input.parametricStoragePath,
      }),
      ...(input.parametricSizeBytes !== undefined && {
        parametricSizeBytes: input.parametricSizeBytes,
      }),
      ...(input.parametricSha256 !== undefined && {
        parametricSha256: input.parametricSha256,
      }),
      ...(input.schemaVersion !== undefined && { schemaVersion: input.schemaVersion }),
      ...(input.validationState !== undefined && {
        validationState: input.validationState,
      }),
      ...(input.isRenderable !== undefined && { isRenderable: input.isRenderable }),
      ...(input.requiresUserConfirmation !== undefined && {
        requiresUserConfirmation: input.requiresUserConfirmation,
      }),
      ...(input.customerVerifyState !== undefined && {
        customerVerifyState: input.customerVerifyState,
      }),
      ...(input.customerVerifyLastStage !== undefined && {
        customerVerifyLastStage: input.customerVerifyLastStage,
      }),
      ...(input.customerVerifyLastActiveAt !== undefined && {
        customerVerifyLastActiveAt: input.customerVerifyLastActiveAt,
      }),
      ...(input.customerId !== undefined && { customerId: input.customerId }),
      ...(input.providerId !== undefined && { providerId: input.providerId }),
      ...(input.providerOrgId !== undefined && { providerOrgId: input.providerOrgId }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      // H1 audit-fix · mirror the Supabase compare-and-set bump so the version
      // advances symmetrically in tests (InMemory is single-process — no real
      // race — but keeping the field in lock-step avoids surprising assertions).
      parametricVersion: (existing.parametricVersion ?? 0) + 1,
      updatedAt: nowIso(),
    }
    this.scenes.set(id, clone(updated))
    return clone(updated)
  }

  /**
   * Column-scoped verify-state write (mirror of the Supabase SECURITY DEFINER
   * RPC `spatial_set_customer_verify_state`). Writes ONLY the verify columns and
   * does NOT bump `parametricVersion` — verify-state is not a blob write, so the
   * Supabase RPC leaves the version untouched and InMemory matches that. The
   * FSM is asserted exactly as {@link update} does.
   */
  async updateCustomerVerifyState(
    id: string,
    input: UpdateCustomerVerifyStateInput,
  ): Promise<SpatialScene> {
    const existing = this.scenes.get(id)
    if (!existing) throw new CanonicalError('NOT_FOUND', `SpatialScene ${id} not found`)

    if (input.customerVerifyState !== undefined) {
      assertCustomerVerifyStateTransition(
        existing.customerVerifyState,
        input.customerVerifyState,
      )
    }

    const updated: SpatialScene = {
      ...existing,
      ...(input.customerVerifyState !== undefined && {
        customerVerifyState: input.customerVerifyState,
      }),
      ...(input.customerVerifyLastStage !== undefined && {
        customerVerifyLastStage: input.customerVerifyLastStage,
      }),
      ...(input.customerVerifyLastActiveAt !== undefined && {
        customerVerifyLastActiveAt: input.customerVerifyLastActiveAt,
      }),
      updatedAt: nowIso(),
    }
    this.scenes.set(id, clone(updated))
    return clone(updated)
  }

  async delete(id: string): Promise<void> {
    if (!this.scenes.has(id)) {
      throw new CanonicalError('NOT_FOUND', `SpatialScene ${id} not found`)
    }
    this.scenes.delete(id)
    this.history = this.history.filter((h) => h.sceneId !== id)
    for (const co of [...this.changeOrders.values()]) {
      if (co.sceneId === id) this.changeOrders.delete(co.id)
    }
  }

  async appendEditHistory(input: AppendEditHistoryInput): Promise<SpatialEditHistoryEntry> {
    const scene = this.scenes.get(input.sceneId)
    if (!scene) {
      throw new CanonicalError('NOT_FOUND', `SpatialScene ${input.sceneId} not found`)
    }
    const entry: SpatialEditHistoryEntry = {
      id: newId(),
      sceneId: input.sceneId,
      // Mirrors the Supabase RPC: provider_org_id is stamped from the scene.
      providerOrgId: scene.providerOrgId,
      // Mirrors Supabase's SECURITY DEFINER RPC: actorId is server-determined
      // from `auth.uid()`. The InMemory mirror lets tests inject the same
      // value via the constructor option so audit rows aren't always null.
      actorId: this.actorIdProvider(),
      variantId: input.variantId,
      baseNodeId: input.baseNodeId,
      overrideFields: input.overrideFields,
      command: input.command,
      parametricSha256Before: input.parametricSha256Before ?? null,
      parametricSha256After: input.parametricSha256After ?? null,
      createdAt: nowIso(),
    }
    this.history.push(clone(entry))
    return clone(entry)
  }

  async listEditHistory(sceneId: string, limit?: number): Promise<SpatialEditHistoryEntry[]> {
    const filtered = this.history
      .filter((h) => h.sceneId === sceneId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    const sliced = typeof limit === 'number' ? filtered.slice(0, limit) : filtered
    return sliced.map(clone)
  }

  async createChangeOrder(input: CreateChangeOrderInput): Promise<SpatialChangeOrder> {
    if (!this.scenes.has(input.sceneId)) {
      throw new CanonicalError('NOT_FOUND', `SpatialScene ${input.sceneId} not found`)
    }
    if (this.enforceProposerIdMatchesActor) {
      const actor = this.actorIdProvider()
      if (actor === null || actor !== input.proposerId) {
        throw new CanonicalError(
          'FORBIDDEN',
          `createChangeOrder: proposerId ${input.proposerId} does not match acting user ${actor ?? 'null'} ` +
            '(Supabase RLS would reject this insert).',
        )
      }
    }
    const now = nowIso()
    const co: SpatialChangeOrder = {
      id: newId(),
      sceneId: input.sceneId,
      nodeId: input.nodeId ?? null,
      proposerId: input.proposerId,
      status: 'proposed',
      title: input.title,
      body: input.body ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.changeOrders.set(co.id, clone(co))
    return clone(co)
  }

  async updateChangeOrderStatus(
    id: string,
    to: ChangeOrderStatus,
  ): Promise<SpatialChangeOrder> {
    const existing = this.changeOrders.get(id)
    if (!existing) throw new CanonicalError('NOT_FOUND', `ChangeOrder ${id} not found`)
    assertChangeOrderStatusTransition(existing.status, to)
    const updated: SpatialChangeOrder = { ...existing, status: to, updatedAt: nowIso() }
    this.changeOrders.set(id, clone(updated))
    return clone(updated)
  }

  async listChangeOrders(sceneId: string): Promise<SpatialChangeOrder[]> {
    return [...this.changeOrders.values()].filter((c) => c.sceneId === sceneId).map(clone)
  }

  // ── Pin reviews ────────────────────────────────────────────────────────────

  private pinReviewKey(sceneId: string, nodeId: string, orgId: string): string {
    return `${sceneId}|${nodeId}|${orgId}`
  }

  async listPinReviews(sceneId: string): Promise<PinReview[]> {
    return [...this.pinReviews.values()].filter((r) => r.sceneId === sceneId).map(clone)
  }

  async upsertPinReview(input: UpsertPinReviewInput): Promise<PinReview> {
    const key = this.pinReviewKey(
      input.sceneId,
      input.annotationNodeId,
      input.providerOrgId,
    )
    const now = nowIso()
    const existing = this.pinReviews.get(key)
    const review: PinReview = {
      id: existing?.id ?? newId(),
      sceneId: input.sceneId,
      providerOrgId: input.providerOrgId,
      annotationNodeId: input.annotationNodeId,
      reviewedByUserId: input.reviewedByUserId,
      reviewedByRole: input.reviewedByRole,
      reviewStatus: input.reviewStatus,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.pinReviews.set(key, clone(review))
    return clone(review)
  }

  async deletePinReview(
    sceneId: string,
    annotationNodeId: string,
    providerOrgId: string,
  ): Promise<void> {
    this.pinReviews.delete(this.pinReviewKey(sceneId, annotationNodeId, providerOrgId))
  }

  // ── Re-scan requests ───────────────────────────────────────────────────────

  async listRescanRequests(sceneId: string): Promise<SpatialRescanRequest[]> {
    return [...this.rescanRequests.values()]
      .filter((r) => r.sceneId === sceneId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone)
  }

  async findRescanRequestById(id: string): Promise<SpatialRescanRequest | null> {
    const found = this.rescanRequests.get(id)
    return found ? clone(found) : null
  }

  async createRescanRequest(
    input: CreateRescanRequestInput,
  ): Promise<SpatialRescanRequest> {
    const now = nowIso()
    const request: SpatialRescanRequest = {
      id: newId(),
      sceneId: input.sceneId,
      providerOrgId: input.providerOrgId,
      requestedByUserId: input.requestedByUserId,
      requestedByRole: input.requestedByRole,
      reason: input.reason,
      status: 'pending',
      responseNote: null,
      respondedAt: null,
      resultingSceneId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rescanRequests.set(request.id, clone(request))
    return clone(request)
  }

  async respondToRescanRequest(
    requestId: string,
    status: 'accepted' | 'rejected',
    note: string | null,
  ): Promise<boolean> {
    const existing = this.rescanRequests.get(requestId)
    if (!existing) {
      throw new CanonicalError('NOT_FOUND', `RescanRequest ${requestId} not found`)
    }
    // Idempotent — mirrors the SECURITY DEFINER RPC: only pending rows move.
    if (existing.status !== 'pending') return false
    const now = nowIso()
    this.rescanRequests.set(requestId, {
      ...existing,
      status,
      responseNote: note,
      respondedAt: now,
      updatedAt: now,
    })
    return true
  }
}
