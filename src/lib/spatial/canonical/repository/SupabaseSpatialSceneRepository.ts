/**
 * Spatial · Canonical · Repository · SupabaseSpatialSceneRepository
 *
 * Talks to the Day-6/Day-7 Postgres schema. The repository:
 *   - inserts header rows into `spatial_scenes`
 *   - reads with RLS-gated SELECTs (auth.uid()-scoped)
 *   - updates via locally-asserted FSM (defence-in-depth · the DB trigger
 *     is the ultimate gate · `45SPF` is rewrapped as `SpatialFsmViolation`)
 *   - calls the SECURITY DEFINER RPCs `spatial_edit_history_append` +
 *     `dispute_spatial_evidence_append` for append-only writes
 *
 * The blob lives in Supabase Storage (Decision #2) — only the
 * `parametric_storage_path` pointer is stored in this table. Callers
 * combine this repository with `storage/parametric-storage.ts`.
 */

import { supabase } from '../../../supabase'
import { CanonicalError, SPATIAL_FSM_SQLSTATE, SpatialFsmViolation } from '../types/errors.ts'
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
  type CustomerVerifyState,
  type ValidationState,
} from './spatialSceneFsm.ts'

// ── row shapes (snake_case in DB) ──────────────────────────────────────────

interface SpatialSceneRow {
  id: string
  source_scan_id: string | null
  source_job_id: string | null
  parent_scene_id: string | null
  parametric_storage_path: string
  parametric_size_bytes: number | null
  parametric_sha256: string | null
  /** H1 audit-fix · optimistic-concurrency token. NOT NULL DEFAULT 0
   *  (migration 20260601100000). Bumped by every update() via compare-and-set. */
  parametric_version: number
  schema_version: string
  validation_state: ValidationState
  is_renderable: boolean
  requires_user_confirmation: boolean
  customer_verify_state: CustomerVerifyState
  customer_verify_last_stage: number | null
  customer_verify_last_active_at: string | null
  customer_id: string | null
  provider_id: string | null
  provider_org_id: string | null
  metadata: Record<string, unknown>
  /** Lane-2.5 · Stream B — DB default 'roomplan'. Old rows pre-migration are
   *  back-filled to 'roomplan' by the column default; new manual rows write
   *  'manual' explicitly via spatial_create_manual_scene. */
  origin: 'roomplan' | 'manual' | 'example_room'
  created_at: string
  updated_at: string
}

interface SpatialEditHistoryRow {
  id: string
  scene_id: string
  provider_org_id: string | null
  actor_id: string | null
  variant_id: string
  base_node_id: string
  override_fields: Record<string, unknown>
  command: 'set' | 'delete' | 'restore'
  parametric_sha256_before: string | null
  parametric_sha256_after: string | null
  created_at: string
}

interface SpatialChangeOrderRow {
  id: string
  scene_id: string
  node_id: string | null
  proposer_id: string
  status: ChangeOrderStatus
  title: string
  body: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface SpatialPinReviewRow {
  id: string
  scene_id: string
  provider_org_id: string
  annotation_node_id: string
  reviewed_by_user_id: string
  reviewed_by_role: 'owner' | 'worker'
  review_status: 'trusted' | 'flagged'
  created_at: string
  updated_at: string
}

interface SpatialRescanRequestRow {
  id: string
  scene_id: string
  provider_org_id: string
  requested_by_user_id: string
  requested_by_role: 'owner' | 'worker'
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
  response_note: string | null
  responded_at: string | null
  resulting_scene_id: string | null
  created_at: string
  updated_at: string
}

// ── row ↔ domain mappers ───────────────────────────────────────────────────

function rowToScene(row: SpatialSceneRow): SpatialScene {
  return {
    id: row.id,
    sourceScanId: row.source_scan_id,
    sourceJobId: row.source_job_id,
    parametricStoragePath: row.parametric_storage_path,
    parametricSizeBytes: row.parametric_size_bytes,
    parametricSha256: row.parametric_sha256,
    // Defensive `?? 0` — a row read before the 20260601100000 migration (or via
    // a path that bypassed the DEFAULT) reports version 0.
    parametricVersion: row.parametric_version ?? 0,
    schemaVersion: row.schema_version,
    validationState: row.validation_state,
    isRenderable: row.is_renderable,
    requiresUserConfirmation: row.requires_user_confirmation,
    customerVerifyState: row.customer_verify_state,
    customerVerifyLastStage: row.customer_verify_last_stage,
    customerVerifyLastActiveAt: row.customer_verify_last_active_at,
    customerId: row.customer_id,
    providerId: row.provider_id,
    providerOrgId: row.provider_org_id,
    parentSceneId: row.parent_scene_id,
    metadata: row.metadata,
    // Defensive default — a row written before the 20260525000000 migration
    // (or by a back-fill path that bypassed the default) reports 'roomplan'.
    origin: row.origin ?? 'roomplan',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToHistory(row: SpatialEditHistoryRow): SpatialEditHistoryEntry {
  return {
    id: row.id,
    sceneId: row.scene_id,
    providerOrgId: row.provider_org_id,
    actorId: row.actor_id,
    variantId: row.variant_id,
    baseNodeId: row.base_node_id,
    overrideFields: row.override_fields,
    command: row.command,
    parametricSha256Before: row.parametric_sha256_before,
    parametricSha256After: row.parametric_sha256_after,
    createdAt: row.created_at,
  }
}

function rowToChangeOrder(row: SpatialChangeOrderRow): SpatialChangeOrder {
  return {
    id: row.id,
    sceneId: row.scene_id,
    nodeId: row.node_id,
    proposerId: row.proposer_id,
    status: row.status,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToPinReview(row: SpatialPinReviewRow): PinReview {
  return {
    id: row.id,
    sceneId: row.scene_id,
    providerOrgId: row.provider_org_id,
    annotationNodeId: row.annotation_node_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedByRole: row.reviewed_by_role,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRescanRequest(row: SpatialRescanRequestRow): SpatialRescanRequest {
  return {
    id: row.id,
    sceneId: row.scene_id,
    providerOrgId: row.provider_org_id,
    requestedByUserId: row.requested_by_user_id,
    requestedByRole: row.requested_by_role,
    reason: row.reason,
    status: row.status,
    responseNote: row.response_note,
    respondedAt: row.responded_at,
    resultingSceneId: row.resulting_scene_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Postgres RLS-denial SQLSTATE (insufficient_privilege). PostgREST surfaces
 * this when a row-level policy denies an INSERT/UPDATE/DELETE; we translate
 * it to {@link CanonicalError}('FORBIDDEN') so callers can branch cleanly
 * instead of inspecting raw PG error codes.
 */
const PG_INSUFFICIENT_PRIVILEGE = '42501'

/**
 * Parse the trigger name out of a Postgres error message. Day-7 triggers
 * raise with `SPATIAL_FSM_VIOLATION: <fsmName> ...` (e.g. `validation_state`,
 * `customer_verify_state`, `spatial_change_orders.status`) — we extract that
 * token so `rewrapFsmError` reports the actual firing trigger rather than the
 * caller's guess.
 *
 * Returns null when the message does not match the expected shape (e.g.
 * immutable-cols guard) so the caller can decide whether to fall through.
 */
function fsmNameFromPgMessage(message: string | undefined): string | null {
  if (!message) return null
  // immutable-cols guard messages: 'SPATIAL_FSM_VIOLATION: spatial_scenes.<col> is immutable'
  const immutableMatch = message.match(/spatial_scenes\.(\w+)\s+is\s+immutable/)
  if (immutableMatch) return `immutable:${immutableMatch[1]}`
  // FSM messages: 'SPATIAL_FSM_VIOLATION: illegal <fsm> transition' OR
  //               'SPATIAL_FSM_VIOLATION: illegal spatial_change_orders.<fsm> transition'
  const fsmMatch = message.match(/illegal\s+([\w.]+)\s+transition/)
  if (fsmMatch) return fsmMatch[1]
  return null
}

/**
 * Translate a Postgres FSM-violation (SQLSTATE 45SPF) into the local
 * {@link SpatialFsmViolation}. The trigger name is parsed from the PG
 * message when available, so an immutable-cols violation surfaces as such
 * rather than being mis-attributed to whichever FSM the caller guessed.
 * Other errors are rethrown verbatim so upstream catch-handlers can
 * dispatch on `PostgrestError.code`.
 */
function rewrapFsmError(err: unknown, fsmName: string, from: string, to: string): never {
  const code = (err as { code?: string } | null)?.code
  if (code === SPATIAL_FSM_SQLSTATE) {
    const message = (err as { message?: string }).message
    const parsed = fsmNameFromPgMessage(message)
    if (parsed && parsed.startsWith('immutable:')) {
      // immutable-cols fired — `from`/`to` for the FSM the caller guessed is
      // meaningless; surface the actual column being protected.
      const col = parsed.slice('immutable:'.length)
      throw new SpatialFsmViolation(parsed, col, col, message)
    }
    throw new SpatialFsmViolation(parsed ?? fsmName, from, to, message)
  }
  throw err as Error
}

export class SupabaseSpatialSceneRepository implements SpatialSceneRepository {
  /**
   * Create a new `spatial_scenes` row via the `spatial_create_scene` RPC.
   *
   * **Why an RPC**: `spatial_scenes_insert` is `WITH CHECK (false)` for
   * `authenticated` — a direct browser `.insert()` is always RLS-blocked.
   * The SECURITY DEFINER RPC (migrations 20260522120053 + 20260522120054,
   * AD-2) is the canonical insert path: it ownership-checks the caller
   * against the scan/job, derives `customer_id` / `provider_id` /
   * `provider_org_id` from that context server-side, and is idempotent per
   * `source_scan_id` (a second promotion of the same scan returns the
   * existing scene).
   *
   * The scene id is client-generated (`input.id`) so the Storage blob path
   * can embed it before the row exists; a fresh uuid is used when omitted.
   * `validationReport` has no column — the RPC folds it into
   * `metadata.validation_report`.
   *
   * Re-scan version linkage (D2 · B7): pass `parentSceneId` to record the
   * predecessor scene (immutable post-insert) and `rescanRequestId` to fulfil
   * an accepted `spatial_rescan_requests` row — the RPC writes the new scene
   * id onto `resulting_scene_id` atomically and short-circuits idempotently
   * when the request is already fulfilled.
   *
   * The RPC raises typed SQLSTATEs: `42501` (caller not authorized for the
   * scan/job, or not the parent scene's customer when fulfilling a rescan
   * request) → {@link CanonicalError}('FORBIDDEN'); `28000` (unauthenticated)
   * → 'FORBIDDEN'; `22023` (missing origin / bad input / rescan_request not
   * found / status not 'accepted' / parent mismatch) → 'INVALID_INPUT'.
   */
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
    const { data, error } = await supabase.rpc('spatial_create_scene', {
      p_id: input.id ?? crypto.randomUUID(),
      p_parametric_storage_path: input.parametricStoragePath,
      p_parametric_sha256: input.parametricSha256 ?? null,
      p_parametric_size_bytes: input.parametricSizeBytes ?? null,
      p_source_scan_id: input.sourceScanId ?? null,
      p_source_job_id: input.sourceJobId ?? null,
      p_schema_version: input.schemaVersion ?? '1.0',
      p_validation_state: input.validationState ?? 'pending',
      p_validation_report: input.validationReport ?? {},
      p_is_renderable: input.isRenderable ?? false,
      p_requires_user_confirmation: input.requiresUserConfirmation ?? false,
      p_metadata: input.metadata ?? {},
      p_parent_scene_id: input.parentSceneId ?? null,
      p_rescan_request_id: input.rescanRequestId ?? null,
    })
    if (error) {
      const code = (error as { code?: string }).code
      if (code === PG_INSUFFICIENT_PRIVILEGE || code === '28000') {
        throw new CanonicalError(
          'FORBIDDEN',
          `spatial_create_scene rejected: ${error.message}`,
        )
      }
      if (code === '22023') {
        throw new CanonicalError(
          'INVALID_INPUT',
          `spatial_create_scene rejected: ${error.message}`,
        )
      }
      throw error
    }
    // The RPC `RETURNS spatial_scenes` (a single composite) → PostgREST yields
    // one row object, not an array.
    const row = (Array.isArray(data) ? data[0] : data) as SpatialSceneRow | null
    if (!row?.id) {
      throw new CanonicalError(
        'STORAGE_ERROR',
        'spatial_create_scene returned no scene row',
      )
    }
    return rowToScene(row)
  }

  async findById(id: string): Promise<SpatialScene | null> {
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('id', id)
      .maybeSingle<SpatialSceneRow>()
    if (error) throw error
    return data ? rowToScene(data) : null
  }

  async findBySourceScan(scanId: string): Promise<SpatialScene | null> {
    // `source_scan_id` carries a UNIQUE partial index (migration 20260522120053)
    // — `maybeSingle()` resolves the at-most-one match without raising PGRST116.
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('source_scan_id', scanId)
      .maybeSingle<SpatialSceneRow>()
    if (error) throw error
    return data ? rowToScene(data) : null
  }

  async findBySourceJob(jobId: string): Promise<SpatialScene | null> {
    // `source_job_id` is a plain (non-unique) partial index — a job could
    // carry multiple scenes. `limit(1)` after the newest-first order keeps
    // `maybeSingle()` from raising PGRST116 on a multi-row match.
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('source_job_id', jobId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<SpatialSceneRow>()
    if (error) throw error
    return data ? rowToScene(data) : null
  }

  async findByPresalesProject(presalesProjectId: string): Promise<SpatialScene | null> {
    // Lane-2.5 · Stream B — manual scenes anchor to a presales-project via
    // `metadata.presales_project_id`. They carry `origin='manual'` and NULL
    // source_scan_id / source_job_id, so the regular lookups miss them.
    // Filtering on origin avoids touching legacy 'roomplan' rows that may
    // carry a stale metadata key.
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('origin', 'manual')
      .contains('metadata', { presales_project_id: presalesProjectId })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<SpatialSceneRow>()
    if (error) throw error
    return data ? rowToScene(data) : null
  }

  async listByCustomer(customerId: string): Promise<SpatialScene[]> {
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .returns<SpatialSceneRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScene)
  }

  async listByProvider(providerId: string): Promise<SpatialScene[]> {
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false })
      .returns<SpatialSceneRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScene)
  }

  async listByProviderOrg(providerOrgId: string): Promise<SpatialScene[]> {
    const { data, error } = await supabase
      .from('spatial_scenes')
      .select()
      .eq('provider_org_id', providerOrgId)
      .order('created_at', { ascending: false })
      .returns<SpatialSceneRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScene)
  }

  async update(id: string, input: UpdateSpatialSceneInput): Promise<SpatialScene> {
    const existing = await this.findById(id)
    if (!existing) throw new CanonicalError('NOT_FOUND', `SpatialScene ${id} not found`)

    // Local FSM check — fail fast before the round-trip; the DB trigger is
    // the authoritative gate (rewrapped below if it fires anyway).
    if (input.validationState !== undefined) {
      assertValidationStateTransition(existing.validationState, input.validationState)
    }
    if (input.customerVerifyState !== undefined) {
      assertCustomerVerifyStateTransition(
        existing.customerVerifyState,
        input.customerVerifyState,
      )
    }

    const payload: Partial<SpatialSceneRow> = {}
    if (input.parametricStoragePath !== undefined) payload.parametric_storage_path = input.parametricStoragePath
    if (input.parametricSizeBytes !== undefined) payload.parametric_size_bytes = input.parametricSizeBytes
    if (input.parametricSha256 !== undefined) payload.parametric_sha256 = input.parametricSha256
    if (input.schemaVersion !== undefined) payload.schema_version = input.schemaVersion
    if (input.validationState !== undefined) payload.validation_state = input.validationState
    if (input.isRenderable !== undefined) payload.is_renderable = input.isRenderable
    if (input.requiresUserConfirmation !== undefined) payload.requires_user_confirmation = input.requiresUserConfirmation
    if (input.customerVerifyState !== undefined) payload.customer_verify_state = input.customerVerifyState
    if (input.customerVerifyLastStage !== undefined) payload.customer_verify_last_stage = input.customerVerifyLastStage
    if (input.customerVerifyLastActiveAt !== undefined) payload.customer_verify_last_active_at = input.customerVerifyLastActiveAt
    if (input.customerId !== undefined) payload.customer_id = input.customerId
    if (input.providerId !== undefined) payload.provider_id = input.providerId
    if (input.providerOrgId !== undefined) payload.provider_org_id = input.providerOrgId
    if (input.metadata !== undefined) payload.metadata = input.metadata

    // H1 audit-fix · optimistic concurrency. `existing` was fetched fresh by the
    // findById above, so its version is current as of this call. Bump it and
    // compare-and-set: a concurrent writer that incremented `parametric_version`
    // between our read and this write matches zero rows → CONFLICT, instead of
    // last-write-wins silently clobbering the parametric blob pointer.
    const expectedVersion = existing.parametricVersion
    payload.parametric_version = expectedVersion + 1

    const { data, error } = await supabase
      .from('spatial_scenes')
      .update(payload)
      .eq('id', id)
      .eq('parametric_version', expectedVersion)
      .select()
      .returns<SpatialSceneRow[]>()
    if (error) {
      const fsmName = input.validationState !== undefined ? 'validation_state' : 'customer_verify_state'
      const from =
        input.validationState !== undefined
          ? existing.validationState
          : existing.customerVerifyState
      const to =
        input.validationState !== undefined
          ? (input.validationState as string)
          : (input.customerVerifyState as string) ?? ''
      rewrapFsmError(error, fsmName, from, to)
    }
    if (!data || data.length === 0) {
      // Zero rows with no error = CAS miss: the row was either deleted or a
      // concurrent writer incremented parametric_version first. The row still
      // existed at findById, so a missing row here is also a concurrent change.
      throw new CanonicalError(
        'CONFLICT',
        `SpatialScene ${id} was modified concurrently (expected parametric_version ${expectedVersion}).`,
      )
    }
    return rowToScene(data[0])
  }

  /**
   * Column-scoped verify-state write via the SECURITY DEFINER RPC
   * `spatial_set_customer_verify_state` (Block 3.12 · L4.b).
   *
   * **Why an RPC, not a bare UPDATE**: the `spatial_scenes_update` policy gates
   * its WITH CHECK on `spatial_can_edit_scene`, which is `false` for a customer
   * on a craftsman-shared (HW-owned) scene — so the bare UPDATE this method's
   * sibling {@link update} performs is RLS-blocked there, silently aborting the
   * Stage-5 verify confirm. The RPC is SECURITY DEFINER (bypasses the can-edit
   * WITH CHECK) but re-imposes a *customer-recipient* gate and writes ONLY the
   * `customer_verify_*` columns, never the blob — so the can-edit protection of
   * the parametric pointer (migration 20260529194918) is preserved.
   *
   * The DB FSM trigger (`spatial_scenes_customer_verify_fsm`) stays the
   * authoritative transition gate; an illegal transition raises `45SPF` which
   * is rewrapped here as {@link SpatialFsmViolation}, identical to {@link update}.
   * The server stamps `customer_verify_last_active_at = now()`; `p_state`/
   * `p_stage` are `NULL`-safe (a stage-only touch leaves the FSM column intact).
   */
  async updateCustomerVerifyState(
    id: string,
    input: UpdateCustomerVerifyStateInput,
  ): Promise<SpatialScene> {
    const { data, error } = await supabase.rpc('spatial_set_customer_verify_state', {
      p_scene_id: id,
      p_state: input.customerVerifyState ?? null,
      p_stage: input.customerVerifyLastStage ?? null,
    })
    if (error) {
      // The RPC's FSM/dispute triggers raise 45SPF on an illegal transition —
      // rewrap to SpatialFsmViolation so callers see the same shape as update().
      // A 42501 (recipient gate) or other error rethrows verbatim; the
      // best-effort persist layer swallows it into {applied:false}.
      rewrapFsmError(error, 'customer_verify_state', '', input.customerVerifyState ?? '')
    }
    // RPC `RETURNS spatial_scenes` (single composite) → one row object.
    const row = (Array.isArray(data) ? data[0] : data) as SpatialSceneRow | null
    if (!row?.id) {
      throw new CanonicalError(
        'NOT_FOUND',
        `SpatialScene ${id} not found or verify-state write hidden by RLS.`,
      )
    }
    return rowToScene(row)
  }

  /**
   * Delete a `spatial_scenes` row.
   *
   * **RLS contract**: `spatial_scenes` has no DELETE policy for
   * `authenticated` (default-deny). PostgREST returns a successful response
   * with zero rows when RLS hides the target. To stay symmetric with
   * {@link InMemorySpatialSceneRepository} (which throws NOT_FOUND on a
   * missing id), we chain `.select()` and assert at least one returned row;
   * an empty result is rewrapped as `NOT_FOUND`. A 42501 from RLS denial on
   * a row that *would* otherwise match becomes `FORBIDDEN`.
   */
  async delete(id: string): Promise<void> {
    const { data, error } = await supabase
      .from('spatial_scenes')
      .delete()
      .eq('id', id)
      .select('id')
      .returns<Array<{ id: string }>>()
    if (error) {
      const code = (error as { code?: string }).code
      if (code === PG_INSUFFICIENT_PRIVILEGE) {
        throw new CanonicalError(
          'FORBIDDEN',
          `spatial_scenes delete blocked by RLS (scene=${id}) — service_role client required.`,
        )
      }
      throw error
    }
    if (!data || data.length === 0) {
      throw new CanonicalError(
        'NOT_FOUND',
        `SpatialScene ${id} not deleted: row missing or RLS hid the target.`,
      )
    }
  }

  async appendEditHistory(input: AppendEditHistoryInput): Promise<SpatialEditHistoryEntry> {
    const { data, error } = await supabase.rpc('spatial_edit_history_append', {
      p_scene_id: input.sceneId,
      p_variant_id: input.variantId,
      p_base_node_id: input.baseNodeId,
      p_override_fields: input.overrideFields,
      p_command: input.command,
      p_sha_before: input.parametricSha256Before ?? null,
      p_sha_after: input.parametricSha256After ?? null,
    })
    if (error) throw error
    // The RPC returns the inserted row's id; re-fetch the row for a
    // shaped result.
    const { data: row, error: fetchErr } = await supabase
      .from('spatial_edit_history')
      .select()
      .eq('id', data as string)
      .single<SpatialEditHistoryRow>()
    if (fetchErr) throw fetchErr
    return rowToHistory(row!)
  }

  async listEditHistory(
    sceneId: string,
    limit: number = 100,
  ): Promise<SpatialEditHistoryEntry[]> {
    const { data, error } = await supabase
      .from('spatial_edit_history')
      .select()
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<SpatialEditHistoryRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToHistory)
  }

  async createChangeOrder(input: CreateChangeOrderInput): Promise<SpatialChangeOrder> {
    const { data, error } = await supabase
      .from('spatial_change_orders')
      .insert({
        scene_id: input.sceneId,
        node_id: input.nodeId ?? null,
        proposer_id: input.proposerId,
        status: 'proposed',
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? {},
      })
      .select()
      .single<SpatialChangeOrderRow>()
    if (error) throw error
    return rowToChangeOrder(data!)
  }

  async updateChangeOrderStatus(
    id: string,
    to: ChangeOrderStatus,
  ): Promise<SpatialChangeOrder> {
    // Local FSM check.
    const { data: existing, error: fetchErr } = await supabase
      .from('spatial_change_orders')
      .select()
      .eq('id', id)
      .maybeSingle<SpatialChangeOrderRow>()
    if (fetchErr) throw fetchErr
    if (!existing) throw new CanonicalError('NOT_FOUND', `ChangeOrder ${id} not found`)
    assertChangeOrderStatusTransition(existing.status, to)

    const { data, error } = await supabase
      .from('spatial_change_orders')
      .update({ status: to })
      .eq('id', id)
      .select()
      .single<SpatialChangeOrderRow>()
    if (error) {
      rewrapFsmError(error, 'change_order_status', existing.status, to)
    }
    return rowToChangeOrder(data!)
  }

  async listChangeOrders(sceneId: string): Promise<SpatialChangeOrder[]> {
    const { data, error } = await supabase
      .from('spatial_change_orders')
      .select()
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false })
      .returns<SpatialChangeOrderRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToChangeOrder)
  }

  // ── Pin reviews (spatial_pin_reviews · C-1/C-6) ────────────────────────────

  async listPinReviews(sceneId: string): Promise<PinReview[]> {
    const { data, error } = await supabase
      .from('spatial_pin_reviews')
      .select()
      .eq('scene_id', sceneId)
      .returns<SpatialPinReviewRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToPinReview)
  }

  async upsertPinReview(input: UpsertPinReviewInput): Promise<PinReview> {
    // The UNIQUE (scene, node, org) constraint makes this an idempotent
    // upsert — re-reviewing the same pin updates the existing row. RLS
    // enforces reviewed_by_user_id = auth.uid() + org membership.
    const { data, error } = await supabase
      .from('spatial_pin_reviews')
      .upsert(
        {
          scene_id: input.sceneId,
          provider_org_id: input.providerOrgId,
          annotation_node_id: input.annotationNodeId,
          reviewed_by_user_id: input.reviewedByUserId,
          reviewed_by_role: input.reviewedByRole,
          review_status: input.reviewStatus,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'scene_id,annotation_node_id,provider_org_id' },
      )
      .select()
      .single<SpatialPinReviewRow>()
    if (error) throw error
    return rowToPinReview(data!)
  }

  async deletePinReview(
    sceneId: string,
    annotationNodeId: string,
    providerOrgId: string,
  ): Promise<void> {
    const { error } = await supabase
      .from('spatial_pin_reviews')
      .delete()
      .eq('scene_id', sceneId)
      .eq('annotation_node_id', annotationNodeId)
      .eq('provider_org_id', providerOrgId)
    if (error) throw error
  }

  // ── Re-scan requests (spatial_rescan_requests · C-1/C-7) ───────────────────

  async listRescanRequests(sceneId: string): Promise<SpatialRescanRequest[]> {
    const { data, error } = await supabase
      .from('spatial_rescan_requests')
      .select()
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false })
      .returns<SpatialRescanRequestRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToRescanRequest)
  }

  async findRescanRequestById(id: string): Promise<SpatialRescanRequest | null> {
    const { data, error } = await supabase
      .from('spatial_rescan_requests')
      .select()
      .eq('id', id)
      .maybeSingle<SpatialRescanRequestRow>()
    if (error) throw error
    return data ? rowToRescanRequest(data) : null
  }

  async createRescanRequest(
    input: CreateRescanRequestInput,
  ): Promise<SpatialRescanRequest> {
    const { data, error } = await supabase
      .from('spatial_rescan_requests')
      .insert({
        scene_id: input.sceneId,
        provider_org_id: input.providerOrgId,
        requested_by_user_id: input.requestedByUserId,
        requested_by_role: input.requestedByRole,
        reason: input.reason,
      })
      .select()
      .single<SpatialRescanRequestRow>()
    if (error) throw error
    return rowToRescanRequest(data!)
  }

  async respondToRescanRequest(
    requestId: string,
    status: 'accepted' | 'rejected',
    note: string | null,
  ): Promise<boolean> {
    // The SECURITY DEFINER RPC is the sole status-transition write path —
    // it validates auth.uid() = the scene customer + idempotency server-side.
    const { data, error } = await supabase.rpc('spatial_rescan_request_respond', {
      p_request_id: requestId,
      p_status: status,
      p_note: note,
    })
    if (error) throw error
    return data === true
  }
}
