/**
 * Spatial Core · Repository Interface
 *
 * Mock-swappable persistence boundary for the spatial domain (matches SaFix
 * data-source contract — VITE_DATA_SOURCE = 'in-memory' | 'supabase').
 *
 * Write paths enforce DB-level invariants on the caller side too:
 *   - `verifyMeasurement` writes value + verifier + at atomically.
 *   - `updateAnnotationDriftCache` never overwrites anchorUv (D2 SoT discipline).
 *   - `recordScanEvent` routes through SECURITY DEFINER RPC `record_scan_event`
 *     on Supabase (added in A.1 migration 20260518000006); the InMemory mock
 *     keeps the same idempotency contract.
 */

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
} from '../types'
import type { MeshSummary } from '../quality/rules'

export interface SpatialRepository {
  // ── scans ────────────────────────────────────────────────────────────────
  createScan(input: CreateScanInput): Promise<Scan>
  getScan(id: string): Promise<Scan | null>
  updateScan(id: string, patch: UpdateScanInput): Promise<Scan>
  deleteScan(id: string): Promise<void>
  /** Re-scan linkage: list all scans rooted at the given scan (versioning). */
  listScanVersions(rootScanId: string): Promise<Scan[]>
  /** All scans on a job (across re-scan versions). */
  listScansForJob(jobId: string): Promise<Scan[]>
  /** All scans on a project (across re-scan versions). */
  listScansForProject(projectId: string): Promise<Scan[]>
  /** All scans rooted at a Pre-Sales project (Ü-01 thumbnail resolution). */
  listScansForPresalesProject(presalesProjectId: string): Promise<Scan[]>
  /**
   * Lane 3 V1.6 Block 3 — Customer-visible scans across all jobs / Self-Scans.
   *
   * Returns scans where any of:
   *   - HW-owned scan with `shared_with_customer = true` on a job whose
   *     `customer_user_id` equals `customerUserId`
   *   - Customer-owned Self-Scan with `captured_by = customerUserId`
   *
   * The Supabase impl relies on RLS (`spatial_can_view_scan`) for the
   * authoritative filter; the OR pre-filter just trims the wire payload.
   * The InMemory impl uses scan-row predicates only — it does NOT join jobs
   * (tests assert the scan-level filter; the cross-table check lives in
   * RLS unit tests on the migration side).
   */
  listCustomerVisibleScans(customerUserId: string): Promise<Scan[]>

  /**
   * Lane 3 V1.6 Block 2 — HW share-toggle on a single scan.
   *
   * Sets `scans.shared_with_customer = value`. The Supabase impl relies on
   * the `spatial_log_share_action` BEFORE-UPDATE trigger to stamp `shared_at`
   * + write the `spatial_share_audit` row in the same transaction. The
   * InMemory impl mirrors both: timestamps + same-value short-circuit.
   *
   * CHECK contract: `value === true` requires `scan.jobId !== null` (mirrors
   * DB `scans_sharing_requires_job_chk`). Throws when violated so the workflow
   * surface gets a clean failure path even on the mock.
   *
   * Same-value idempotency: when the row already matches `value`, returns
   * the scan unchanged (no `updatedAt` bump, no audit-row). Matches the DB
   * trigger which no-ops on `OLD.shared_with_customer = NEW.shared_with_customer`.
   */
  updateScanSharing(scanId: string, value: boolean): Promise<Scan>

  /**
   * Lane 3 V1.6 · Phase 2 · Customer-LiDAR-Scene Quality Persist
   *
   * Writes `quality_score` + `quality_label` (F1 migration columns) on the
   * given scan and bumps `updated_at`. Score is clamped to [0, 100] by the
   * caller (workflow-level customer-quality compute); the repo trusts the
   * value and lets the DB CHECK enforce range on the Supabase path.
   *
   * Idempotent in the practical sense — re-writing the same score/label is
   * a no-op except for `updated_at`. No FSM coupling: any scan status may
   * accept a quality write (used by both the live-capture path AND a
   * potential operator re-score in Phase 5).
   */
  updateScanQuality(input: UpdateScanQualityInput): Promise<Scan>

  /**
   * Lane 3 V1.6 · Phase 2 · Customer-LiDAR Mesh-Snapshot Upload
   *
   * PUTs the captured USDZ to the `spatial-mesh-snapshots` bucket (F2). The
   * path layout is `{userId}/{scanId}.usdz` so the bucket INSERT-policy
   * (`(storage.foldername(name))[1] = auth.uid()::text`) accepts it.
   *
   * Returns the full storage key (`{userId}/{scanId}.usdz`) so callers can
   * persist it alongside the scan row when Phase 3 adds a `mesh_snapshot_path`
   * column. Phase 2 just confirms the upload happened; the path is reproducible
   * from `userId + scanId`.
   *
   * Throws on storage error (RLS-401, MIME mismatch, quota). Callers should
   * surface a typed failure ('mesh_upload_failed') rather than re-throw raw.
   */
  uploadMeshSnapshot(input: UploadMeshSnapshotInput): Promise<{ path: string }>

  // ── scan_assets (D1: dual USDZ + glTF) ───────────────────────────────────
  createScanAsset(input: CreateScanAssetInput): Promise<ScanAsset>
  listScanAssets(scanId: string): Promise<ScanAsset[]>
  deleteScanAsset(id: string): Promise<void>

  // ── scan_rooms ───────────────────────────────────────────────────────────
  createScanRoom(input: CreateScanRoomInput): Promise<ScanRoom>
  updateScanRoom(id: string, patch: UpdateScanRoomInput): Promise<ScanRoom>
  listScanRooms(scanId: string): Promise<ScanRoom[]>
  deleteScanRoom(id: string): Promise<void>

  // ── scan_surfaces ────────────────────────────────────────────────────────
  createScanSurface(input: CreateScanSurfaceInput): Promise<ScanSurface>
  updateScanSurface(id: string, patch: UpdateScanSurfaceInput): Promise<ScanSurface>
  listScanSurfaces(roomId: string): Promise<ScanSurface[]>
  deleteScanSurface(id: string): Promise<void>

  // ── scan_measurements ────────────────────────────────────────────────────
  createScanMeasurement(input: CreateScanMeasurementInput): Promise<ScanMeasurement>
  listScanMeasurements(scanId: string): Promise<ScanMeasurement[]>
  /** Atomic verified-write: sets value + verifier + verifiedAt + status in
   *  one round-trip (mirrors DB CHECK scan_measurements_verified_consistency_chk). */
  verifyScanMeasurement(id: string, input: VerifyScanMeasurementInput): Promise<ScanMeasurement>
  /** Soft-supersede: sets status='superseded' without erasing verified history. */
  supersedeScanMeasurement(id: string): Promise<ScanMeasurement>
  deleteScanMeasurement(id: string): Promise<void>

  // ── scan_annotations (D2 anchor system) ──────────────────────────────────
  createScanAnnotation(input: CreateScanAnnotationInput): Promise<ScanAnnotation>
  updateScanAnnotation(id: string, patch: UpdateScanAnnotationInput): Promise<ScanAnnotation>
  listScanAnnotations(scanId: string): Promise<ScanAnnotation[]>
  deleteScanAnnotation(id: string): Promise<void>

  // ── scan_quality_reports ────────────────────────────────────────────────
  /** Pure-function Quality Engine V1 output. Writes go through SECURITY
   *  DEFINER context once the engine RPC lands; until then only operators
   *  can insert (per RLS). */
  createScanQualityReport(input: CreateScanQualityReportInput): Promise<ScanQualityReport>
  listScanQualityReports(scanId: string): Promise<ScanQualityReport[]>
  /** Convenience: most-recent generatedAt. */
  getLatestQualityReport(scanId: string): Promise<ScanQualityReport | null>

  /**
   * Block C.2 — Server-authoritative Quality Engine V1 run.
   *
   * Supabase path calls the SECURITY DEFINER RPC `public.run_quality_engine`
   * which inserts a fresh `scan_quality_reports` row and emits a
   * `quality_run` audit event in one round-trip. The InMemory mock executes
   * the same rules in-process via `runQualityEngine()` from
   * `src/lib/spatial/quality/`.
   *
   * Phase 2 · `opts.meshSummary` carries the freshly-harvested mesh aggregate
   * into the engine (R6 wall_coverage + R7 mesh-preference activation). The
   * Supabase path forwards it as `p_mesh_summary` jsonb to the RPC. Pass
   * `undefined` to evaluate on Plan B (surface-confidence fallback) — TS and
   * SQL stay byte-parity-identical in that case.
   *
   * Idempotency: not idempotent by design — every call records a new row +
   * audit event. Callers that want the latest report cheaply should use
   * `getLatestQualityReport()`.
   */
  runQualityEngine(
    scanId: string,
    opts?: { meshSummary?: MeshSummary },
  ): Promise<ScanQualityReport>

  // ── scan_events (append-only) ───────────────────────────────────────────
  listScanEvents(scanId: string): Promise<ScanEvent[]>

  /**
   * Append a scan audit event via SECURITY DEFINER RPC `record_scan_event`.
   *
   * Idempotency: when `idempotencyKey` (UUID) is supplied, a second call with
   * the same `(scanId, idempotencyKey)` returns the previously-persisted event
   * without inserting again (DB partial UNIQUE index + ON CONFLICT noop).
   *
   * `actorId` is server-side derived from `auth.uid()` on the Supabase path;
   * the in-memory mock accepts an explicit override for test setup.
   */
  recordScanEvent(
    scanId: string,
    action: ScanEventAction,
    payload?: Record<string, unknown>,
    idempotencyKey?: string,
    actorId?: string | null,
  ): Promise<ScanEvent>

  // ── Read aggregates (denormalized, mock-swappable) ──────────────────────
  getScanDetailView(scanId: string): Promise<ScanDetailView | null>
  getScanReviewView(scanId: string): Promise<ScanReviewView | null>
}
