/**
 * Spatial Core · In-Memory Repository
 *
 * For tests + dev (VITE_DATA_SOURCE='in-memory'). Mirrors Supabase invariants
 * by hand: CHECK constraints, cascade deletes, dispute-lock guard, anchor SoT
 * discipline. Not RLS-aware (mocks bypass auth).
 */

import type { SpatialRepository } from './SpatialRepository'
import { assertScanTransition } from './fsm'
import { runQualityEngine as pureRunQualityEngine } from '../quality'
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
} from '../types'
import { defaultCustomerVisibleForKind } from '../types'

function uid(): string {
  // Predictable enough for tests; not crypto.
  return 'mock_' + Math.random().toString(36).slice(2, 12)
}

export class InMemorySpatialRepository implements SpatialRepository {
  private scans = new Map<string, Scan>()
  private assets = new Map<string, ScanAsset>()
  private rooms = new Map<string, ScanRoom>()
  private surfaces = new Map<string, ScanSurface>()
  private measurements = new Map<string, ScanMeasurement>()
  private annotations = new Map<string, ScanAnnotation>()
  private qualityReports = new Map<string, ScanQualityReport>()
  private events = new Map<string, ScanEvent>()
  /** Phase 2 · F2 mesh-snapshot bucket mirror — path → blob byte count.
   *  Tests assert presence + size; the InMemory adapter does not retain the
   *  actual bytes (would explode memory in long suites). */
  private meshSnapshots = new Map<string, number>()
  /** Phase 2 · F1 quality columns mirror — scanId → { score, label }. Kept
   *  separate from the `Scan` domain object so Phase 3 can decide whether to
   *  promote them into the canonical type without breaking call-sites. */
  private scanQuality = new Map<
    string,
    { score: number; label: 'high' | 'medium' | 'low' }
  >()

  /** Test helper: append a scan_event row. Production path uses
   *  SECURITY DEFINER RPCs, but tests need to seed audit history. */
  appendScanEvent(event: Omit<ScanEvent, 'id' | 'at'> & { at?: number }): ScanEvent {
    const row: ScanEvent = {
      id: uid(),
      scanId: event.scanId,
      actorId: event.actorId,
      action: event.action,
      payload: event.payload ?? {},
      at: event.at ?? Date.now(),
    }
    this.events.set(row.id, row)
    return row
  }

  /** Test helper: drop all state. */
  reset(): void {
    this.scans.clear()
    this.assets.clear()
    this.rooms.clear()
    this.surfaces.clear()
    this.measurements.clear()
    this.annotations.clear()
    this.qualityReports.clear()
    this.events.clear()
    this.meshSnapshots.clear()
    this.scanQuality.clear()
  }

  /** Test helper: inspect Phase 2 mesh-snapshot uploads.
   *  Returns the byte count for the given path, or `undefined` when missing. */
  getMeshSnapshotBytes(path: string): number | undefined {
    return this.meshSnapshots.get(path)
  }

  /** Test helper: inspect Phase 2 F1 quality persist on a scan. */
  getScanQuality(
    scanId: string,
  ): { score: number; label: 'high' | 'medium' | 'low' } | undefined {
    return this.scanQuality.get(scanId)
  }

  // ── dispute-lock helper ─────────────────────────────────────────────────

  private assertScanWritable(scanId: string, table: string): void {
    const scan = this.scans.get(scanId)
    if (scan && scan.status === 'locked_for_dispute') {
      throw new Error(
        `scan ${scanId} is locked_for_dispute - writes blocked (table ${table})`,
      )
    }
  }

  // ── scans ────────────────────────────────────────────────────────────────

  async createScan(input: CreateScanInput): Promise<Scan> {
    const ownerType = input.ownerType ?? 'craftsman'
    // DB CHECK scans_owner_anchor_chk: jobless scans only allowed for owner_type='customer' (Lane 3 V1.6 Self-Scan).
    if (
      ownerType !== 'customer' &&
      !input.jobId &&
      !input.projectId &&
      !input.presalesProjectId
    ) {
      throw new Error(
        'createScan: jobId OR projectId OR presalesProjectId required (DB CHECK scans_owner_anchor_chk).',
      )
    }
    const now = Date.now()
    const scan: Scan = {
      id: uid(),
      jobId: input.jobId ?? null,
      projectId: input.projectId ?? null,
      presalesProjectId: input.presalesProjectId ?? null,
      parentScanId: input.parentScanId ?? null,
      status: 'draft',
      source: input.source,
      capturedBy: input.capturedBy,
      deviceMeta: input.deviceMeta ?? {},
      scanStartedAt: input.scanStartedAt ?? null,
      scanEndedAt: null,
      archivedAt: null,
      ownerType,
      sharedWithCustomer: false,
      sharedAt: null,
      sharedWithProviderId: null,
      sharedWithProviderAt: null,
      qualityScore: null,
      qualityLabel: null,
      createdAt: now,
      updatedAt: now,
    }
    this.scans.set(scan.id, scan)
    return scan
  }

  async getScan(id: string): Promise<Scan | null> {
    return this.scans.get(id) ?? null
  }

  async updateScan(id: string, patch: UpdateScanInput): Promise<Scan> {
    const scan = this.scans.get(id)
    if (!scan) throw new Error(`scan ${id} not found`)
    // Dispute-lock guard: re-lock attempt is blocked even for the operator-mock
    // (matches the existing scans_dispute_lock_guard DB trigger). All other
    // transitions out of locked_for_dispute fall through to FSM validation
    // below (the InMemory mock has no role distinction).
    if (
      scan.status === 'locked_for_dispute' &&
      patch.status !== undefined &&
      patch.status === 'locked_for_dispute'
    ) {
      throw new Error(`scan ${id} is locked_for_dispute - writes blocked (table scans)`)
    }
    // FSM enforcement — mirrors enforce_scan_fsm() DB trigger. Throws
    // ScanFsmViolation (with code='23514') for illegal (from -> to) pairs.
    if (patch.status !== undefined && patch.status !== scan.status) {
      assertScanTransition(scan.status, patch.status)
    }
    const previousStatus = scan.status
    const next: Scan = {
      ...scan,
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.scanEndedAt !== undefined && { scanEndedAt: patch.scanEndedAt }),
      ...(patch.archivedAt !== undefined && { archivedAt: patch.archivedAt }),
      updatedAt: Date.now(),
    }
    this.scans.set(id, next)
    // Mirror DB-side audit: enforce_scan_fsm() writes scan_status_transition_log
    // for every status transition. We don't have a separate transition-log
    // table in-memory (kept simple), but the test that asserts the log entry
    // exists exercises this side-effect via the ScanFsmViolation contract.
    void previousStatus
    return next
  }

  async deleteScan(id: string): Promise<void> {
    const scan = this.scans.get(id)
    if (!scan) return
    if (scan.status === 'locked_for_dispute') {
      throw new Error(`scan ${id} is locked_for_dispute - delete blocked`)
    }
    // Cascade
    for (const [aid, a] of this.assets) if (a.scanId === id) this.assets.delete(aid)
    for (const [rid, r] of this.rooms) {
      if (r.scanId === id) {
        for (const [sid, s] of this.surfaces) if (s.roomId === rid) this.surfaces.delete(sid)
        this.rooms.delete(rid)
      }
    }
    for (const [mid, m] of this.measurements) if (m.scanId === id) this.measurements.delete(mid)
    for (const [aid, a] of this.annotations) if (a.scanId === id) this.annotations.delete(aid)
    for (const [qid, q] of this.qualityReports)
      if (q.scanId === id) this.qualityReports.delete(qid)
    for (const [eid, e] of this.events) if (e.scanId === id) this.events.delete(eid)
    this.scans.delete(id)
  }

  async listScanVersions(rootScanId: string): Promise<Scan[]> {
    const out: Scan[] = []
    for (const s of this.scans.values()) {
      if (s.id === rootScanId || s.parentScanId === rootScanId) out.push(s)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async listScansForJob(jobId: string): Promise<Scan[]> {
    return Array.from(this.scans.values())
      .filter(s => s.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async listScansForProject(projectId: string): Promise<Scan[]> {
    return Array.from(this.scans.values())
      .filter(s => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async listScansForPresalesProject(presalesProjectId: string): Promise<Scan[]> {
    return Array.from(this.scans.values())
      .filter(s => s.presalesProjectId === presalesProjectId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async listCustomerVisibleScans(customerUserId: string): Promise<Scan[]> {
    return Array.from(this.scans.values())
      .filter(
        s =>
          (s.ownerType === 'customer' && s.capturedBy === customerUserId)
          || (s.sharedWithCustomer === true && s.jobId !== null),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async updateScanSharing(scanId: string, value: boolean): Promise<Scan> {
    const scan = this.scans.get(scanId)
    if (!scan) throw new Error(`scan ${scanId} not found`)
    this.assertScanWritable(scanId, 'scans')
    // DB CHECK scans_sharing_requires_job_chk: shared_with_customer=true only
    // when job_id IS NOT NULL.
    if (value && scan.jobId === null) {
      throw new Error(
        `updateScanSharing: cannot share scan ${scanId} — no job anchor (DB CHECK scans_sharing_requires_job_chk).`,
      )
    }
    // Same-value short-circuit — mirrors the DB trigger which no-ops on
    // OLD.shared_with_customer = NEW.shared_with_customer and writes no audit
    // row. Realtime publication therefore does not fire either (silent).
    if (scan.sharedWithCustomer === value) return scan
    const next: Scan = {
      ...scan,
      sharedWithCustomer: value,
      sharedAt: value ? Date.now() : null,
      updatedAt: Date.now(),
    }
    this.scans.set(scanId, next)
    return next
  }

  async updateScanQuality(input: UpdateScanQualityInput): Promise<Scan> {
    const scan = this.scans.get(input.scanId)
    if (!scan) throw new Error(`scan ${input.scanId} not found`)
    this.assertScanWritable(input.scanId, 'scans')
    // Mirror DB CHECK on `scans.quality_score` (smallint, 0-100).
    if (
      !Number.isFinite(input.score) ||
      input.score < 0 ||
      input.score > 100
    ) {
      throw new Error(
        `updateScanQuality: score ${input.score} out of [0, 100] range (DB CHECK).`,
      )
    }
    this.scanQuality.set(input.scanId, { score: input.score, label: input.label })
    const next: Scan = {
      ...scan,
      qualityScore: input.score,
      qualityLabel: input.label,
      updatedAt: Date.now(),
    }
    this.scans.set(input.scanId, next)
    return next
  }

  async uploadMeshSnapshot(input: UploadMeshSnapshotInput): Promise<{ path: string }> {
    // Mirror the storage-RLS contract: path must start with the caller's
    // userId. The Supabase adapter relies on a bucket-level policy; the mock
    // enforces the same shape so test failures surface contract violations
    // before TestFlight.
    if (!input.userId || !input.scanId) {
      throw new Error('uploadMeshSnapshot: userId AND scanId required.')
    }
    if (!input.blob || input.blob.size === 0) {
      throw new Error('uploadMeshSnapshot: blob is empty.')
    }
    const path = `${input.userId}/${input.scanId}.usdz`
    // Mirror `upsert: false` — refuse to overwrite an existing snapshot.
    if (this.meshSnapshots.has(path)) {
      throw new Error(
        `uploadMeshSnapshot: snapshot already exists at ${path} (upsert: false).`,
      )
    }
    this.meshSnapshots.set(path, input.blob.size)
    return { path }
  }

  // ── scan_assets ──────────────────────────────────────────────────────────

  async createScanAsset(input: CreateScanAssetInput): Promise<ScanAsset> {
    this.assertScanWritable(input.scanId, 'scan_assets')
    // UNIQUE (scan_id, kind)
    for (const a of this.assets.values()) {
      if (a.scanId === input.scanId && a.kind === input.kind) {
        throw new Error(
          `scan_assets UNIQUE violation: (${input.scanId}, ${input.kind}) already exists`,
        )
      }
    }
    const asset: ScanAsset = {
      id: uid(),
      scanId: input.scanId,
      kind: input.kind,
      storagePath: input.storagePath,
      bytes: input.bytes ?? null,
      sha256: input.sha256 ?? null,
      convertedFrom: input.convertedFrom ?? null,
      createdAt: Date.now(),
    }
    this.assets.set(asset.id, asset)
    return asset
  }

  async listScanAssets(scanId: string): Promise<ScanAsset[]> {
    return Array.from(this.assets.values())
      .filter(a => a.scanId === scanId)
      .sort((a, b) => a.kind.localeCompare(b.kind))
  }

  async deleteScanAsset(id: string): Promise<void> {
    const asset = this.assets.get(id)
    if (asset) this.assertScanWritable(asset.scanId, 'scan_assets')
    this.assets.delete(id)
  }

  // ── scan_rooms ───────────────────────────────────────────────────────────

  async createScanRoom(input: CreateScanRoomInput): Promise<ScanRoom> {
    this.assertScanWritable(input.scanId, 'scan_rooms')
    const now = Date.now()
    const room: ScanRoom = {
      id: uid(),
      scanId: input.scanId,
      name: input.name ?? null,
      areaM2Estimated: input.areaM2Estimated ?? null,
      areaM2Verified: null,
      ceilingHEstimated: input.ceilingHEstimated ?? null,
      ceilingHVerified: null,
      floorAnchor: input.floorAnchor ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.rooms.set(room.id, room)
    return room
  }

  async updateScanRoom(id: string, patch: UpdateScanRoomInput): Promise<ScanRoom> {
    const room = this.rooms.get(id)
    if (!room) throw new Error(`scan_room ${id} not found`)
    this.assertScanWritable(room.scanId, 'scan_rooms')
    const next: ScanRoom = {
      ...room,
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.areaM2Verified !== undefined && { areaM2Verified: patch.areaM2Verified }),
      ...(patch.ceilingHVerified !== undefined && { ceilingHVerified: patch.ceilingHVerified }),
      updatedAt: Date.now(),
    }
    this.rooms.set(id, next)
    return next
  }

  async listScanRooms(scanId: string): Promise<ScanRoom[]> {
    return Array.from(this.rooms.values())
      .filter(r => r.scanId === scanId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async deleteScanRoom(id: string): Promise<void> {
    const room = this.rooms.get(id)
    if (room) {
      this.assertScanWritable(room.scanId, 'scan_rooms')
      for (const [sid, s] of this.surfaces) if (s.roomId === id) this.surfaces.delete(sid)
    }
    this.rooms.delete(id)
  }

  // ── scan_surfaces ────────────────────────────────────────────────────────

  async createScanSurface(input: CreateScanSurfaceInput): Promise<ScanSurface> {
    const room = this.rooms.get(input.roomId)
    if (!room) throw new Error(`scan_room ${input.roomId} not found`)
    this.assertScanWritable(room.scanId, 'scan_surfaces')
    // UNIQUE (room_id, surface_external_id)
    for (const s of this.surfaces.values()) {
      if (s.roomId === input.roomId && s.surfaceExternalId === input.surfaceExternalId) {
        throw new Error(
          `scan_surfaces UNIQUE violation: (${input.roomId}, ${input.surfaceExternalId})`,
        )
      }
    }
    if (input.confidence !== undefined && input.confidence !== null) {
      if (input.confidence < 0 || input.confidence > 1) {
        throw new Error('scan_surfaces.confidence out of [0, 1] range')
      }
    }
    const now = Date.now()
    const surface: ScanSurface = {
      id: uid(),
      roomId: input.roomId,
      surfaceExternalId: input.surfaceExternalId,
      kind: input.kind,
      dimWEstimated: input.dimWEstimated ?? null,
      dimHEstimated: input.dimHEstimated ?? null,
      dimWVerified: null,
      dimHVerified: null,
      transform: input.transform ?? null,
      status: 'estimated_roomplan',
      confidence: input.confidence ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.surfaces.set(surface.id, surface)
    return surface
  }

  async updateScanSurface(id: string, patch: UpdateScanSurfaceInput): Promise<ScanSurface> {
    const surface = this.surfaces.get(id)
    if (!surface) throw new Error(`scan_surface ${id} not found`)
    const room = this.rooms.get(surface.roomId)
    if (room) this.assertScanWritable(room.scanId, 'scan_surfaces')
    const next: ScanSurface = {
      ...surface,
      ...(patch.dimWVerified !== undefined && { dimWVerified: patch.dimWVerified }),
      ...(patch.dimHVerified !== undefined && { dimHVerified: patch.dimHVerified }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.confidence !== undefined && { confidence: patch.confidence }),
      updatedAt: Date.now(),
    }
    this.surfaces.set(id, next)
    return next
  }

  async listScanSurfaces(roomId: string): Promise<ScanSurface[]> {
    return Array.from(this.surfaces.values())
      .filter(s => s.roomId === roomId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async deleteScanSurface(id: string): Promise<void> {
    const surface = this.surfaces.get(id)
    if (surface) {
      const room = this.rooms.get(surface.roomId)
      if (room) this.assertScanWritable(room.scanId, 'scan_surfaces')
    }
    this.surfaces.delete(id)
  }

  // ── scan_measurements ────────────────────────────────────────────────────

  async createScanMeasurement(
    input: CreateScanMeasurementInput,
  ): Promise<ScanMeasurement> {
    this.assertScanWritable(input.scanId, 'scan_measurements')
    const now = Date.now()
    const m: ScanMeasurement = {
      id: uid(),
      scanId: input.scanId,
      surfaceId: input.surfaceId ?? null,
      label: input.label ?? null,
      valueEstimatedM: input.valueEstimatedM ?? null,
      valueVerifiedM: null,
      unit: 'm',
      status: 'estimated_roomplan',
      source: input.source ?? 'roomplan',
      verifiedBy: null,
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.measurements.set(m.id, m)
    return m
  }

  async listScanMeasurements(scanId: string): Promise<ScanMeasurement[]> {
    return Array.from(this.measurements.values())
      .filter(m => m.scanId === scanId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async verifyScanMeasurement(
    id: string,
    input: VerifyScanMeasurementInput,
  ): Promise<ScanMeasurement> {
    const m = this.measurements.get(id)
    if (!m) throw new Error(`scan_measurement ${id} not found`)
    this.assertScanWritable(m.scanId, 'scan_measurements')
    const next: ScanMeasurement = {
      ...m,
      valueVerifiedM: input.valueVerifiedM,
      verifiedBy: input.verifiedBy,
      verifiedAt: input.verifiedAt ?? Date.now(),
      status: 'provider_verified',
      updatedAt: Date.now(),
    }
    this.measurements.set(id, next)
    return next
  }

  async supersedeScanMeasurement(id: string): Promise<ScanMeasurement> {
    const m = this.measurements.get(id)
    if (!m) throw new Error(`scan_measurement ${id} not found`)
    this.assertScanWritable(m.scanId, 'scan_measurements')
    const next: ScanMeasurement = { ...m, status: 'superseded', updatedAt: Date.now() }
    this.measurements.set(id, next)
    return next
  }

  async deleteScanMeasurement(id: string): Promise<void> {
    const m = this.measurements.get(id)
    if (m) this.assertScanWritable(m.scanId, 'scan_measurements')
    this.measurements.delete(id)
  }

  // ── scan_annotations ─────────────────────────────────────────────────────

  async createScanAnnotation(input: CreateScanAnnotationInput): Promise<ScanAnnotation> {
    this.assertScanWritable(input.scanId, 'scan_annotations')
    if (!input.anchorUv && !input.anchor2d) {
      throw new Error('createScanAnnotation: anchorUv OR anchor2d required (DB CHECK).')
    }
    const now = Date.now()
    const a: ScanAnnotation = {
      id: uid(),
      scanId: input.scanId,
      kind: input.kind,
      anchorUv: input.anchorUv ?? null,
      anchorWorldCache: input.anchorWorldCache ?? null,
      anchorArHint: input.anchorArHint ?? null,
      anchor2d: input.anchor2d ?? null,
      lastDriftCheckAt: null,
      lastDriftDistanceM: null,
      confidence: 'high',
      photoAssetId: input.photoAssetId ?? null,
      note: input.note ?? null,
      status: 'open',
      gewerk: input.gewerk ?? null,
      offerRelevant: false,
      offerLineItemId: null,
      customerVisible: input.customerVisible ?? defaultCustomerVisibleForKind(input.kind),
      customerPinType: input.customerPinType ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.annotations.set(a.id, a)
    return a
  }

  async updateScanAnnotation(
    id: string,
    patch: UpdateScanAnnotationInput,
  ): Promise<ScanAnnotation> {
    const a = this.annotations.get(id)
    if (!a) throw new Error(`scan_annotation ${id} not found`)
    this.assertScanWritable(a.scanId, 'scan_annotations')
    // D2 SoT discipline: anchorUv is never patched here.
    const next: ScanAnnotation = {
      ...a,
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.note !== undefined && { note: patch.note }),
      ...(patch.photoAssetId !== undefined && { photoAssetId: patch.photoAssetId }),
      ...(patch.gewerk !== undefined && { gewerk: patch.gewerk }),
      ...(patch.offerRelevant !== undefined && { offerRelevant: patch.offerRelevant }),
      ...(patch.customerVisible !== undefined && { customerVisible: patch.customerVisible }),
      ...(patch.customerPinType !== undefined && { customerPinType: patch.customerPinType }),
      ...(patch.anchorWorldCache !== undefined && { anchorWorldCache: patch.anchorWorldCache }),
      ...(patch.lastDriftCheckAt !== undefined && { lastDriftCheckAt: patch.lastDriftCheckAt }),
      ...(patch.lastDriftDistanceM !== undefined && {
        lastDriftDistanceM: patch.lastDriftDistanceM,
      }),
      ...(patch.confidence !== undefined && { confidence: patch.confidence }),
      updatedAt: Date.now(),
    }
    this.annotations.set(id, next)
    return next
  }

  async listScanAnnotations(scanId: string): Promise<ScanAnnotation[]> {
    return Array.from(this.annotations.values())
      .filter(a => a.scanId === scanId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async deleteScanAnnotation(id: string): Promise<void> {
    const a = this.annotations.get(id)
    if (a) this.assertScanWritable(a.scanId, 'scan_annotations')
    this.annotations.delete(id)
  }

  // ── scan_quality_reports ────────────────────────────────────────────────

  async createScanQualityReport(
    input: CreateScanQualityReportInput,
  ): Promise<ScanQualityReport> {
    if (input.score < 0 || input.score > 100) {
      throw new Error('scan_quality_reports.score out of [0, 100] range')
    }
    const report: ScanQualityReport = {
      id: uid(),
      scanId: input.scanId,
      score: input.score,
      bucket: input.bucket,
      warnings: input.warnings,
      engineVersion: input.engineVersion,
      generatedAt: Date.now(),
    }
    this.qualityReports.set(report.id, report)
    return report
  }

  async listScanQualityReports(scanId: string): Promise<ScanQualityReport[]> {
    return Array.from(this.qualityReports.values())
      .filter(q => q.scanId === scanId)
      .sort((a, b) => b.generatedAt - a.generatedAt)
  }

  async getLatestQualityReport(scanId: string): Promise<ScanQualityReport | null> {
    const list = await this.listScanQualityReports(scanId)
    return list[0] ?? null
  }

  async runQualityEngine(
    scanId: string,
    opts?: { meshSummary?: MeshSummary },
  ): Promise<ScanQualityReport> {
    // In-process mirror of the SECURITY DEFINER RPC. Pulls the same scan
    // snapshot the SQL function reads and feeds it through the shared TS
    // rules so parity tests can run without a database.
    const rooms = await this.listScanRooms(scanId)
    const surfaces: ScanSurface[] = []
    for (const r of rooms) {
      const part = await this.listScanSurfaces(r.id)
      surfaces.push(...part)
    }
    const measurements = await this.listScanMeasurements(scanId)
    const result = pureRunQualityEngine({
      rooms,
      surfaces,
      measurements,
      meshSummary: opts?.meshSummary,
    })
    const report = await this.createScanQualityReport({
      scanId,
      score: result.score,
      bucket: result.bucket,
      warnings: result.warnings,
      engineVersion: result.engineVersion,
    })
    // Audit-parity with SupabaseRepo + migration 20260519000010: the flag
    // fires only when meshSummary actually carried a field a rule consumed,
    // not just because the dict reference was non-null. Empty object → false.
    const meshSummaryUsed =
      opts?.meshSummary != null &&
      (opts.meshSummary.wallCoveragePct != null ||
        opts.meshSummary.averageConfidence != null)
    await this.recordScanEvent(scanId, 'quality_run', {
      score: result.score,
      bucket: result.bucket,
      warnings: result.warnings,
      engineVersion: result.engineVersion,
      reportId: report.id,
      meshSummaryUsed,
    })
    return report
  }

  // ── scan_events ──────────────────────────────────────────────────────────

  async listScanEvents(scanId: string): Promise<ScanEvent[]> {
    return Array.from(this.events.values())
      .filter(e => e.scanId === scanId)
      .sort((a, b) => b.at - a.at)
  }

  /**
   * Mirrors SECURITY DEFINER RPC `record_scan_event(scan_id, action, payload, idempotency_key)`.
   *
   * Idempotency: when `idempotencyKey` is supplied, a second call with the
   * same (scanId, idempotencyKey) returns the previously-written event without
   * inserting again — matches the DB partial UNIQUE index ON CONFLICT noop.
   */
  async recordScanEvent(
    scanId: string,
    action: ScanEventAction,
    payload: Record<string, unknown> = {},
    idempotencyKey?: string,
    actorId?: string | null,
  ): Promise<ScanEvent> {
    const scan = this.scans.get(scanId)
    if (!scan) throw new Error(`scan ${scanId} not found`)
    if (idempotencyKey) {
      for (const existing of this.events.values()) {
        if (
          existing.scanId === scanId &&
          (existing.payload as { _idempotencyKey?: string })?._idempotencyKey === idempotencyKey
        ) {
          return existing
        }
      }
    }
    const persistedPayload = idempotencyKey
      ? { ...payload, _idempotencyKey: idempotencyKey }
      : payload
    const event: ScanEvent = {
      id: uid(),
      scanId,
      actorId: actorId ?? null,
      action,
      payload: persistedPayload,
      at: Date.now(),
    }
    this.events.set(event.id, event)
    return event
  }

  // ── Read aggregates ──────────────────────────────────────────────────────

  async getScanDetailView(scanId: string): Promise<ScanDetailView | null> {
    const scan = await this.getScan(scanId)
    if (!scan) return null
    return {
      scan,
      assets: await this.listScanAssets(scanId),
      rooms: await this.listScanRooms(scanId),
      latestQualityReport: await this.getLatestQualityReport(scanId),
    }
  }

  async getScanReviewView(scanId: string): Promise<ScanReviewView | null> {
    const scan = await this.getScan(scanId)
    if (!scan) return null
    const rooms = await this.listScanRooms(scanId)
    const surfacesNested = await Promise.all(rooms.map(r => this.listScanSurfaces(r.id)))
    return {
      scan,
      rooms,
      surfaces: surfacesNested.flat(),
      measurements: await this.listScanMeasurements(scanId),
      annotations: await this.listScanAnnotations(scanId),
      qualityReports: await this.listScanQualityReports(scanId),
    }
  }
}
