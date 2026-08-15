/**
 * Spatial Core · Supabase Repository
 *
 * Maps Postgres snake_case rows ↔ TS camelCase domain types. JSONB columns
 * (anchor_uv, anchor_world_cache, anchor_ar_hint, anchor_2d, transform,
 * floor_anchor, device_meta, payload, warnings) are stored as-is using
 * camelCase keys — no key-translation inside JSONB.
 *
 * Timestamps: DB uses timestamptz; we store as unix-ms numbers in TS
 * (matches SaFix convention from corrections/calendar/team_hub domains).
 *
 * Errors: thrown as-is from supabase-js (PostgrestError); upstream callers
 * map them to user-facing strings.
 */

import { supabase } from '../../supabase'
import type { SpatialRepository } from './SpatialRepository'
import type { MeshSummary } from '../quality/rules'
import type {
  Scan,
  ScanAsset,
  ScanRoom,
  ScanSurface,
  ScanMeasurement,
  ScanAnnotation,
  ScanQualityReport,
  ScanEvent,
  ScanEventAction,
  ScanDetailView,
  ScanReviewView,
  CreateScanInput,
  UpdateScanInput,
  UpdateScanQualityInput,
  UploadMeshSnapshotInput,
  CreateScanAssetInput,
  CreateScanRoomInput,
  UpdateScanRoomInput,
  CreateScanSurfaceInput,
  UpdateScanSurfaceInput,
  CreateScanMeasurementInput,
  VerifyScanMeasurementInput,
  CreateScanAnnotationInput,
  UpdateScanAnnotationInput,
  CreateScanQualityReportInput,
  ScanQualityWarning,
  ScanDeviceMeta,
  AnchorUv,
  AnchorWorldCache,
  AnchorArHint,
  Anchor2d,
  FloorAnchor,
  ScanTransform,
} from '../types'
import { defaultCustomerVisibleForKind } from '../types'

// ── Time helpers ─────────────────────────────────────────────────────────────

function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const n = new Date(ts).getTime()
  return Number.isFinite(n) ? n : null
}

function tsToMsRequired(ts: string): number {
  return new Date(ts).getTime()
}

function msToIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  return new Date(ms).toISOString()
}

// ── Row shapes (snake_case) ──────────────────────────────────────────────────

interface ScanRow {
  id: string
  job_id: string | null
  project_id: string | null
  presales_project_id: string | null
  parent_scan_id: string | null
  status: Scan['status']
  source: Scan['source']
  captured_by: string
  device_meta: ScanDeviceMeta | null
  scan_started_at: string | null
  scan_ended_at: string | null
  archived_at: string | null
  /** Lane 3 V1.6 columns. */
  owner_type: Scan['ownerType']
  shared_with_customer: boolean
  shared_at: string | null
  /** V1.5.1 Phase B columns. */
  shared_with_provider_id: string | null
  shared_with_provider_at: string | null
  /** Lane 3 V1.6 Phase 2 · F1 columns (Customer-LiDAR quality persist). */
  quality_score: number | null
  quality_label: 'high' | 'medium' | 'low' | null
  created_at: string
  updated_at: string
}

interface ScanAssetRow {
  id: string
  scan_id: string
  kind: ScanAsset['kind']
  storage_path: string
  bytes: number | null
  sha256: string | null
  converted_from: string | null
  created_at: string
}

interface ScanRoomRow {
  id: string
  scan_id: string
  name: string | null
  area_m2_estimated: number | null
  area_m2_verified: number | null
  ceiling_h_estimated: number | null
  ceiling_h_verified: number | null
  floor_anchor: FloorAnchor | null
  created_at: string
  updated_at: string
}

interface ScanSurfaceRow {
  id: string
  room_id: string
  surface_external_id: string
  kind: ScanSurface['kind']
  dim_w_estimated: number | null
  dim_h_estimated: number | null
  dim_w_verified: number | null
  dim_h_verified: number | null
  transform: ScanTransform | null
  status: ScanSurface['status']
  confidence: number | null
  created_at: string
  updated_at: string
}

interface ScanMeasurementRow {
  id: string
  scan_id: string
  surface_id: string | null
  label: string | null
  value_estimated_m: number | null
  value_verified_m: number | null
  unit: 'm'
  status: ScanMeasurement['status']
  source: ScanMeasurement['source']
  verified_by: string | null
  verified_at: string | null
  created_at: string
  updated_at: string
}

interface ScanAnnotationRow {
  id: string
  scan_id: string
  kind: ScanAnnotation['kind']
  anchor_uv: AnchorUv | null
  anchor_world_cache: AnchorWorldCache | null
  anchor_ar_hint: AnchorArHint | null
  anchor_2d: Anchor2d | null
  last_drift_check_at: string | null
  last_drift_distance_m: number | null
  confidence: ScanAnnotation['confidence']
  photo_asset_id: string | null
  note: string | null
  status: ScanAnnotation['status']
  gewerk: string | null
  offer_relevant: boolean
  offer_line_item_id: string | null
  customer_visible: boolean
  /** V1.6 Phase 1d: door/window/heating/electrical or null (HW-only pin).
   *  CHECK constraint enforced server-side via migration 20260526120000. */
  customer_pin_type: ScanAnnotation['customerPinType']
  created_at: string
  updated_at: string
}

interface ScanQualityReportRow {
  id: string
  scan_id: string
  score: number
  bucket: ScanQualityReport['bucket']
  warnings: ScanQualityWarning[]
  engine_version: string
  generated_at: string
}

interface ScanEventRow {
  id: string
  scan_id: string
  actor_id: string | null
  action: ScanEvent['action']
  payload: Record<string, unknown>
  at: string
}

// ── Row → Domain mappers ─────────────────────────────────────────────────────

function rowToScan(row: ScanRow): Scan {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    presalesProjectId: row.presales_project_id,
    parentScanId: row.parent_scan_id,
    status: row.status,
    source: row.source,
    capturedBy: row.captured_by,
    deviceMeta: row.device_meta ?? {},
    scanStartedAt: tsToMs(row.scan_started_at),
    scanEndedAt: tsToMs(row.scan_ended_at),
    archivedAt: tsToMs(row.archived_at),
    ownerType: row.owner_type,
    sharedWithCustomer: row.shared_with_customer,
    sharedAt: tsToMs(row.shared_at),
    sharedWithProviderId: row.shared_with_provider_id ?? null,
    sharedWithProviderAt: tsToMs(row.shared_with_provider_at ?? null),
    qualityScore: row.quality_score ?? null,
    qualityLabel: row.quality_label ?? null,
    createdAt: tsToMsRequired(row.created_at),
    updatedAt: tsToMsRequired(row.updated_at),
  }
}

function rowToScanAsset(row: ScanAssetRow): ScanAsset {
  return {
    id: row.id,
    scanId: row.scan_id,
    kind: row.kind,
    storagePath: row.storage_path,
    bytes: row.bytes,
    sha256: row.sha256,
    convertedFrom: row.converted_from,
    createdAt: tsToMsRequired(row.created_at),
  }
}

function rowToScanRoom(row: ScanRoomRow): ScanRoom {
  return {
    id: row.id,
    scanId: row.scan_id,
    name: row.name,
    areaM2Estimated: row.area_m2_estimated,
    areaM2Verified: row.area_m2_verified,
    ceilingHEstimated: row.ceiling_h_estimated,
    ceilingHVerified: row.ceiling_h_verified,
    floorAnchor: row.floor_anchor,
    createdAt: tsToMsRequired(row.created_at),
    updatedAt: tsToMsRequired(row.updated_at),
  }
}

function rowToScanSurface(row: ScanSurfaceRow): ScanSurface {
  return {
    id: row.id,
    roomId: row.room_id,
    surfaceExternalId: row.surface_external_id,
    kind: row.kind,
    dimWEstimated: row.dim_w_estimated,
    dimHEstimated: row.dim_h_estimated,
    dimWVerified: row.dim_w_verified,
    dimHVerified: row.dim_h_verified,
    transform: row.transform,
    status: row.status,
    confidence: row.confidence,
    createdAt: tsToMsRequired(row.created_at),
    updatedAt: tsToMsRequired(row.updated_at),
  }
}

function rowToScanMeasurement(row: ScanMeasurementRow): ScanMeasurement {
  return {
    id: row.id,
    scanId: row.scan_id,
    surfaceId: row.surface_id,
    label: row.label,
    valueEstimatedM: row.value_estimated_m,
    valueVerifiedM: row.value_verified_m,
    unit: row.unit,
    status: row.status,
    source: row.source,
    verifiedBy: row.verified_by,
    verifiedAt: tsToMs(row.verified_at),
    createdAt: tsToMsRequired(row.created_at),
    updatedAt: tsToMsRequired(row.updated_at),
  }
}

function rowToScanAnnotation(row: ScanAnnotationRow): ScanAnnotation {
  return {
    id: row.id,
    scanId: row.scan_id,
    kind: row.kind,
    anchorUv: row.anchor_uv,
    anchorWorldCache: row.anchor_world_cache,
    anchorArHint: row.anchor_ar_hint,
    anchor2d: row.anchor_2d,
    lastDriftCheckAt: tsToMs(row.last_drift_check_at),
    lastDriftDistanceM: row.last_drift_distance_m,
    confidence: row.confidence,
    photoAssetId: row.photo_asset_id,
    note: row.note,
    status: row.status,
    gewerk: row.gewerk,
    offerRelevant: row.offer_relevant,
    offerLineItemId: row.offer_line_item_id,
    customerVisible: row.customer_visible,
    customerPinType: row.customer_pin_type ?? null,
    createdAt: tsToMsRequired(row.created_at),
    updatedAt: tsToMsRequired(row.updated_at),
  }
}

function rowToScanQualityReport(row: ScanQualityReportRow): ScanQualityReport {
  return {
    id: row.id,
    scanId: row.scan_id,
    score: row.score,
    bucket: row.bucket,
    warnings: row.warnings ?? [],
    engineVersion: row.engine_version,
    generatedAt: tsToMsRequired(row.generated_at),
  }
}

function rowToScanEvent(row: ScanEventRow): ScanEvent {
  return {
    id: row.id,
    scanId: row.scan_id,
    actorId: row.actor_id,
    action: row.action,
    payload: row.payload ?? {},
    at: tsToMsRequired(row.at),
  }
}

// ── Repository implementation ────────────────────────────────────────────────

export class SupabaseSpatialRepository implements SpatialRepository {
  // ── scans ────────────────────────────────────────────────────────────────

  async createScan(input: CreateScanInput): Promise<Scan> {
    const { data, error } = await supabase
      .from('scans')
      .insert({
        job_id: input.jobId ?? null,
        project_id: input.projectId ?? null,
        presales_project_id: input.presalesProjectId ?? null,
        parent_scan_id: input.parentScanId ?? null,
        source: input.source,
        captured_by: input.capturedBy,
        device_meta: input.deviceMeta ?? {},
        scan_started_at: msToIso(input.scanStartedAt),
        owner_type: input.ownerType ?? 'craftsman',
      })
      .select()
      .single<ScanRow>()
    if (error) throw error
    return rowToScan(data!)
  }

  async getScan(id: string): Promise<Scan | null> {
    const { data, error } = await supabase
      .from('scans')
      .select()
      .eq('id', id)
      .maybeSingle<ScanRow>()
    if (error) throw error
    return data ? rowToScan(data) : null
  }

  async updateScan(id: string, patch: UpdateScanInput): Promise<Scan> {
    const payload: Partial<ScanRow> = {}
    if (patch.status !== undefined) payload.status = patch.status
    if (patch.scanEndedAt !== undefined) payload.scan_ended_at = msToIso(patch.scanEndedAt)
    if (patch.archivedAt !== undefined) payload.archived_at = msToIso(patch.archivedAt)

    const { data, error } = await supabase
      .from('scans')
      .update(payload)
      .eq('id', id)
      .select()
      .single<ScanRow>()
    if (error) throw error
    return rowToScan(data!)
  }

  async deleteScan(id: string): Promise<void> {
    const { error } = await supabase.from('scans').delete().eq('id', id)
    if (error) throw error
  }

  async listScanVersions(rootScanId: string): Promise<Scan[]> {
    const { data, error } = await supabase
      .from('scans')
      .select()
      .or(`id.eq.${rootScanId},parent_scan_id.eq.${rootScanId}`)
      .order('created_at', { ascending: true })
      .returns<ScanRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScan)
  }

  async listScansForJob(jobId: string): Promise<Scan[]> {
    const { data, error } = await supabase
      .from('scans')
      .select()
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
      .returns<ScanRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScan)
  }

  async listScansForProject(projectId: string): Promise<Scan[]> {
    const { data, error } = await supabase
      .from('scans')
      .select()
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .returns<ScanRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScan)
  }

  async listScansForPresalesProject(presalesProjectId: string): Promise<Scan[]> {
    const { data, error } = await supabase
      .from('scans')
      .select()
      .eq('presales_project_id', presalesProjectId)
      .order('created_at', { ascending: false })
      .returns<ScanRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScan)
  }

  async listCustomerVisibleScans(customerUserId: string): Promise<Scan[]> {
    // RLS (`spatial_can_view_scan`) is the authoritative gate; the OR pre-filter
    // just trims the wire payload to candidate rows. Rows where the customer
    // is neither the Self-Scan owner nor the job customer are dropped by RLS.
    // `archived_at IS NULL` filter exposes soft-delete: Phase-3b cleanup
    // archived broken legacy scans (no glb, no valid parametric) so the Hub
    // doesn't surface empty cards.
    const safeId = customerUserId.replace(/[(),\s'"]/g, '')
    const { data, error } = await supabase
      .from('scans')
      .select()
      .or(`captured_by.eq.${safeId},shared_with_customer.eq.true`)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .returns<ScanRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScan)
  }

  async updateScanSharing(scanId: string, value: boolean): Promise<Scan> {
    // The BEFORE-UPDATE-Trigger `spatial_log_share_action` (Block 1) stamps
    // `shared_at` + writes the `spatial_share_audit` row in the same
    // transaction — we only touch the toggle column. RLS `scans_update`
    // gates the row to the job's craftsman. CHECK `scans_sharing_requires_job_chk`
    // rejects shared=true on jobless scans server-side.
    const { data, error } = await supabase
      .from('scans')
      .update({ shared_with_customer: value })
      .eq('id', scanId)
      .select()
      .single<ScanRow>()
    if (error) throw error
    return rowToScan(data!)
  }

  async updateScanQuality(input: UpdateScanQualityInput): Promise<Scan> {
    // F1 columns added by `20260526130000_spatial_v16_phase_2_quality.sql`.
    // The CHECKs (score in [0, 100] + label enum) are enforced server-side;
    // we trust the workflow-level compute via `computeCustomerScanQuality`.
    // `updated_at` is bumped automatically by the existing `set_updated_at`
    // trigger on the scans table.
    const { data, error } = await supabase
      .from('scans')
      .update({
        quality_score: input.score,
        quality_label: input.label,
      })
      .eq('id', input.scanId)
      .select()
      .single<ScanRow>()
    if (error) throw error
    return rowToScan(data!)
  }

  async uploadMeshSnapshot(input: UploadMeshSnapshotInput): Promise<{ path: string }> {
    // F2 bucket layout: `{userId}/{scanId}.usdz`. The bucket INSERT-policy
    // (`(storage.foldername(name))[1] = auth.uid()::text`) requires the
    // first path-segment to be the caller's uid; this mirrors the convention
    // used by `uploadScanAsset` for `project-scans`. `upsert: false` so a
    // duplicate (e.g. Customer re-scan racing) surfaces a real 23505 instead
    // of silently overwriting — Phase 1d locked `B4-D7` = re-scan = new scan
    // row, so the new scanId means a fresh path and no real collision.
    const path = `${input.userId}/${input.scanId}.usdz`
    const { error } = await supabase.storage
      .from('spatial-mesh-snapshots')
      .upload(path, input.blob, {
        contentType: 'model/vnd.usdz+zip',
        cacheControl: '3600',
        upsert: false,
      })
    if (error) throw error
    return { path }
  }

  // ── scan_assets ──────────────────────────────────────────────────────────

  async createScanAsset(input: CreateScanAssetInput): Promise<ScanAsset> {
    const { data, error } = await supabase
      .from('scan_assets')
      .insert({
        scan_id: input.scanId,
        kind: input.kind,
        storage_path: input.storagePath,
        bytes: input.bytes ?? null,
        sha256: input.sha256 ?? null,
        converted_from: input.convertedFrom ?? null,
      })
      .select()
      .single<ScanAssetRow>()
    if (error) throw error
    return rowToScanAsset(data!)
  }

  async listScanAssets(scanId: string): Promise<ScanAsset[]> {
    const { data, error } = await supabase
      .from('scan_assets')
      .select()
      .eq('scan_id', scanId)
      .order('kind')
      .returns<ScanAssetRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanAsset)
  }

  async deleteScanAsset(id: string): Promise<void> {
    const { error } = await supabase.from('scan_assets').delete().eq('id', id)
    if (error) throw error
  }

  // ── scan_rooms ───────────────────────────────────────────────────────────

  async createScanRoom(input: CreateScanRoomInput): Promise<ScanRoom> {
    const { data, error } = await supabase
      .from('scan_rooms')
      .insert({
        scan_id: input.scanId,
        name: input.name ?? null,
        area_m2_estimated: input.areaM2Estimated ?? null,
        ceiling_h_estimated: input.ceilingHEstimated ?? null,
        floor_anchor: input.floorAnchor ?? null,
      })
      .select()
      .single<ScanRoomRow>()
    if (error) throw error
    return rowToScanRoom(data!)
  }

  async updateScanRoom(id: string, patch: UpdateScanRoomInput): Promise<ScanRoom> {
    const payload: Partial<ScanRoomRow> = {}
    if (patch.name !== undefined) payload.name = patch.name
    if (patch.areaM2Verified !== undefined) payload.area_m2_verified = patch.areaM2Verified
    if (patch.ceilingHVerified !== undefined) payload.ceiling_h_verified = patch.ceilingHVerified

    const { data, error } = await supabase
      .from('scan_rooms')
      .update(payload)
      .eq('id', id)
      .select()
      .single<ScanRoomRow>()
    if (error) throw error
    return rowToScanRoom(data!)
  }

  async listScanRooms(scanId: string): Promise<ScanRoom[]> {
    const { data, error } = await supabase
      .from('scan_rooms')
      .select()
      .eq('scan_id', scanId)
      .order('created_at', { ascending: true })
      .returns<ScanRoomRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanRoom)
  }

  async deleteScanRoom(id: string): Promise<void> {
    const { error } = await supabase.from('scan_rooms').delete().eq('id', id)
    if (error) throw error
  }

  // ── scan_surfaces ────────────────────────────────────────────────────────

  async createScanSurface(input: CreateScanSurfaceInput): Promise<ScanSurface> {
    const { data, error } = await supabase
      .from('scan_surfaces')
      .insert({
        room_id: input.roomId,
        surface_external_id: input.surfaceExternalId,
        kind: input.kind,
        dim_w_estimated: input.dimWEstimated ?? null,
        dim_h_estimated: input.dimHEstimated ?? null,
        transform: input.transform ?? null,
        confidence: input.confidence ?? null,
      })
      .select()
      .single<ScanSurfaceRow>()
    if (error) throw error
    return rowToScanSurface(data!)
  }

  async updateScanSurface(id: string, patch: UpdateScanSurfaceInput): Promise<ScanSurface> {
    const payload: Partial<ScanSurfaceRow> = {}
    if (patch.dimWVerified !== undefined) payload.dim_w_verified = patch.dimWVerified
    if (patch.dimHVerified !== undefined) payload.dim_h_verified = patch.dimHVerified
    if (patch.status !== undefined) payload.status = patch.status
    if (patch.confidence !== undefined) payload.confidence = patch.confidence

    const { data, error } = await supabase
      .from('scan_surfaces')
      .update(payload)
      .eq('id', id)
      .select()
      .single<ScanSurfaceRow>()
    if (error) throw error
    return rowToScanSurface(data!)
  }

  async listScanSurfaces(roomId: string): Promise<ScanSurface[]> {
    const { data, error } = await supabase
      .from('scan_surfaces')
      .select()
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .returns<ScanSurfaceRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanSurface)
  }

  async deleteScanSurface(id: string): Promise<void> {
    const { error } = await supabase.from('scan_surfaces').delete().eq('id', id)
    if (error) throw error
  }

  // ── scan_measurements ────────────────────────────────────────────────────

  async createScanMeasurement(input: CreateScanMeasurementInput): Promise<ScanMeasurement> {
    const { data, error } = await supabase
      .from('scan_measurements')
      .insert({
        scan_id: input.scanId,
        surface_id: input.surfaceId ?? null,
        label: input.label ?? null,
        value_estimated_m: input.valueEstimatedM ?? null,
        source: input.source ?? 'roomplan',
      })
      .select()
      .single<ScanMeasurementRow>()
    if (error) throw error
    return rowToScanMeasurement(data!)
  }

  async listScanMeasurements(scanId: string): Promise<ScanMeasurement[]> {
    const { data, error } = await supabase
      .from('scan_measurements')
      .select()
      .eq('scan_id', scanId)
      .order('created_at', { ascending: true })
      .returns<ScanMeasurementRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanMeasurement)
  }

  async verifyScanMeasurement(
    id: string,
    input: VerifyScanMeasurementInput,
  ): Promise<ScanMeasurement> {
    const verifiedAtMs = input.verifiedAt ?? Date.now()
    const { data, error } = await supabase
      .from('scan_measurements')
      .update({
        value_verified_m: input.valueVerifiedM,
        verified_by: input.verifiedBy,
        verified_at: msToIso(verifiedAtMs),
        status: 'provider_verified',
      })
      .eq('id', id)
      .select()
      .single<ScanMeasurementRow>()
    if (error) throw error
    return rowToScanMeasurement(data!)
  }

  async supersedeScanMeasurement(id: string): Promise<ScanMeasurement> {
    // Preserves value_verified_m / verified_by / verified_at for audit.
    const { data, error } = await supabase
      .from('scan_measurements')
      .update({ status: 'superseded' })
      .eq('id', id)
      .select()
      .single<ScanMeasurementRow>()
    if (error) throw error
    return rowToScanMeasurement(data!)
  }

  async deleteScanMeasurement(id: string): Promise<void> {
    const { error } = await supabase.from('scan_measurements').delete().eq('id', id)
    if (error) throw error
  }

  // ── scan_annotations ─────────────────────────────────────────────────────

  async createScanAnnotation(input: CreateScanAnnotationInput): Promise<ScanAnnotation> {
    if (!input.anchorUv && !input.anchor2d) {
      throw new Error(
        'createScanAnnotation: at least one of anchorUv or anchor2d is required (DB CHECK).',
      )
    }
    const customerVisible =
      input.customerVisible ?? defaultCustomerVisibleForKind(input.kind)
    const { data, error } = await supabase
      .from('scan_annotations')
      .insert({
        scan_id: input.scanId,
        kind: input.kind,
        anchor_uv: input.anchorUv ?? null,
        anchor_world_cache: input.anchorWorldCache ?? null,
        anchor_ar_hint: input.anchorArHint ?? null,
        anchor_2d: input.anchor2d ?? null,
        photo_asset_id: input.photoAssetId ?? null,
        note: input.note ?? null,
        gewerk: input.gewerk ?? null,
        customer_visible: customerVisible,
        customer_pin_type: input.customerPinType ?? null,
      })
      .select()
      .single<ScanAnnotationRow>()
    if (error) throw error
    return rowToScanAnnotation(data!)
  }

  async updateScanAnnotation(
    id: string,
    patch: UpdateScanAnnotationInput,
  ): Promise<ScanAnnotation> {
    const payload: Partial<ScanAnnotationRow> = {}
    if (patch.status !== undefined) payload.status = patch.status
    if (patch.note !== undefined) payload.note = patch.note
    if (patch.photoAssetId !== undefined) payload.photo_asset_id = patch.photoAssetId
    if (patch.gewerk !== undefined) payload.gewerk = patch.gewerk
    if (patch.offerRelevant !== undefined) payload.offer_relevant = patch.offerRelevant
    if (patch.customerVisible !== undefined) payload.customer_visible = patch.customerVisible
    if (patch.customerPinType !== undefined)
      payload.customer_pin_type = patch.customerPinType
    // D2 SoT discipline: anchorUv NEVER overwritten by repo updates — only set
    // at create-time. Drift-detection updates only touch cache + confidence.
    if (patch.anchorWorldCache !== undefined) payload.anchor_world_cache = patch.anchorWorldCache
    if (patch.lastDriftCheckAt !== undefined)
      payload.last_drift_check_at = msToIso(patch.lastDriftCheckAt)
    if (patch.lastDriftDistanceM !== undefined)
      payload.last_drift_distance_m = patch.lastDriftDistanceM
    if (patch.confidence !== undefined) payload.confidence = patch.confidence

    const { data, error } = await supabase
      .from('scan_annotations')
      .update(payload)
      .eq('id', id)
      .select()
      .single<ScanAnnotationRow>()
    if (error) throw error
    return rowToScanAnnotation(data!)
  }

  async listScanAnnotations(scanId: string): Promise<ScanAnnotation[]> {
    const { data, error } = await supabase
      .from('scan_annotations')
      .select()
      .eq('scan_id', scanId)
      .order('created_at', { ascending: true })
      .returns<ScanAnnotationRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanAnnotation)
  }

  async deleteScanAnnotation(id: string): Promise<void> {
    const { error } = await supabase.from('scan_annotations').delete().eq('id', id)
    if (error) throw error
  }

  // ── scan_quality_reports ────────────────────────────────────────────────

  async createScanQualityReport(
    input: CreateScanQualityReportInput,
  ): Promise<ScanQualityReport> {
    const { data, error } = await supabase
      .from('scan_quality_reports')
      .insert({
        scan_id: input.scanId,
        score: input.score,
        bucket: input.bucket,
        warnings: input.warnings,
        engine_version: input.engineVersion,
      })
      .select()
      .single<ScanQualityReportRow>()
    if (error) throw error
    return rowToScanQualityReport(data!)
  }

  async listScanQualityReports(scanId: string): Promise<ScanQualityReport[]> {
    const { data, error } = await supabase
      .from('scan_quality_reports')
      .select()
      .eq('scan_id', scanId)
      .order('generated_at', { ascending: false })
      .returns<ScanQualityReportRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanQualityReport)
  }

  async getLatestQualityReport(scanId: string): Promise<ScanQualityReport | null> {
    const { data, error } = await supabase
      .from('scan_quality_reports')
      .select()
      .eq('scan_id', scanId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle<ScanQualityReportRow>()
    if (error) throw error
    return data ? rowToScanQualityReport(data) : null
  }

  async runQualityEngine(
    scanId: string,
    opts?: { meshSummary?: MeshSummary },
  ): Promise<ScanQualityReport> {
    // run_quality_engine returns a single scan_quality_reports row. Supabase's
    // RPC client wraps SETOF + RETURNS-row identically; we get an array of
    // length 1, sometimes typed as the row directly. Normalise both shapes.
    //
    // Phase 2 · `p_mesh_summary` carries the harvested wall-coverage + face
    // counts directly into the RPC, eliminating a storage round-trip for the
    // capture-time evaluation. Migration `20260519000000_quality_engine_mesh_summary`
    // adds the param with `DEFAULT NULL` so the existing zero-arg signature
    // remains backwards-compatible.
    const { data, error } = await supabase.rpc('run_quality_engine', {
      p_scan_id: scanId,
      p_mesh_summary: opts?.meshSummary ?? null,
    })
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : (data as ScanQualityReportRow | null)
    if (!row) {
      throw new Error('run_quality_engine returned no row')
    }
    return rowToScanQualityReport(row as ScanQualityReportRow)
  }

  // ── scan_events (read + RPC-write) ──────────────────────────────────────

  async listScanEvents(scanId: string): Promise<ScanEvent[]> {
    const { data, error } = await supabase
      .from('scan_events')
      .select()
      .eq('scan_id', scanId)
      .order('at', { ascending: false })
      .returns<ScanEventRow[]>()
    if (error) throw error
    return (data ?? []).map(rowToScanEvent)
  }

  /**
   * Append a scan_event via SECURITY DEFINER RPC `record_scan_event`.
   * `actorId` parameter is accepted for interface parity but ignored — the RPC
   * derives the actor from `auth.uid()` so clients cannot spoof.
   */
  async recordScanEvent(
    scanId: string,
    action: ScanEventAction,
    payload: Record<string, unknown> = {},
    idempotencyKey?: string,
    _actorId?: string | null,
  ): Promise<ScanEvent> {
    void _actorId
    const { data, error } = await supabase.rpc('record_scan_event', {
      p_scan_id: scanId,
      p_action: action,
      p_payload: payload,
      p_idempotency_key: idempotencyKey ?? null,
    })
    if (error) throw error
    if (!data) throw new Error('record_scan_event returned no row')
    return rowToScanEvent(data as ScanEventRow)
  }

  // ── Read aggregates ──────────────────────────────────────────────────────

  async getScanDetailView(scanId: string): Promise<ScanDetailView | null> {
    const scan = await this.getScan(scanId)
    if (!scan) return null
    const [assets, rooms, latestQualityReport] = await Promise.all([
      this.listScanAssets(scanId),
      this.listScanRooms(scanId),
      this.getLatestQualityReport(scanId),
    ])
    return { scan, assets, rooms, latestQualityReport }
  }

  async getScanReviewView(scanId: string): Promise<ScanReviewView | null> {
    const scan = await this.getScan(scanId)
    if (!scan) return null
    const [rooms, measurements, annotations, qualityReports] = await Promise.all([
      this.listScanRooms(scanId),
      this.listScanMeasurements(scanId),
      this.listScanAnnotations(scanId),
      this.listScanQualityReports(scanId),
    ])
    // Surfaces are resolved per-room; flatten for the view.
    const surfacesNested = await Promise.all(
      rooms.map(r => this.listScanSurfaces(r.id)),
    )
    const surfaces = surfacesNested.flat()
    return { scan, rooms, surfaces, measurements, annotations, qualityReports }
  }
}
