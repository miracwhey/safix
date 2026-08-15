/**
 * Spatial · Canonical · Repository · SpatialSceneRepository (XM-5 audit-fix)
 *
 * Persistence contract for canonical scenes. Mirrors the Day-6 SQL schema
 * (`spatial_scenes` table) and the SaFix convention: DB uses snake_case;
 * TS uses camelCase; uuids are `string`; unix-ms is `number`; ISO-8601 is
 * `string` (canonical L1 always uses ISO).
 *
 * Two implementations:
 *   - {@link InMemorySpatialSceneRepository} — single-process testing.
 *   - {@link SupabaseSpatialSceneRepository} — production target.
 *
 * The parametric blob (RoomScene wire-format) is NOT stored as a column;
 * it lives in Supabase Storage at `parametric_storage_path`. The repository
 * is responsible for header-row CRUD only; the storage helper (`storage/
 * parametric-storage.ts`) handles blob read/write and SHA-256 derivation.
 */

import type {
  ChangeOrderStatus,
  CustomerVerifyState,
  ValidationState,
} from './spatialSceneFsm.ts'

/** Header row returned to consumers. */
export interface SpatialScene {
  id: string

  // Origins (R4: at least one must be set).
  sourceScanId: string | null
  sourceJobId: string | null

  // Storage pointer (D2: blob lives in Storage, not jsonb).
  parametricStoragePath: string
  parametricSizeBytes: number | null
  parametricSha256: string | null

  /**
   * Optimistic-concurrency token for the scene row (H1 audit-fix). Bumped on
   * every {@link SpatialSceneRepository.update}; the Supabase impl writes with a
   * compare-and-set (`.eq('parametric_version', expected)`) so a writer that
   * raced in first surfaces as `CanonicalError('CONFLICT')` instead of silently
   * clobbering the parametric blob pointer. DB column `parametric_version`
   * (`NOT NULL DEFAULT 0`, migration 20260601100000). The column-scoped
   * verify-state RPC ({@link SpatialSceneRepository.updateCustomerVerifyState})
   * does NOT touch this — verify-state is not a blob write.
   */
  parametricVersion: number

  schemaVersion: string

  validationState: ValidationState
  isRenderable: boolean
  requiresUserConfirmation: boolean

  customerVerifyState: CustomerVerifyState
  /**
   * The 1-5 verify sub-stage the customer last saw (Block 3.12). Drives the
   * App-Kill / Re-Enter resume target. `null` until the customer enters verify.
   * DB column `customer_verify_last_stage` (migration 20260520120040).
   */
  customerVerifyLastStage: number | null
  /**
   * ISO-8601 timestamp of the customer's last verify activity (Block 3.12).
   * Drives the VF-4 reminder cadence + the re-prompt copy. `null` until the
   * customer enters verify. DB column `customer_verify_last_active_at`.
   */
  customerVerifyLastActiveAt: string | null

  customerId: string | null
  providerId: string | null
  /**
   * The provider BUSINESS (`public.providers.id`) that owns this scene — the
   * multi-tenant Provider-Hub scope. Distinct from `providerId` (one auth
   * user). DB column `provider_org_id`; auto-derived from `provider_id` by the
   * `spatial_scenes_fill_provider_org` trigger (migration 20260520120046).
   */
  providerOrgId: string | null

  /**
   * The predecessor scene this one supersedes — set when this scene was
   * produced as a re-scan follow-up. `null` for root scenes. Immutable
   * post-insert (`spatial_scenes_immutable_cols_guard`). DB column
   * `parent_scene_id` (migration 20260522120054).
   */
  parentSceneId: string | null

  metadata: Record<string, unknown>

  /**
   * Lane-2.5 · Stream B — provenance of the scene geometry:
   *   - `'roomplan'`      · derived from a RoomPlan scan (the legacy path).
   *   - `'manual'`        · authored from a manual-start preset (2×2 / canvas).
   *   - `'example_room'`  · a curated sample-room asset (deferred L2-D).
   * DB column `origin` (migration 20260525000000). Default `'roomplan'` so
   * existing rows keep their semantics.
   */
  origin: 'roomplan' | 'manual' | 'example_room'

  createdAt: string
  updatedAt: string
}

/**
 * DTO accepted by {@link SpatialSceneRepository.create}.
 *
 * Required fields are validated client-side before the round-trip:
 *   - `parametricStoragePath` non-empty
 *   - at least one of `sourceScanId` / `sourceJobId` (mirrors the SQL CHECK)
 *
 * Defaults applied by the implementation:
 *   - `id` → generated (uuid v4) when omitted
 *   - `schemaVersion` → '1.0'
 *   - `validationState` → 'pending'
 *   - `isRenderable` / `requiresUserConfirmation` → false
 *   - `customerVerifyState` → 'not_started'
 *   - `customerVerifyLastStage` → null
 *   - `customerVerifyLastActiveAt` → null
 *   - `customerId` / `providerId` / `providerOrgId` → derived server-side from
 *     the scan/job context by the `spatial_create_scene` RPC (the Supabase
 *     path); honoured as-passed by the InMemory path
 *   - `metadata` → {}
 */
export interface CreateSpatialSceneInput {
  /**
   * Client-generated scene uuid. The id must exist before the row so the
   * Storage blob path can embed it (see `promoteScanToScene`). When omitted
   * the repository generates one — but the canonical workflow always supplies
   * it so the uploaded blob path and the row id agree.
   */
  id?: string
  sourceScanId?: string | null
  sourceJobId?: string | null
  parametricStoragePath: string
  parametricSizeBytes?: number | null
  parametricSha256?: string | null
  schemaVersion?: string
  validationState?: ValidationState
  isRenderable?: boolean
  requiresUserConfirmation?: boolean
  customerVerifyState?: CustomerVerifyState
  customerVerifyLastStage?: number | null
  customerVerifyLastActiveAt?: string | null
  customerId?: string | null
  providerId?: string | null
  /**
   * The provider business that owns the scene. Optional — when omitted, the
   * `spatial_scenes_fill_provider_org` DB trigger derives it from `providerId`.
   * Supply explicitly only to override the derived value.
   */
  providerOrgId?: string | null
  /**
   * Re-scan version linkage (D2 · B7). When set, the new scene records this
   * id as its `parent_scene_id` and the immutable-cols guard locks it in
   * post-insert. Required for `JobSpatialCompareTab` to diff parent ↔ child.
   * Either supplied directly, or derived server-side from `rescanRequestId`'s
   * `scene_id` — supplying both is allowed but they must match.
   */
  parentSceneId?: string | null
  /**
   * Re-scan request fulfilled by this scene (D2 · B7). When set, the
   * `spatial_create_scene` RPC enforces request.status='accepted', verifies
   * the caller is the parent scene's customer, and atomically writes the
   * new scene id onto `spatial_rescan_requests.resulting_scene_id`. A request
   * that already has a `resulting_scene_id` short-circuits and returns the
   * existing linked scene (idempotent).
   */
  rescanRequestId?: string | null
  metadata?: Record<string, unknown>
  /**
   * Optional validation report produced by the canonical converter. There is
   * no dedicated column — the `spatial_create_scene` RPC folds a non-empty
   * report into `metadata.validation_report`, and the InMemory repository
   * mirrors that fold.
   */
  validationReport?: Record<string, unknown>
}

/**
 * DTO accepted by {@link SpatialSceneRepository.update}. Every field is
 * optional; passing `undefined` leaves the column untouched. Immutable
 * columns (id, sourceScanId, sourceJobId, createdAt) are absent by design
 * — attempts to mutate them go through DDL, not the repository.
 */
export interface UpdateSpatialSceneInput {
  parametricStoragePath?: string
  parametricSizeBytes?: number | null
  parametricSha256?: string | null
  schemaVersion?: string
  validationState?: ValidationState
  isRenderable?: boolean
  requiresUserConfirmation?: boolean
  customerVerifyState?: CustomerVerifyState
  customerVerifyLastStage?: number | null
  customerVerifyLastActiveAt?: string | null
  customerId?: string | null
  providerId?: string | null
  /**
   * Re-point the scene's owning provider business. When `providerId` is also
   * changed the DB trigger re-derives this; supply it directly only to set an
   * org link independently of `providerId`.
   */
  providerOrgId?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Column-scoped verify-state patch — the subset of {@link UpdateSpatialSceneInput}
 * the Customer-Verify-Flow writes. Used by
 * {@link SpatialSceneRepository.updateCustomerVerifyState}; never carries blob
 * or geometry columns.
 */
export interface UpdateCustomerVerifyStateInput {
  customerVerifyState?: CustomerVerifyState
  customerVerifyLastStage?: number | null
  customerVerifyLastActiveAt?: string | null
}

/** Append-only audit-log row. Inserted via SECURITY DEFINER RPC in Supabase. */
export interface SpatialEditHistoryEntry {
  id: string
  sceneId: string
  /**
   * The provider business this audit row belongs to — stamped from the scene
   * by the `spatial_edit_history_append` RPC. DB column `provider_org_id`
   * (migration 20260520120046). Powers the org-scoped Hub Activity-Feed.
   */
  providerOrgId: string | null
  actorId: string | null
  variantId: string
  baseNodeId: string
  overrideFields: Record<string, unknown>
  command: 'set' | 'delete' | 'restore'
  parametricSha256Before: string | null
  parametricSha256After: string | null
  createdAt: string
}

export interface AppendEditHistoryInput {
  sceneId: string
  variantId: string
  baseNodeId: string
  overrideFields: Record<string, unknown>
  command: 'set' | 'delete' | 'restore'
  parametricSha256Before?: string | null
  parametricSha256After?: string | null
}

/**
 * Provider-proposed scope change anchored to a scene-node. Mutates only
 * while `status === 'proposed'`; terminal states (accepted/rejected/
 * withdrawn) lock the row.
 */
export interface SpatialChangeOrder {
  id: string
  sceneId: string
  nodeId: string | null
  proposerId: string
  status: ChangeOrderStatus
  title: string
  body: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface CreateChangeOrderInput {
  sceneId: string
  nodeId?: string | null
  proposerId: string
  title: string
  body?: string | null
  metadata?: Record<string, unknown>
}

/** Outcome of a pin review — DB table `spatial_pin_reviews.review_status`. */
export type PinReviewStatus = 'trusted' | 'flagged'

/**
 * A persisted pin-review row (`spatial_pin_reviews`, Phase C · C-1/C-6).
 * The existence of a row means the pin has been reviewed by the org; no row
 * means the pin is still pending.
 */
export interface PinReview {
  id: string
  sceneId: string
  providerOrgId: string
  /** Annotation pin node id — a text slug inside the RoomScene blob (no FK). */
  annotationNodeId: string
  reviewedByUserId: string
  reviewedByRole: 'owner' | 'worker'
  reviewStatus: PinReviewStatus
  createdAt: string
  updatedAt: string
}

/** Input for {@link SpatialSceneRepository.upsertPinReview}. */
export interface UpsertPinReviewInput {
  sceneId: string
  providerOrgId: string
  annotationNodeId: string
  /** The reviewing user — must equal `auth.uid()` for the Supabase RLS check. */
  reviewedByUserId: string
  reviewedByRole: 'owner' | 'worker'
  reviewStatus: PinReviewStatus
}

/** Lifecycle of a re-scan request (`spatial_rescan_requests.status`). */
export type RescanRequestStatus = 'pending' | 'accepted' | 'rejected'

/** A persisted re-scan request (`spatial_rescan_requests`, Phase C · C-1/C-7). */
export interface SpatialRescanRequest {
  id: string
  sceneId: string
  providerOrgId: string
  requestedByUserId: string
  requestedByRole: 'owner' | 'worker'
  reason: string
  status: RescanRequestStatus
  /** Customer's note on response — null until responded. */
  responseNote: string | null
  /** ISO timestamp the request left 'pending' — null while pending. */
  respondedAt: string | null
  /**
   * The scene produced when the customer accepted this request and re-
   * captured. `null` until the new scene exists; written atomically by the
   * `spatial_create_scene` RPC when invoked with `rescanRequestId`. DB column
   * `resulting_scene_id` (migration 20260522120054).
   */
  resultingSceneId: string | null
  createdAt: string
  updatedAt: string
}

/** Input for {@link SpatialSceneRepository.createRescanRequest}. */
export interface CreateRescanRequestInput {
  sceneId: string
  providerOrgId: string
  /** The requesting user — must equal `auth.uid()` for the Supabase RLS check. */
  requestedByUserId: string
  requestedByRole: 'owner' | 'worker'
  reason: string
}

/**
 * Repository contract. Both implementations must:
 *   - apply the relevant FSM (see `spatialSceneFsm.ts`) before any UPDATE.
 *   - reject create payloads that violate the dual-origin CHECK constraint.
 *   - never mutate immutable columns (id, sourceScanId, sourceJobId, createdAt).
 *   - return null (NOT throw) from `findById` when the row is missing.
 *   - throw `CanonicalError('NOT_FOUND')` from update/delete when the id is missing.
 *   - throw `CanonicalError('FORBIDDEN')` from create/delete when the call
 *     succeeds at the protocol layer but RLS hides the result (Supabase
 *     anon-client trying to insert into a `WITH CHECK (false)` policy, or
 *     delete a row default-denied to authenticated). InMemory raises the
 *     same code when its optional `enforceProposerIdMatchesActor` flag is
 *     set and the proposer doesn't match.
 *   - NOTE: update() does NOT distinguish RLS-blocked from missing in V1.
 *     A SELECT-then-UPDATE pair can race against an RLS policy; we throw
 *     NOT_FOUND in both cases. Callers needing finer dispatch should run a
 *     fresh findById on FORBIDDEN paths.
 */
export interface SpatialSceneRepository {
  // CRUD on header.
  create(input: CreateSpatialSceneInput): Promise<SpatialScene>
  findById(id: string): Promise<SpatialScene | null>
  /**
   * The scene produced from a given scan (`source_scan_id`), or `null` when
   * the scan has not been promoted yet. `source_scan_id` carries a UNIQUE
   * partial index, so this resolves at most one scene — it is the idempotency
   * pre-check for `promoteScanToScene` (one scan → one scene).
   */
  findBySourceScan(scanId: string): Promise<SpatialScene | null>
  /**
   * The scene attached to a job (`source_job_id`), or `null` when the job has
   * no scan. Replaces the Phase-B list-then-filter (`listByProviderOrg` +
   * client-side `.find()`). When a job carries multiple scenes — `source_job_id`
   * is not unique in the schema — the newest is returned.
   */
  findBySourceJob(jobId: string): Promise<SpatialScene | null>
  /**
   * Lane-2.5 · Stream B — find the manual scene attached to a presales-project
   * via `metadata.presales_project_id`. Manual scenes have `origin='manual'`
   * and NULL `source_scan_id` / `source_job_id`, so neither of the existing
   * lookups can resolve them. Newest-first; returns `null` when the project
   * has no manual scene yet.
   */
  findByPresalesProject(presalesProjectId: string): Promise<SpatialScene | null>
  listByCustomer(customerId: string): Promise<SpatialScene[]>
  listByProvider(providerId: string): Promise<SpatialScene[]>
  /**
   * All scenes owned by a provider business (`provider_org_id`) — the
   * multi-tenant Provider-Hub query. Every team member of the org sees the
   * same list; RLS visibility is granted org-wide via `spatial_can_view_scene`.
   */
  listByProviderOrg(providerOrgId: string): Promise<SpatialScene[]>
  update(id: string, input: UpdateSpatialSceneInput): Promise<SpatialScene>
  /**
   * Column-scoped customer-verify-state write (Block 3.12 · L4.b). Writes ONLY
   * the three `customer_verify_*` tracking columns — NEVER the parametric blob.
   *
   * The Supabase impl routes through the SECURITY DEFINER RPC
   * `spatial_set_customer_verify_state`, which authorizes the scene's customer
   * recipient even when `spatial_can_edit_scene` is `false` (a customer
   * verifying a craftsman-shared scene): the verify-state columns are
   * customer-owned tracking fields, independent of geometry-edit rights, so the
   * bare `spatial_scenes` UPDATE (gated by `spatial_can_edit_scene`) is the
   * wrong gate for them. The DB FSM trigger
   * (`spatial_scenes_customer_verify_fsm`) + dispute-lock guard stay
   * authoritative for transition legality. InMemory mirrors the FSM check and
   * writes the columns directly (no version bump — this is not a blob write).
   */
  updateCustomerVerifyState(
    id: string,
    input: UpdateCustomerVerifyStateInput,
  ): Promise<SpatialScene>
  delete(id: string): Promise<void>

  // Audit-log writes (SECURITY DEFINER on Supabase; direct insert on InMemory).
  appendEditHistory(input: AppendEditHistoryInput): Promise<SpatialEditHistoryEntry>
  listEditHistory(sceneId: string, limit?: number): Promise<SpatialEditHistoryEntry[]>

  // Change orders.
  createChangeOrder(input: CreateChangeOrderInput): Promise<SpatialChangeOrder>
  updateChangeOrderStatus(id: string, to: ChangeOrderStatus): Promise<SpatialChangeOrder>
  listChangeOrders(sceneId: string): Promise<SpatialChangeOrder[]>

  // Pin reviews (spatial_pin_reviews — Phase C · C-1/C-6).
  /** All pin reviews for a scene (org-scoped by RLS on Supabase). */
  listPinReviews(sceneId: string): Promise<PinReview[]>
  /**
   * Insert or update the review for one pin. Idempotent — the UNIQUE
   * (scene, node, org) constraint upserts a re-review of the same pin.
   */
  upsertPinReview(input: UpsertPinReviewInput): Promise<PinReview>
  /** Retract a review — removes the row so the pin returns to 'pending'. */
  deletePinReview(
    sceneId: string,
    annotationNodeId: string,
    providerOrgId: string,
  ): Promise<void>

  // Re-scan requests (spatial_rescan_requests — Phase C · C-1/C-7).
  /** All re-scan requests for a scene, newest first. */
  listRescanRequests(sceneId: string): Promise<SpatialRescanRequest[]>
  /** A single re-scan request by id — `null` when missing / RLS-hidden. */
  findRescanRequestById(id: string): Promise<SpatialRescanRequest | null>
  /** Create a re-scan request (provider side). */
  createRescanRequest(input: CreateRescanRequestInput): Promise<SpatialRescanRequest>
  /**
   * Customer responds to a request via the SECURITY DEFINER RPC
   * `spatial_rescan_request_respond`. Returns `true` when the transition was
   * applied, `false` on an idempotent no-op (already responded).
   */
  respondToRescanRequest(
    requestId: string,
    status: 'accepted' | 'rejected',
    note: string | null,
  ): Promise<boolean>
}
