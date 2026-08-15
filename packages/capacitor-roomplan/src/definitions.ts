export interface WallInfo {
  widthM: number
  heightM: number
}

export interface OpeningInfo {
  widthM: number
  heightM: number
}

/**
 * Device + sensor facts emitted by the Swift plugin (Block B.1). Mirrors
 * `ScanDeviceMeta` in `src/lib/spatial/types.ts`. All fields are optional so
 * the host app can degrade gracefully if a future plugin version stops
 * emitting one of them.
 */
export interface ScanDeviceMeta {
  deviceModel?: string
  osVersion?: string
  appVersion?: string
  hasLidar?: boolean
  arkitVersion?: string
  fpsSample?: number
  thermalState?: 'nominal' | 'fair' | 'serious' | 'critical'
  durationSec?: number
}

/**
 * Phase 2: aggregated mesh-classification snapshot harvested in parallel to
 * RoomPlan by polling `RoomCaptureSession.arSession`. Apple's ARMeshAnchor +
 * classification API lights up on iOS 17+ LiDAR devices; missing on older
 * OS / non-LiDAR / when the feature flag `SPATIAL_HYBRID_MESH_ENABLED` is
 * off — in any of those cases the field is `undefined`.
 *
 * Persisted as `mesh_summary.json` in `project-scans/{userId}/{scanId}/`
 * and consumed by the Quality Engine R6 (wall_coverage) + R7 (mesh-preference)
 * rules; the SQL RPC reads the same JSON shape so TS + SQL stay parity-byte-
 * identical (see migration `20260519000000_quality_engine_mesh_summary.sql`).
 *
 * The Swift emitter is `MeshClassificationHarvester.Summary.toJSON()` in
 * `packages/capacitor-roomplan/ios/Sources/RoomPlan/MeshClassificationHarvester.swift`.
 */
export interface MeshClassification {
  /** Live ARMeshAnchor count contributing to the last snapshot. */
  anchorCount: number
  /** Sum of `geometry.faces.count` across all anchors in the snapshot. */
  totalFaces: number
  /**
   * Per-class face counts. Keys mirror Apple's `ARMeshClassification`
   * enum names. Missing keys default to 0 on the consumer side.
   */
  classFaces: {
    none: number
    wall: number
    floor: number
    ceiling: number
    table: number
    seat: number
    window: number
    door: number
  }
  /** `wallFaces / totalFaces`, clamped to `[0, 1]`. 0 when `totalFaces == 0`. */
  wallCoverageRatio: number
  /**
   * `true` when polling was paused at thermal `.critical`. Quality Engine
   * treats this as "ignore R6 + R7 weights" so a hot device isn't penalised.
   * Once flipped to `true` it stays true for the rest of the scan even if
   * the device cools — the gap during pause isn't retroactively fillable.
   */
  degraded: boolean
  /** Thermal state at the moment of snapshot (scan-finish time). */
  thermalStateAtSnapshot: 'nominal' | 'fair' | 'serious' | 'critical'
  /** Polling cycles that contributed to the latest aggregate. */
  samplesCollected: number
  /**
   * Worst-tick count of anchors that exposed mesh geometry but no
   * classification buffer. Surfaces an Apple/RoomPlan config gap so
   * Quality Engine can tell "we ran R6/R7 and got zero walls" apart from
   * "the mesh wasn't classified at all". 0 on healthy LiDAR scans.
   */
  anchorsWithoutClassification: number
  /**
   * Seconds from harvester `start()` to `snapshot()`. Emitted as Double
   * (rounded to 3 decimals) so sub-second scans don't truncate to 0.
   */
  durationSec: number
  /**
   * `samplesCollected / durationSec`. Honest about throttle effect:
   * drops from ≈10 → ≈2 under thermal `.serious`, 0 when paused.
   */
  avgPollHz: number
}

export interface RoomScanResult {
  usdzPath: string
  capturedAt: string
  floorAreaM2: number
  ceilingHeightM: number
  walls: WallInfo[]
  doors: OpeningInfo[]
  windows: OpeningInfo[]
  furnitureCount: number
  furnitureCategories: string[]
  /**
   * Block B.1 — device + sensor telemetry captured at scan start and
   * refreshed at scan end (fpsSample + thermalState + durationSec). Lands in
   * `scans.device_meta` jsonb via `captureScan()`.
   */
  deviceMeta?: ScanDeviceMeta
  /**
   * Phase 2 — aggregated mesh classification from the 3-Layer Hybrid
   * harvester. `undefined` on non-LiDAR / iOS<17 / feature-flag-off /
   * harvester observed zero frames. When present, captureScan() uploads
   * the dict as `mesh_summary.json` to storage and the Quality Engine
   * activates R6 (wall_coverage) + R7 (mesh-preference) on real data.
   */
  meshClassification?: MeshClassification
}

/**
 * Phase 1 + 2: native-side telemetry events forwarded as `roomScanTelemetry`
 * listener notifications. The web layer wires these into Sentry breadcrumbs
 * + console.log for capture-flow forensics. `event` is the stable key
 * (scan_started, walls_changed, finish_revealed, finish_tapped,
 * should_present, did_present, export_failed, dismiss_reason,
 * finish_force_revealed, processing_timeout, instruction_changed,
 * mesh_harvester_started, mesh_harvester_snapshot, mesh_memory_warning).
 * Extra keys are event-specific scalars (Int/Double/Bool/String).
 */
export interface RoomScanTelemetryEvent {
  event: string
  timestamp: number
  [key: string]: string | number | boolean | undefined
}

/**
 * Phase 1: stable error codes thrown from `startScan()`. Web layer branches
 * on these to pick toast severity:
 *  - SCAN_CANCELLED → silent state reset (user pressed Abbrechen)
 *  - SCAN_BACKGROUNDED → soft info toast ("Scan unterbrochen — App war im Hintergrund")
 *  - SCAN_PROCESSING_TIMEOUT → error toast + Sentry capture (Apple processing hung)
 *  - SCAN_INSUFFICIENT_DATA → warn toast ("Zu wenig Raumdaten — bitte erneut")
 *  - ROOMPLAN_V2_UNAVAILABLE → pre-checked via checkAvailability; should never throw here
 *  - SCAN_FAILED → generic fallback (unexpected error)
 */
export type RoomScanErrorCode =
  | 'SCAN_CANCELLED'
  | 'SCAN_BACKGROUNDED'
  | 'SCAN_PROCESSING_TIMEOUT'
  | 'SCAN_INSUFFICIENT_DATA'
  | 'SCAN_FAILED'
  | 'ROOMPLAN_V2_UNAVAILABLE'
  | 'NO_VIEW_CONTROLLER'
  | 'CAMERA_PERMISSION_DENIED'

/**
 * Day 9: arguments for {@link RoomPlanPlugin.getCanonicalScene}. The native
 * converter needs `scanId` to embed in the canonical document's metadata
 * (it does NOT re-derive ids client-side); `jobId` and `projectId` are
 * optional contextual identifiers stored in `metadata`.
 */
export interface GetCanonicalSceneArgs {
  scanId: string
  jobId?: string
  projectId?: string
}

/**
 * Day 9: return shape for {@link RoomPlanPlugin.getCanonicalScene}. The
 * canonical RoomScene wire-format is shaped opaquely here (a JSON-document
 * dict) so this types package doesn't pull in the canonical TS definitions.
 * Callers cast to the L1 `RoomScene` type at the boundary.
 */
export interface GetCanonicalSceneResult {
  document: Record<string, unknown>
}

/**
 * Day 9: error codes thrown from {@link RoomPlanPlugin.getCanonicalScene}.
 *   - CANONICAL_CONVERT_NO_SCAN — no cached `CapturedRoom` (startScan not yet completed).
 *   - CANONICAL_CONVERT_FAILED  — converter threw or required args missing.
 *   - ROOMPLAN_V2_UNAVAILABLE         — iOS < 17 (RoomPlan-typed inputs require iOS 17).
 *     This code is shared with startScan and is semantically "RoomPlan V2 not available"
 *     (covers both missing LiDAR hardware and iOS < 17). Renamed from the former
 *     `LIDAR_UNAVAILABLE` under OQ-12 (resolved).
 */
export type GetCanonicalSceneErrorCode =
  | 'CANONICAL_CONVERT_NO_SCAN'
  | 'CANONICAL_CONVERT_FAILED'
  | 'ROOMPLAN_V2_UNAVAILABLE'

export interface RoomPlanPlugin {
  checkAvailability(): Promise<{ available: boolean }>
  startScan(): Promise<RoomScanResult>
  /**
   * Day 9: invoke the iOS-native CanonicalConverter against the most-recent
   * `CapturedRoom` (cached by `startScan`). Returns the canonical
   * `parametric.json` wire-format as `{ document: ... }`. Available only
   * on iOS 17+; rejects with `CANONICAL_CONVERT_NO_SCAN` if no scan is
   * cached and `ROOMPLAN_V2_UNAVAILABLE` on older OS or non-iOS platforms.
   *
   * Lets the iOS layer skip the round-trip through Block-A persistence +
   * the TS bridge for fresh scans — useful for live-preview surfaces that
   * render canonical immediately after capture.
   */
  getCanonicalScene(args: GetCanonicalSceneArgs): Promise<GetCanonicalSceneResult>
  /**
   * Phase 1: subscribe to native scan lifecycle events. Returned PluginListenerHandle
   * is typed loosely (`unknown`) because Capacitor's strict typing of the handle
   * differs by core version. Call `.remove()` on the returned handle to unsubscribe.
   */
  addListener(
    eventName: 'roomScanTelemetry',
    listenerFunc: (event: RoomScanTelemetryEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
  removeAllListeners(): Promise<void>
}
