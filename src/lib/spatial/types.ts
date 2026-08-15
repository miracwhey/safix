/**
 * Spatial Core · Block A · Domain Types
 *
 * Maps the spatial Postgres domain (migrations 20260518000002 + 20260518000003)
 * into TS domain types. Mirrors the SaFix convention: snake_case in DB,
 * camelCase here; `id: string` for uuids; `createdAt: number` for unix-ms.
 *
 * Decisions:
 *   D1 — dual USDZ + glTF (ScanAssetKind covers both, plus mesh/json/svg).
 *   D2 — hybrid 3-layer anchor: anchorUv (SoT) + anchorWorldCache + anchorArHint
 *        + anchor2d (fallback). AnchorConfidence drives UI badges + review CTAs.
 *   D5 — defer geometry-edit: surfaces hold estimated + verified dims only.
 */

// ── Enums (mirror DB enum types) ─────────────────────────────────────────────

export type ScanStatus =
  | 'draft'
  | 'capturing'
  | 'captured'
  | 'quality_checked'
  | 'needs_rescan'
  | 'needs_provider_review'
  | 'provider_verified'
  | 'offer_ready'
  | 'locked_for_dispute'
  | 'archived'

export type ScanSource = 'roomplan' | 'object_capture_area' | 'manual'

/** Lane 3 V1.6: discriminates HW-owned vs Customer-owned (Self-Scan) captures.
 *  - craftsman: existing HW-captured scan, anchored to a job/project/presales (default).
 *  - customer:  Customer Self-Scan (Block 4), may be jobless initially, later attachable. */
export type ScanOwnerType = 'craftsman' | 'customer'

export type ScanAssetKind =
  | 'usdz'
  | 'gltf'
  | 'scan_json'
  | 'mesh_summary'
  | 'thumbnail'
  | 'floorplan_svg'
  | 'worldmap'

export type ScanSurfaceKind = 'wall' | 'door' | 'window' | 'opening' | 'object'

export type ScanMeasurementStatus =
  | 'estimated_roomplan'
  | 'estimated_depth'
  | 'depth_checked'
  | 'provider_review_required'
  | 'provider_verified'
  | 'rejected'
  | 'superseded'

export type ScanMeasurementSource =
  | 'roomplan'
  | 'depth_checked'
  | 'manual'
  | 'laser_bt'

export type ScanAnnotationKind =
  | 'damage'
  | 'note'
  | 'photo'
  | 'measurement_ref'
  | 'gewerk_marker'

/**
 * Lane 3 V1.6 Phase 1d (2026-05-26): Customer-UX pin classification by
 * structural element. Orthogonal to `ScanAnnotationKind` (which is HW-RBAC
 * facing) — a pin can have BOTH `kind='damage'` AND `customerPinType='door'`
 * when the customer marks a door as the damaged element.
 *
 * Persisted in `scan_annotations.customer_pin_type` (DB CHECK enforces the
 * four values, migration `20260526120000_spatial_v16_customer_pin_type.sql`).
 *
 * Phase 2 (LiDAR): RoomPlan auto-detects door/window walls and writes the
 * matching `customerPinType` on auto-generated pins. heating/electrical stay
 * customer-manual.
 */
export type CustomerPinType = 'door' | 'window' | 'heating' | 'electrical'

/**
 * Lane 3 V1.6 Block 3: per-kind customer-visibility default for new pins.
 *
 * - `note` + `gewerk_marker` default to PRIVATE (internal HW info)
 * - `damage` + `photo` + `measurement_ref` default to PUBLIC (customer-facing)
 *
 * Matches the DB-side backfill in
 * `20260525120000_spatial_lane_3_block_3_pin_visibility.sql`. The HW can always
 * override per pin via the editor toggle or the per-row eye-icon.
 */
export function defaultCustomerVisibleForKind(kind: ScanAnnotationKind): boolean {
  switch (kind) {
    case 'note':
    case 'gewerk_marker':
      return false
    case 'damage':
    case 'photo':
    case 'measurement_ref':
      return true
  }
}

export type ScanAnnotationStatus =
  | 'open'
  | 'needs_photo'
  | 'needs_measurement'
  | 'offer_relevant'
  | 'included_in_offer'
  | 'resolved'
  | 'dispute_relevant'

export type ScanQualityBucket = 'poor' | 'fair' | 'good' | 'excellent'

export type ScanAnchorConfidence = 'high' | 'medium' | 'low' | 'lost'

export type ScanEventAction =
  | 'captured'
  | 'quality_run'
  | 'measurement_edited'
  | 'annotation_added'
  | 'annotation_resolved'
  | 'verified'
  | 'rejected'
  | 'rescan_requested'
  | 'rescan_linked'
  | 'locked'
  | 'unlocked'
  | 'archived'
  | 'asset_converted'
  | 'drift_detected'

/** Quality Engine V1 warning codes — pure-function output, never free text. */
export type ScanQualityWarning =
  | 'too_few_walls'
  | 'area_implausible'
  | 'ceiling_implausible'
  | 'wall_coverage_low'
  | 'low_confidence'
  | 'door_dimensions_unusual'
  | 'window_dimensions_unusual'

// ── D2 Anchor Layers ─────────────────────────────────────────────────────────

/** D2 Layer 1 — UV-on-Surface (Source of Truth, survives format + re-scan). */
export interface AnchorUv {
  surfaceExternalId: string
  /** [u, v] both in [0, 1]; clamps applied client-side. */
  uv: [number, number]
}

/** D2 Layer 2 — Per-format World-XYZ cache (render perf + drift detector). */
export interface AnchorWorldCache {
  /** Cached XYZ in the USDZ coordinate space (Apple-native). */
  usdz?: { x: number; y: number; z: number }
  /** Cached XYZ in the glTF coordinate space (web). */
  gltf?: { x: number; y: number; z: number }
  /** ISO-8601 timestamp of last cache write. */
  computedAt: string
}

/** D2 Layer 3 — AR-Anchor hint (iOS only, via ARWorldMap). */
export interface AnchorArHint {
  arAnchorUuid: string
  /** Storage ref to the persisted ARWorldMap blob, when available. */
  worldMapRef?: string
}

/** D2 Layer 4 — 2D-Floorplan fallback (free-floating / pre-3D phase). */
export interface Anchor2d {
  svgX: number
  svgY: number
}

/** Geometry transform (4x4 matrix or {position, rotation, scale} blob).
 *  Stored as opaque jsonb in `scan_surfaces.transform`. */
export type ScanTransform = Record<string, unknown>

/** Floor-plane anchor blob (centerpoint + normal + scale). */
export type FloorAnchor = Record<string, unknown>

// ── Entity Interfaces (8 tables) ─────────────────────────────────────────────

/** scans · header per capture session, versioned via parentScanId. */
export interface Scan {
  id: string
  /** uuid — at least one of jobId / projectId / presalesProjectId is set (DB CHECK). */
  jobId: string | null
  projectId: string | null
  /** uuid — provider-presales-project anchor (V1.5). */
  presalesProjectId: string | null
  parentScanId: string | null
  status: ScanStatus
  source: ScanSource
  /** profiles.id of the user who captured the scan. */
  capturedBy: string
  /** Device + sensor info for forensics + quality scoring. */
  deviceMeta: ScanDeviceMeta
  scanStartedAt: number | null
  scanEndedAt: number | null
  archivedAt: number | null
  /** Lane 3 V1.6: HW-owned vs Customer-Self-Scan discriminator. */
  ownerType: ScanOwnerType
  /** Lane 3 V1.6: HW-toggled sharing gate. true = job customer can view this scan.
   *  Only meaningful when jobId IS NOT NULL (DB CHECK scans_sharing_requires_job_chk). */
  sharedWithCustomer: boolean
  /** Lane 3 V1.6: timestamp of last share action (trigger-managed, null when unshared). */
  sharedAt: number | null
  /** V1.5.1 Phase B: Customer→HW direct share target (auth.users.id). NULL when not
   *  direct-shared. Only legal when ownerType='customer' (DB CHECK
   *  scans_shared_with_provider_kind_chk). */
  sharedWithProviderId: string | null
  /** V1.5.1 Phase B: timestamp of last direct-share action (trigger-managed). */
  sharedWithProviderAt: number | null
  /** V1.6 Phase 2 (F1): 0-100 Customer-facing quality score. NULL when not
   *  computed (Manual-Preset captures, pre-Phase-2 rows). Persisted via
   *  repo.updateScanQuality after createCustomerLidarScene completes. */
  qualityScore: number | null
  /** V1.6 Phase 2 (F1): three-tier label derived from qualityScore. NULL when
   *  qualityScore IS NULL. DB CHECK ('high'|'medium'|'low'). */
  qualityLabel: 'high' | 'medium' | 'low' | null
  createdAt: number
  updatedAt: number
}

/** Subset of device facts we capture from the plugin. Free-form jsonb on the DB
 *  side; extend without migration. */
export interface ScanDeviceMeta {
  deviceModel?: string
  osVersion?: string
  appVersion?: string
  hasLidar?: boolean
  arkitVersion?: string
  /** Captured frame-rate sample (optional, for Quality-Engine input). */
  fpsSample?: number
  /** Thermal-state at end of scan: nominal | fair | serious | critical. */
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical'
  [k: string]: unknown
}

/** scan_assets · files attached to a scan (D1: USDZ + glTF + …). */
export interface ScanAsset {
  id: string
  scanId: string
  kind: ScanAssetKind
  storagePath: string
  bytes: number | null
  sha256: string | null
  /** scan_assets.id of source row when this asset was derived (D1: glTF → USDZ). */
  convertedFrom: string | null
  createdAt: number
}

/** scan_rooms · rooms within a scan (V1: typically 1). */
export interface ScanRoom {
  id: string
  scanId: string
  name: string | null
  areaM2Estimated: number | null
  areaM2Verified: number | null
  ceilingHEstimated: number | null
  ceilingHVerified: number | null
  floorAnchor: FloorAnchor | null
  createdAt: number
  updatedAt: number
}

/** scan_surfaces · walls / doors / windows / openings / objects. */
export interface ScanSurface {
  id: string
  roomId: string
  /** D2 Layer 1: plugin-vergebene stabile ID. UNIQUE per room. */
  surfaceExternalId: string
  kind: ScanSurfaceKind
  dimWEstimated: number | null
  dimHEstimated: number | null
  dimWVerified: number | null
  dimHVerified: number | null
  transform: ScanTransform | null
  status: ScanMeasurementStatus
  /** 0..1 from mesh classification. */
  confidence: number | null
  createdAt: number
  updatedAt: number
}

/** scan_measurements · atomic measurements with FSM estimated → verified. */
export interface ScanMeasurement {
  id: string
  scanId: string
  surfaceId: string | null
  label: string | null
  valueEstimatedM: number | null
  valueVerifiedM: number | null
  /** V1 only 'm' (DB CHECK). */
  unit: 'm'
  status: ScanMeasurementStatus
  source: ScanMeasurementSource
  verifiedBy: string | null
  verifiedAt: number | null
  createdAt: number
  updatedAt: number
}

/** scan_annotations · pins with D2 Hybrid Anchor + Drift-Detection. */
export interface ScanAnnotation {
  id: string
  scanId: string
  kind: ScanAnnotationKind
  /** D2 Layer 1 (SoT). At least one of anchorUv / anchor2d is set (DB CHECK). */
  anchorUv: AnchorUv | null
  /** D2 Layer 2 — per-format World-XYZ cache. */
  anchorWorldCache: AnchorWorldCache | null
  /** D2 Layer 3 — iOS-only AR-Hint. */
  anchorArHint: AnchorArHint | null
  /** D2 Layer 4 — 2D-Floorplan fallback. */
  anchor2d: Anchor2d | null
  /** Drift-Detection state — last UV-vs-cache compare. */
  lastDriftCheckAt: number | null
  /** Distance in meters of last drift sample. */
  lastDriftDistanceM: number | null
  confidence: ScanAnchorConfidence
  /** media_uploads.id (text FK — media_uploads.id is legacy text). */
  photoAssetId: string | null
  note: string | null
  status: ScanAnnotationStatus
  /** Free-text gewerk tag (e.g. 'sanitär', 'elektro'); enum-freeze deferred. */
  gewerk: string | null
  offerRelevant: boolean
  /** V2: link to offers.line_items[].id. FK NOT enforced yet. */
  offerLineItemId: string | null
  /** Lane 3 V1.6 Block 3: HW-toggled visibility per pin. true = customer
   *  sees this pin in shared scans. Default per kind (note + gewerk_marker
   *  → false, rest → true). HW + workers + operators always see every pin. */
  customerVisible: boolean
  /** Lane 3 V1.6 Phase 1d: Customer structural classification (door / window /
   *  heating / electrical). `null` = no customer typification (HW-only pin or
   *  not classified). Orthogonal to `kind` — both can be set on a single
   *  annotation. Persisted in `scan_annotations.customer_pin_type` with a
   *  CHECK constraint. */
  customerPinType: CustomerPinType | null
  createdAt: number
  updatedAt: number
}

/** scan_quality_reports · pure-function Quality Engine V1 output. */
export interface ScanQualityReport {
  id: string
  scanId: string
  /** 0..100. */
  score: number
  bucket: ScanQualityBucket
  /** Always enum-validated (ScanQualityWarning[]). */
  warnings: ScanQualityWarning[]
  engineVersion: string
  generatedAt: number
}

/** scan_events · append-only audit. Writes only via SECURITY DEFINER RPCs. */
export interface ScanEvent {
  id: string
  scanId: string
  /** profiles.id of actor; null when system-driven. */
  actorId: string | null
  action: ScanEventAction
  /** Action-specific payload (free-form jsonb). */
  payload: Record<string, unknown>
  at: number
}

// ── Repository DTOs (Create / Update Inputs) ─────────────────────────────────

/** Input for repo.createScan — captured_by must be auth.uid() (RLS). */
export interface CreateScanInput {
  jobId?: string | null
  projectId?: string | null
  /** Provider-presales-project anchor (V1.5). */
  presalesProjectId?: string | null
  parentScanId?: string | null
  source: ScanSource
  capturedBy: string
  deviceMeta?: ScanDeviceMeta
  scanStartedAt?: number | null
  /** Lane 3 V1.6: defaults to 'craftsman' for HW-flows. Set to 'customer' for
   *  Customer-Self-Scan (Block 4) — allows jobless scans via relaxed CHECK. */
  ownerType?: ScanOwnerType
}

export interface UpdateScanInput {
  status?: ScanStatus
  scanEndedAt?: number | null
  archivedAt?: number | null
  /** capturedBy is intentionally NOT updatable from app code — RLS blocks
   *  non-operator changes via WITH CHECK (immutable column). */
}

/**
 * Lane 3 V1.6 · Phase 2 · Customer-LiDAR-Scene Quality Persist
 *
 * Separate DTO mirroring the `updateScanSharing` pattern (Block-2 PR #940)
 * rather than overloading `UpdateScanInput`. Persists the three-tier Customer
 * quality label + the underlying 0-100 score on the `scans` row (F1 migration
 * columns `quality_score smallint` + `quality_label text`, both `NULL`-able).
 *
 * Score range [0, 100] and label enum (`high`|`medium`|`low`) enforced by DB
 * CHECKs; the repo trusts the caller (workflow-level Customer-Quality compute).
 */
export interface UpdateScanQualityInput {
  scanId: string
  score: number
  label: 'high' | 'medium' | 'low'
}

/**
 * Lane 3 V1.6 · Phase 2 · Customer-LiDAR Mesh-Snapshot Upload
 *
 * Uploads the captured USDZ blob to the dedicated `spatial-mesh-snapshots`
 * bucket (F2 migration, private, 5MB cap, MIME `model/vnd.usdz+zip`). Path
 * convention `{userId}/{scanId}.usdz` is enforced by storage RLS INSERT
 * policy (`foldername[1] = auth.uid()::text`).
 *
 * Distinct from `uploadScanAsset` (project-scans bucket, HW pipeline,
 * content-addressed dedup) — Customer scans land in a separate bucket with
 * owner-scoped RLS so the Customer-side viewer can stream the mesh without
 * pulling the full HW asset graph.
 */
export interface UploadMeshSnapshotInput {
  scanId: string
  /** Owner of the scan — embedded in the storage path. Must equal auth.uid() for RLS. */
  userId: string
  /** Captured USDZ blob (≤ 5 MB per F2 bucket cap). */
  blob: Blob
}

export interface CreateScanAssetInput {
  scanId: string
  kind: ScanAssetKind
  storagePath: string
  bytes?: number | null
  sha256?: string | null
  convertedFrom?: string | null
}

export interface CreateScanRoomInput {
  scanId: string
  name?: string | null
  areaM2Estimated?: number | null
  ceilingHEstimated?: number | null
  floorAnchor?: FloorAnchor | null
}

export interface UpdateScanRoomInput {
  name?: string | null
  areaM2Verified?: number | null
  ceilingHVerified?: number | null
}

export interface CreateScanSurfaceInput {
  roomId: string
  surfaceExternalId: string
  kind: ScanSurfaceKind
  dimWEstimated?: number | null
  dimHEstimated?: number | null
  transform?: ScanTransform | null
  confidence?: number | null
}

export interface UpdateScanSurfaceInput {
  dimWVerified?: number | null
  dimHVerified?: number | null
  status?: ScanMeasurementStatus
  confidence?: number | null
}

export interface CreateScanMeasurementInput {
  scanId: string
  surfaceId?: string | null
  label?: string | null
  valueEstimatedM?: number | null
  source?: ScanMeasurementSource
}

/** Update to set verified value — repo enforces all 3 fields atomically
 *  (matches DB CHECK scan_measurements_verified_consistency_chk). */
export interface VerifyScanMeasurementInput {
  valueVerifiedM: number
  verifiedBy: string
  /** Defaults to Date.now() in the repo. */
  verifiedAt?: number
}

export interface CreateScanAnnotationInput {
  scanId: string
  kind: ScanAnnotationKind
  /** At least one of anchorUv / anchor2d required. */
  anchorUv?: AnchorUv | null
  anchorWorldCache?: AnchorWorldCache | null
  anchorArHint?: AnchorArHint | null
  anchor2d?: Anchor2d | null
  photoAssetId?: string | null
  note?: string | null
  gewerk?: string | null
  /** Lane 3 V1.6 Block 3: HW-controlled customer visibility. Omit to use the
   *  kind default (see `defaultCustomerVisibleForKind`). */
  customerVisible?: boolean
  /** Lane 3 V1.6 Phase 1d: Customer sets structural element type at create
   *  time. Omit / null for HW-only pins with no customer typification. */
  customerPinType?: CustomerPinType | null
}

export interface UpdateScanAnnotationInput {
  status?: ScanAnnotationStatus
  note?: string | null
  photoAssetId?: string | null
  gewerk?: string | null
  offerRelevant?: boolean
  /** Lane 3 V1.6 Block 3: HW toggles whether the customer can see this pin. */
  customerVisible?: boolean
  /** Lane 3 V1.6 Phase 1d: re-type or clear a customer pin classification.
   *  Phase 1 RLS routes this through the standard scan_annotations_update
   *  policy — customer Self-Scan-owners + the scan's HW. */
  customerPinType?: CustomerPinType | null
  /** Drift-Detection writes — repo enforces UV-as-SoT discipline (Layer 1
   *  never overwritten by code paths that update cache only). */
  anchorWorldCache?: AnchorWorldCache | null
  lastDriftCheckAt?: number | null
  lastDriftDistanceM?: number | null
  confidence?: ScanAnchorConfidence
}

export interface CreateScanQualityReportInput {
  scanId: string
  score: number
  bucket: ScanQualityBucket
  warnings: ScanQualityWarning[]
  engineVersion: string
}

// ── Read-side composite views (denormalized convenience reads) ───────────────

/** Convenience aggregate for screens that show a scan + its assets + a room.
 *  Built in the repository, not a DB view (so it stays mock-swappable). */
export interface ScanDetailView {
  scan: Scan
  assets: ScanAsset[]
  rooms: ScanRoom[]
  /** Latest quality report (most-recent generatedAt). */
  latestQualityReport: ScanQualityReport | null
}

/** Convenience aggregate for the dispute / review surface. */
export interface ScanReviewView {
  scan: Scan
  rooms: ScanRoom[]
  surfaces: ScanSurface[]
  measurements: ScanMeasurement[]
  annotations: ScanAnnotation[]
  qualityReports: ScanQualityReport[]
}

// ── Branded helpers (lightweight runtime guards) ─────────────────────────────

/** Display helper: estimated vs verified resolution per D5 Source-of-Truth. */
export interface MeasurementDisplay {
  /** Authoritative value if verified, otherwise the estimated value. */
  valueM: number | null
  /** True when valueM comes from a verified write (clean display). False or
   *  null when displaying estimated_* (UI shows `~` / `ca.` badge). */
  isVerified: boolean
  /** Raw originals for audit / tooltip surfaces. */
  estimatedM: number | null
  verifiedM: number | null
  verifiedBy: string | null
  verifiedAt: number | null
}

/** Display helper for anchor confidence — drives UI badges + CTA copy. */
export interface AnchorDisplay {
  confidence: ScanAnchorConfidence
  /** True when D2 drift-detection flagged the anchor as suspect. */
  needsReview: boolean
  /** Last drift distance in mm (for tooltip). */
  driftMm: number | null
}
