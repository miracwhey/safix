// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Swift mirror of the TS bridge
// (`src/lib/spatial/canonical/bridge/scanToParametric.ts`). Takes a
// `RoomPlan.CapturedRoom` and produces a `[String: Any]` JSON dictionary
// matching the canonical `parametric.json` wire shape
// (`src/lib/spatial/canonical/schema/parametric-json-schema.ts`).
//
// Why a Swift converter when we already have the TS bridge?
//
//   The TS bridge consumes Block-A's `scan_surfaces / scan_annotations`
//   tables — those are persisted by the JS layer after a finished RoomPlan
//   capture. For fresh on-device scans the iOS layer can skip the round-trip
//   through Block-A entirely by writing parametric.json directly. This
//   matters for offline-first scanning and reduces TTFM (time-to-first-mesh)
//   in the Reveal screen.
//
// Audit / feedback bake-ins (binding):
//
//   - H17: ambiguity-detection inside `HostWallMatcher` populates
//     `host_wall_confidence` per opening (1.0 / 0.5 / 0.0).
//   - H28: wall-doubling collapse runs PRE host-matching so the surviving
//     wall hosts the opening.
//   - `feedback_swift_ios17_stored_property_anyobject`: all RoomPlan-typed
//     APIs are guarded with `@available(iOS 17.0, *)` — the plugin's
//     `lastCapturedRoom` is stored as `AnyObject?` and cast at call-time.
//   - All JSON keys go through `CanonicalKey.*` so a typo turns into a
//     compile error rather than a schema-drift bug.
//   - ISO-8601 timestamps via `ISO8601DateFormatter`. RoomPlan exposes
//     `Date` values; we convert at the boundary.
//   - Right-Handed Y-Up. RoomPlan ships RH-Y-up natively for surface
//     transforms (matches our canonical convention). No sign-flip needed.
//
// Pure Foundation + RoomPlan + simd · no third-party deps.
//

import Foundation
import RoomPlan
import simd

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

public enum CanonicalConverterError: Error, CustomStringConvertible {
    case unsupportedOSVersion
    case malformedScan(String)

    public var description: String {
        switch self {
        case .unsupportedOSVersion:
            return "CanonicalConverter requires iOS 17.0 or newer"
        case .malformedScan(let reason):
            return "CanonicalConverter: malformed scan input — \(reason)"
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────────

public struct CanonicalConverter {

    public let options: CanonicalConverterOptions

    public init(options: CanonicalConverterOptions = .default) {
        self.options = options
    }

    /// Convert a finished `CapturedRoom` into a canonical `parametric.json`
    /// document. The returned dictionary is JSON-serialisable
    /// (`JSONSerialization.isValidJSONObject(_:)` returns `true`).
    ///
    /// `scanId` becomes `metadata.source_scan_id` and seeds wall/floor/ceiling
    /// ids when RoomPlan does not supply identifiers. `jobId` / `projectId`
    /// flow into `project.fixup_*_id`.
    @available(iOS 17.0, *)
    public func convert(
        capturedRoom: CapturedRoom,
        scanId: String,
        jobId: String? = nil,
        projectId: String? = nil
    ) throws -> [String: Any] {
        var warnings: [String] = []
        let nowIso = Self.isoNow()

        // ── 1) Build wall geometries + canonical ids ──────────────────────
        let wallSurfaces = capturedRoom.walls
        var wallCandidates: [HostWallCandidate] = wallSurfaces.map { surface in
            HostWallCandidate(
                id: RoomPlanMapping.externalId(forSurface: surface),
                geometry: RoomPlanMapping.wallGeometry(
                    from: surface,
                    defaultThicknessM: options.defaultWallThicknessM
                )
            )
        }

        // ── 2) Wall-doubling detection / collapse (PRE host-matching · H28)
        var collapsedToSurvivor: [String: String] = [:]
        if !wallCandidates.isEmpty {
            let pairs = WallDoublingDetector.detect(walls: wallCandidates)
            if !pairs.isEmpty {
                if options.collapseWallDoublings {
                    for p in pairs {
                        collapsedToSurvivor[p.dropId] = p.surviveId
                        warnings.append(
                            "WALL_DOUBLING_COLLAPSED: wall \(p.dropId) merged into "
                            + "\(p.surviveId) (perp="
                            + String(format: "%.3f", p.perpDistanceM)
                            + " m, overlap="
                            + String(format: "%.2f", p.lengthOverlapRatio)
                            + ")"
                        )
                    }
                    let droppedIds = Set(pairs.map { $0.dropId })
                    wallCandidates.removeAll { droppedIds.contains($0.id) }
                } else {
                    for p in pairs {
                        warnings.append(
                            "WALL_DOUBLING_DETECTED: walls \(p.surviveId) and "
                            + "\(p.dropId) look like a single thicker wall (perp="
                            + String(format: "%.3f", p.perpDistanceM)
                            + " m, overlap="
                            + String(format: "%.2f", p.lengthOverlapRatio)
                            + ")"
                        )
                    }
                }
            }
        }

        // ── 3) Build wall JSON dicts ──────────────────────────────────────
        let surfaceById: [String: CapturedRoom.Surface] = Dictionary(
            uniqueKeysWithValues: wallSurfaces.map {
                (RoomPlanMapping.externalId(forSurface: $0), $0)
            }
        )
        var wallDicts: [[String: Any]] = []
        wallDicts.reserveCapacity(wallCandidates.count)
        for w in wallCandidates {
            let surface = surfaceById[w.id]
            // V1.5 Hotfix E4 (T-03): emit world-space polygon_override for
            // non-rectangular walls (>4 corners). nil for rectangular walls
            // keeps the blob small.
            let polygonOverride = surface.flatMap { RoomPlanMapping.wallPolygonOverride(from: $0) }
            wallDicts.append(
                Self.buildWallDict(
                    id: w.id,
                    geometry: w.geometry,
                    confidence: surface.map { ConfidenceMapper.toDouble($0.confidence) } ?? 0.6,
                    polygonOverride: polygonOverride,
                    nowIso: nowIso
                )
            )
        }

        // ── 4) Floor + ceiling ────────────────────────────────────────────
        // V1.5 Hotfix E3 (T-07): prefer Apple's beautified floors[0].polygonCorners
        // over the wall-ring inference — correctly handles L/U/T/bay-window rooms
        // where wall start-points do not form a closed ring. The `.source` tag
        // (apple_capturedroom_floors / fallback_wall_ring) is reserved for Lane-2
        // debug-metadata wiring; ignored here intentionally.
        let (floorPolygon, _) = Self.extractFloorPolygon(
            from: capturedRoom,
            wallCandidates: wallCandidates
        )
        let ceilingHeightM = Self.maxWallHeight(from: wallCandidates)
        let roomId = "room_\(scanId)"
        let floorId = "floor_\(scanId)"
        let ceilingId = "ceiling_\(scanId)"

        let floorDict = Self.buildFloorDict(
            id: floorId,
            polygon: floorPolygon,
            nowIso: nowIso
        )
        let ceilingDict = Self.buildCeilingDict(
            id: ceilingId,
            polygon: floorPolygon,
            heightM: ceilingHeightM,
            nowIso: nowIso
        )

        // ── 5) Openings (doors + windows + openings) ──────────────────────
        let doorSurfaces = capturedRoom.doors
        let windowSurfaces = capturedRoom.windows
        let openingSurfaces = capturedRoom.openings

        var openingsByWall: [String: [[String: Any]]] = [:]
        var allOpeningDicts: [[String: Any]] = []

        func appendOpening(
            _ surface: CapturedRoom.Surface,
            typeKey: String,
            isWalkablePortal: Bool
        ) {
            let centroid = RoomPlanMapping.openingCentroid(from: surface)
            let dims = RoomPlanMapping.dimensionsM(from: surface)
            let matchOptions = HostWallMatchOptions(
                maxDistanceM: 0.5,
                ambiguityToleranceM: options.ambiguityToleranceM,
                alongToleranceM: 0.10
            )
            let match = HostWallMatcher.findHostWall(
                doorCentroid: centroid,
                walls: wallCandidates,
                options: matchOptions
            )
            if match.winner == nil {
                warnings.append(
                    "OPENING_HOST_NOT_FOUND: \(surface.identifier.uuidString) "
                    + "(\(typeKey)) — no wall within tolerance"
                )
            }
            if !match.warnings.isEmpty {
                for w in match.warnings {
                    warnings.append("\(surface.identifier.uuidString) (\(typeKey)): \(w)")
                }
            }
            let hostId = match.winner?.id ?? ""
            let offsetAlong = Self.offsetAlongHostWall(
                host: match.winner,
                centroid: centroid,
                openingWidthM: dims.width
            )
            let offsetFromFloor = max(0.0, centroid.y - dims.height / 2)
            let dict = Self.buildOpeningDict(
                id: RoomPlanMapping.externalId(forSurface: surface),
                typeKey: typeKey,
                hostWallId: hostId,
                offsetAlongM: offsetAlong,
                offsetFromFloorM: typeKey == "window" ? offsetFromFloor : 0,
                widthM: dims.width,
                heightM: dims.height,
                isWalkablePortal: isWalkablePortal,
                hostWallConfidence: match.confidence,
                sillHeightM: typeKey == "window" ? offsetFromFloor : nil,
                confidence: ConfidenceMapper.toDouble(surface.confidence),
                nowIso: nowIso
            )
            allOpeningDicts.append(dict)
            if !hostId.isEmpty {
                openingsByWall[hostId, default: []].append(dict)
            }
        }

        for s in doorSurfaces    { appendOpening(s, typeKey: "door",    isWalkablePortal: true) }
        for s in windowSurfaces  { appendOpening(s, typeKey: "window",  isWalkablePortal: false) }
        for s in openingSurfaces { appendOpening(s, typeKey: "opening", isWalkablePortal: true) }

        // Attach openings to their hosting wall dict (mutates the wallDicts
        // array via index-rebind because dict-by-value semantics).
        for i in 0..<wallDicts.count {
            if let id = wallDicts[i][CanonicalKey.id] as? String,
               let hosted = openingsByWall[id] {
                wallDicts[i][CanonicalKey.openings] = hosted
            } else {
                wallDicts[i][CanonicalKey.openings] = [] as [[String: Any]]
            }
        }

        // ── 6) Objects · H27 audit-fix host detection ─────────────────────
        var freeObjectDicts: [[String: Any]] = []
        var ceilingMountedDicts: [[String: Any]] = []
        var floorMountedDicts: [[String: Any]] = []
        var wallMountedByWall: [String: [[String: Any]]] = [:]

        for obj in capturedRoom.objects {
            let pos = RoomPlanMapping.position(from: obj.transform)
            let widthM = Double(obj.dimensions.x)
            let heightM = Double(obj.dimensions.y)
            let depthM = Double(obj.dimensions.z)
            let categoryStr = RoomPlanMapping.categoryString(obj.category)
            let confidence = ConfidenceMapper.toDouble(obj.confidence)
            let id = RoomPlanMapping.externalId(forObject: obj)

            let detected = Self.detectObjectHost(
                position: pos,
                wallCandidates: wallCandidates,
                floorId: floorId,
                ceilingId: ceilingId,
                ceilingHeightM: ceilingHeightM,
                wallFlushToleranceM: 0.15
            )
            if detected.host == "free" {
                warnings.append(
                    "OBJECT_HOST_FREE: \(id) could not be attached to floor/"
                    + "wall/ceiling — emitting as free-standing"
                )
            }

            let dict = Self.buildObjectDict(
                id: id,
                category: categoryStr,
                width: widthM, depth: depthM, height: heightM,
                position: pos,
                host: detected.host,
                hostId: detected.hostId,
                heightFromFloorM: detected.host == "wall" ? max(0.0, pos.y - heightM / 2) : nil,
                rotationAroundYDeg: detected.host == "floor" ? Self.rotationAroundY(obj.transform) : nil,
                confidence: confidence,
                nowIso: nowIso
            )
            switch detected.host {
            case "wall":
                wallMountedByWall[detected.hostId, default: []].append(dict)
            case "ceiling":
                ceilingMountedDicts.append(dict)
            case "floor":
                floorMountedDicts.append(dict)
            default:
                freeObjectDicts.append(dict)
            }
        }

        // Attach wall-mounted objects to their host walls.
        for i in 0..<wallDicts.count {
            if let id = wallDicts[i][CanonicalKey.id] as? String,
               let hosted = wallMountedByWall[id] {
                wallDicts[i][CanonicalKey.wallMounted] = hosted
            } else {
                wallDicts[i][CanonicalKey.wallMounted] = [] as [[String: Any]]
            }
        }
        var floorWithMounted = floorDict
        floorWithMounted[CanonicalKey.floorMounted] = floorMountedDicts
        var ceilingWithMounted = ceilingDict
        ceilingWithMounted[CanonicalKey.ceilingMounted] = ceilingMountedDicts

        // ── 7) Bounds + area + volume ─────────────────────────────────────
        let bounds = Self.computeRoomBounds(
            walls: wallCandidates,
            ceilingHeightM: ceilingHeightM
        )
        let areaM2 = Self.polygonAreaM2(floorPolygon)
        let volumeM3 = areaM2 * ceilingHeightM

        // ── 8) Compose RoomScene (scene_graph) ────────────────────────────
        let sceneGraph: [String: Any] = [
            CanonicalKey.id: roomId,
            CanonicalKey.typeKey: "room",
            CanonicalKey.parentId: "building_\(scanId)",
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: Self.identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: 1.0,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.category: "other",
            CanonicalKey.walls: wallDicts,
            CanonicalKey.floor: floorWithMounted,
            CanonicalKey.ceiling: ceilingWithMounted,
            CanonicalKey.freeObjects: freeObjectDicts,
            CanonicalKey.pins: [] as [[String: Any]],
            CanonicalKey.photos: [] as [[String: Any]],
            CanonicalKey.notes: [] as [[String: Any]],
            CanonicalKey.boundsMin: Self.vector3Dict(bounds.min),
            CanonicalKey.boundsMax: Self.vector3Dict(bounds.max),
            CanonicalKey.computedAreaM2: areaM2,
            CanonicalKey.computedVolumeM3: volumeM3,
        ]

        // ── 9) Project envelope ───────────────────────────────────────────
        let buildingId = "building_\(scanId)"
        let projectDict: [String: Any] = [
            CanonicalKey.id: "project_\(scanId)",
            CanonicalKey.typeKey: "project",
            CanonicalKey.parentId: NSNull(),
            CanonicalKey.childrenIds: [buildingId],
            CanonicalKey.transform: Self.identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: 1.0,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.fixupProjectId: projectId as Any? ?? NSNull(),
            CanonicalKey.fixupJobId: jobId as Any? ?? NSNull(),
            CanonicalKey.defaultUnit: "meters",
            CanonicalKey.coordinateSystem: "right-handed-y-up",
            CanonicalKey.variantIds: ["base_roomplan"],
            CanonicalKey.buildings: [[
                CanonicalKey.id: buildingId,
                CanonicalKey.typeKey: "building",
                CanonicalKey.parentId: "project_\(scanId)",
                CanonicalKey.childrenIds: [roomId],
                CanonicalKey.transform: Self.identityTransformDict(),
                CanonicalKey.sourceKey: "roomplan",
                CanonicalKey.confidence: 1.0,
                CanonicalKey.variantId: "base_roomplan",
                CanonicalKey.createdAt: nowIso,
                CanonicalKey.updatedAt: nowIso,
                CanonicalKey.rooms: [sceneGraph],
                CanonicalKey.connectivityGraphRef: "cg_\(buildingId)",
            ] as [String: Any]],
        ]

        // Build the surface-external-id → node-id map used by downstream
        // consumers (annotation resolver, override re-pointer) so writes
        // anchored to a wall collapsed by the doubling detector can be
        // redirected to the survivor instead of failing silently. Includes
        // every wallSurface emitted by RoomPlan, not only the survivors.
        var surfaceExternalIdToNodeId: [String: String] = [:]
        for surface in wallSurfaces {
            let extId = RoomPlanMapping.externalId(forSurface: surface)
            surfaceExternalIdToNodeId[extId] = collapsedToSurvivor[extId] ?? extId
        }

        // ── 10) Top-level document ────────────────────────────────────────
        let metadata: [String: Any] = [
            CanonicalKey.metaSourceScanId: scanId,
            CanonicalKey.metaWarnings: warnings,
            CanonicalKey.metaIosNative: true,
            CanonicalKey.metaSurfaceExternalIdToNodeId: surfaceExternalIdToNodeId,
        ]
        let connectivityGraph: [String: Any] = [
            CanonicalKey.id: "cg_\(buildingId)",
            CanonicalKey.cgNodes: [[
                CanonicalKey.id: "n_\(roomId)",
                CanonicalKey.cgRoomId: roomId,
            ] as [String: Any]],
            CanonicalKey.cgEdges: [] as [[String: Any]],
        ]

        let document: [String: Any] = [
            CanonicalKey.schemaVersion: "1.0",
            CanonicalKey.generatedAt: nowIso,
            CanonicalKey.source: "roomplan_ios17",
            CanonicalKey.coordinateSystem: "right-handed-y-up",
            CanonicalKey.unit: "meters",
            CanonicalKey.project: projectDict,
            CanonicalKey.sceneGraph: sceneGraph,
            CanonicalKey.walkableAreas: [] as [[String: Any]],
            CanonicalKey.collisionVolumes: [] as [[String: Any]],
            CanonicalKey.connectivityGraph: connectivityGraph,
            CanonicalKey.validationReport: [:] as [String: Any],
            CanonicalKey.variants: [[
                CanonicalKey.id: "base_roomplan",
                CanonicalKey.displayName: "Scan",
                CanonicalKey.isDefault: true,
            ] as [String: Any]],
            CanonicalKey.overrides: [] as [[String: Any]],
            CanonicalKey.metadata: metadata,
        ]
        return document
    }

    // ─────────────────────────────────────────────────────────────────────
    // Dict builders
    // ─────────────────────────────────────────────────────────────────────

    private static func buildWallDict(
        id: String,
        geometry: CanonicalWallGeometry,
        confidence: Double,
        polygonOverride: [CanonicalVector3]?,
        nowIso: String
    ) -> [String: Any] {
        let lengthM = WallGeometry.length(geometry)
        let n = WallGeometry.normal(geometry)
        var dict: [String: Any] = [
            CanonicalKey.id: id,
            // RoomPlan has no human label; emit the surface external id so
            // node.name has the same shape as the TS bridge (`s.surfaceExternalId`).
            CanonicalKey.name: id,
            CanonicalKey.typeKey: "wall",
            CanonicalKey.parentId: "room",
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: confidence,
            CanonicalKey.roomplanUuid: id,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.startPoint: vector3Dict(geometry.startPoint),
            CanonicalKey.endPoint: vector3Dict(geometry.endPoint),
            CanonicalKey.heightM: geometry.heightM,
            CanonicalKey.thicknessM: geometry.thicknessM,
            CanonicalKey.baseHeightM: geometry.baseHeightM,
            CanonicalKey.openings: [] as [[String: Any]],
            CanonicalKey.wallMounted: [] as [[String: Any]],
            CanonicalKey.isExteriorWall: false,
            CanonicalKey.walkableBlocker: true,
            CanonicalKey.lengthM: lengthM,
            CanonicalKey.normal: vector3Dict(n),
        ]
        // V1.5 Hotfix E4: emit polygon_override when RoomPlan reports a
        // non-rectangular wall. TS-side renderer (geometry.ts:58) already
        // accepts this field; nil-case is the rectangular default and reuses
        // start/end/thickness for geometry as before.
        if let polygonOverride = polygonOverride {
            dict[CanonicalKey.polygonOverride] = polygonOverride.map { vector3Dict($0) }
        }
        return dict
    }

    private static func buildFloorDict(
        id: String,
        polygon: [CanonicalVector3],
        nowIso: String
    ) -> [String: Any] {
        return [
            CanonicalKey.id: id,
            CanonicalKey.name: id,
            CanonicalKey.typeKey: "floor",
            CanonicalKey.parentId: "room",
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: 1.0,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.polygon: polygon.map { vector3Dict($0) },
            CanonicalKey.walkableSurface: true,
            CanonicalKey.floorMounted: [] as [[String: Any]],
        ]
    }

    private static func buildCeilingDict(
        id: String,
        polygon: [CanonicalVector3],
        heightM: Double,
        nowIso: String
    ) -> [String: Any] {
        let lifted = polygon.map { CanonicalVector3(x: $0.x, y: heightM, z: $0.z) }
        return [
            CanonicalKey.id: id,
            CanonicalKey.name: id,
            CanonicalKey.typeKey: "ceiling",
            CanonicalKey.parentId: "room",
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: 1.0,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.polygon: lifted.map { vector3Dict($0) },
            CanonicalKey.heightM: heightM,
            CanonicalKey.ceilingMounted: [] as [[String: Any]],
        ]
    }

    private static func buildOpeningDict(
        id: String,
        typeKey: String,
        hostWallId: String,
        offsetAlongM: Double,
        offsetFromFloorM: Double,
        widthM: Double,
        heightM: Double,
        isWalkablePortal: Bool,
        hostWallConfidence: Double,
        sillHeightM: Double?,
        confidence: Double,
        nowIso: String
    ) -> [String: Any] {
        var dict: [String: Any] = [
            CanonicalKey.id: id,
            CanonicalKey.name: id,
            CanonicalKey.typeKey: typeKey,
            CanonicalKey.parentId: hostWallId.isEmpty ? "room" : hostWallId,
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: identityTransformDict(),
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: confidence,
            CanonicalKey.roomplanUuid: id,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.hostWallId: hostWallId,
            CanonicalKey.offsetAlongWallM: offsetAlongM,
            CanonicalKey.offsetFromFloorM: offsetFromFloorM,
            CanonicalKey.widthM: widthM,
            CanonicalKey.heightM: heightM,
            CanonicalKey.isWalkablePortal: isWalkablePortal,
            CanonicalKey.hostWallConfidence: hostWallConfidence,
        ]
        if let sill = sillHeightM {
            dict[CanonicalKey.sillHeightM] = sill
        }
        return dict
    }

    private static func buildObjectDict(
        id: String,
        category: String,
        width: Double, depth: Double, height: Double,
        position: CanonicalVector3,
        host: String,
        hostId: String,
        heightFromFloorM: Double?,
        rotationAroundYDeg: Double?,
        confidence: Double,
        nowIso: String
    ) -> [String: Any] {
        var dict: [String: Any] = [
            CanonicalKey.id: id,
            CanonicalKey.name: id,
            CanonicalKey.typeKey: "object",
            CanonicalKey.parentId: hostId.isEmpty ? "room" : hostId,
            CanonicalKey.childrenIds: [] as [String],
            CanonicalKey.transform: [
                CanonicalKey.position: vector3Dict(position),
                CanonicalKey.rotation: identityQuaternionDict(),
                CanonicalKey.scale: oneVectorDict(),
            ] as [String: Any],
            CanonicalKey.sourceKey: "roomplan",
            CanonicalKey.confidence: confidence,
            CanonicalKey.roomplanUuid: id,
            CanonicalKey.variantId: "base_roomplan",
            CanonicalKey.createdAt: nowIso,
            CanonicalKey.updatedAt: nowIso,
            CanonicalKey.category: category,
            CanonicalKey.dimensions: [
                CanonicalKey.widthM: width,
                CanonicalKey.depthM: depth,
                CanonicalKey.heightM: height,
            ] as [String: Any],
            CanonicalKey.host: host,
            CanonicalKey.hostId: hostId,
        ]
        if let h = heightFromFloorM { dict[CanonicalKey.heightFromFloorM] = h }
        if let r = rotationAroundYDeg { dict[CanonicalKey.rotationAroundYDeg] = r }
        return dict
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    private static func vector3Dict(_ v: CanonicalVector3) -> [String: Double] {
        return [
            CanonicalKey.xKey: v.x,
            CanonicalKey.yKey: v.y,
            CanonicalKey.zKey: v.z,
        ]
    }

    private static func identityQuaternionDict() -> [String: Double] {
        return [
            CanonicalKey.xKey: 0,
            CanonicalKey.yKey: 0,
            CanonicalKey.zKey: 0,
            CanonicalKey.wKey: 1,
        ]
    }

    private static func oneVectorDict() -> [String: Double] {
        return [
            CanonicalKey.xKey: 1,
            CanonicalKey.yKey: 1,
            CanonicalKey.zKey: 1,
        ]
    }

    private static func identityTransformDict() -> [String: Any] {
        return [
            CanonicalKey.position: vector3Dict(.zero),
            CanonicalKey.rotation: identityQuaternionDict(),
            CanonicalKey.scale: oneVectorDict(),
        ]
    }

    private static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static func inferFloorPolygon(
        from walls: [HostWallCandidate]
    ) -> [CanonicalVector3] {
        guard !walls.isEmpty else { return [] }
        var ring = walls.map {
            CanonicalVector3(x: $0.geometry.startPoint.x, y: 0, z: $0.geometry.startPoint.z)
        }
        if signedShoelaceArea(ring) < 0 {
            ring.reverse()
        }
        return ring
    }

    // ─────────────────────────────────────────────────────────────────────
    // V1.5 Hotfix E3 + E4 · iOS 17 polygon helpers
    //
    // Both helpers are `internal static` so the test target can verify the
    // pure transform math without instantiating CapturedRoom (which the
    // macOS SDK does not ship — see existing CanonicalConverterTests).
    // ─────────────────────────────────────────────────────────────────────

    /// Transforms local-plane polygon corners (as returned by
    /// `Surface.polygonCorners` / `Floor.polygonCorners`) into world-space
    /// `CanonicalVector3`s via the surface's `transform` matrix.
    ///
    /// `simd_mul(transform, float4(x,y,z,1))` is the standard Apple-recommended
    /// way to lift local coordinates into world space (RoomPlan transform is
    /// RH-Y-up; matches our canonical convention so no sign-flip).
    ///
    /// NOT gated with `@available(iOS 17.0, *)` even though the only producer
    /// (RoomPlan polygonCorners) is iOS 17+ — the math here is pure simd and
    /// the macOS test target needs to call this directly.
    static func worldPolygonFromCorners(
        corners: [simd_float3],
        transform: simd_float4x4
    ) -> [CanonicalVector3] {
        return corners.map { local in
            let v = simd_float4(local.x, local.y, local.z, 1.0)
            let w = simd_mul(transform, v)
            return CanonicalVector3(x: Double(w.x), y: Double(w.y), z: Double(w.z))
        }
    }

    /// V1.5 Hotfix E3: prefer Apple's beautified `floors[0].polygonCorners`
    /// over our wall-ring inference. The Apple polygon correctly handles
    /// L-/U-/T-/bay-window rooms where wall start-points do not form a
    /// closed ring — `inferFloorPolygon` bricht silently in those cases.
    ///
    /// Fallback path is the unchanged `inferFloorPolygon` for the unlikely
    /// case Apple ships an empty floors array (older iOS-17 builds before
    /// beautify ran reliably, or capture aborted before floor-detection).
    @available(iOS 17.0, *)
    static func extractFloorPolygon(
        from capturedRoom: CapturedRoom,
        wallCandidates: [HostWallCandidate]
    ) -> (polygon: [CanonicalVector3], source: String) {
        if let floor = capturedRoom.floors.first, floor.polygonCorners.count >= 3 {
            let world = worldPolygonFromCorners(
                corners: floor.polygonCorners,
                transform: floor.transform
            )
            // Normalise to Y=0 (floor plane) — Apple's floor.transform.y can
            // drift a few mm from 0 due to capture-coordinate-frame noise,
            // and our renderer expects the floor at exactly y=0.
            let flattened = world.map {
                CanonicalVector3(x: $0.x, y: 0, z: $0.z)
            }
            return (flattened, "apple_capturedroom_floors")
        }
        return (inferFloorPolygon(from: wallCandidates), "fallback_wall_ring")
    }

    private static func signedShoelaceArea(_ polygon: [CanonicalVector3]) -> Double {
        guard polygon.count >= 3 else { return 0 }
        var a = 0.0
        for i in 0..<polygon.count {
            let p = polygon[i]
            let q = polygon[(i + 1) % polygon.count]
            a += p.x * q.z - q.x * p.z
        }
        return a / 2
    }

    private static func polygonAreaM2(_ polygon: [CanonicalVector3]) -> Double {
        return abs(signedShoelaceArea(polygon))
    }

    private static func maxWallHeight(from walls: [HostWallCandidate]) -> Double {
        let h = walls.map { $0.geometry.heightM }.max() ?? 2.5
        return h > 0 ? h : 2.5
    }

    private static func computeRoomBounds(
        walls: [HostWallCandidate],
        ceilingHeightM: Double
    ) -> (min: CanonicalVector3, max: CanonicalVector3) {
        if walls.isEmpty {
            return (.zero, .zero)
        }
        var minX = Double.infinity, minZ = Double.infinity
        var maxX = -Double.infinity, maxZ = -Double.infinity
        for w in walls {
            minX = min(minX, w.geometry.startPoint.x, w.geometry.endPoint.x)
            minZ = min(minZ, w.geometry.startPoint.z, w.geometry.endPoint.z)
            maxX = max(maxX, w.geometry.startPoint.x, w.geometry.endPoint.x)
            maxZ = max(maxZ, w.geometry.startPoint.z, w.geometry.endPoint.z)
        }
        return (
            CanonicalVector3(x: minX, y: 0, z: minZ),
            CanonicalVector3(x: maxX, y: ceilingHeightM, z: maxZ)
        )
    }

    private static func offsetAlongHostWall(
        host: HostWallCandidate?,
        centroid: CanonicalVector3,
        openingWidthM: Double
    ) -> Double {
        guard let host = host else { return 0 }
        let start = host.geometry.startPoint
        let end = host.geometry.endPoint
        let dx = end.x - start.x
        let dz = end.z - start.z
        let len = (dx * dx + dz * dz).squareRoot()
        if len < 1e-6 { return 0 }
        let along = ((centroid.x - start.x) * dx + (centroid.z - start.z) * dz) / len
        return max(0, along - openingWidthM / 2)
    }

    /// Object host detection · mirror of `detectObjectHost` in the TS bridge
    /// (H27 audit-fix: never hardcode `floor`).
    private static func detectObjectHost(
        position: CanonicalVector3,
        wallCandidates: [HostWallCandidate],
        floorId: String,
        ceilingId: String,
        ceilingHeightM: Double,
        wallFlushToleranceM: Double
    ) -> (host: String, hostId: String) {
        let planeTolerance = 0.05

        // (a) Close to ceiling plane?
        if abs(position.y - ceilingHeightM) <= planeTolerance {
            return ("ceiling", ceilingId)
        }

        // (c) Flush with a wall plane? Check BEFORE floor classification so
        //     wall-mounted radiators at y ≈ 0.7 m don't get bucketed as floor.
        let match = HostWallMatcher.findHostWall(
            doorCentroid: position,
            walls: wallCandidates,
            options: HostWallMatchOptions(
                maxDistanceM: wallFlushToleranceM,
                ambiguityToleranceM: 0.05,
                alongToleranceM: 0.10
            )
        )
        if let winner = match.winner {
            return ("wall", winner.id)
        }

        // (b) Close to floor plane?
        if abs(position.y) <= planeTolerance {
            return ("floor", floorId)
        }

        // (d) Free-standing.
        return ("free", "")
    }

    /// Pull rotation-around-Y (in degrees) from a `simd_float4x4`. Reads the
    /// local-X axis projected onto the XZ plane and returns the angle.
    private static func rotationAroundY(_ transform: simd_float4x4) -> Double {
        let lx = transform.columns.0
        let radians = atan2(Double(-lx.z), Double(lx.x))
        let degrees = radians * 180.0 / .pi
        // Normalize to [0, 360)
        let mod = degrees.truncatingRemainder(dividingBy: 360.0)
        return mod < 0 ? mod + 360.0 : mod
    }
}
