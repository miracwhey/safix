// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Swift port of `findHostWall` from
// `src/lib/spatial/canonical/geometry/door-portal.ts`.
//
// RoomPlan emits doors / windows / openings as free-floating surfaces — it
// does NOT supply `host_wall_id`. The bridge / converter has to derive it
// by projecting the door centroid onto every wall plane and picking the
// closest match (Risk R11 mitigation).
//
// Audit bake-ins (binding · matches Day 9 plan):
//
//   - H17 · ambiguity-detection: when a second candidate sits within
//     `options.ambiguityToleranceM` of the winner's perpendicular distance,
//     drop confidence below 1.0 (we emit 0.5) and append a
//     `DOOR_HOST_WALL_AMBIGUOUS` warning.
//   - H8 · widened default tolerance: `CanonicalConverterOptions
//     .ambiguityToleranceM` defaults to 0.10 m (vs the TS-side 0.05 m)
//     because RoomPlan centroids are noisier than the synthetic test inputs
//     the TS matcher was originally tuned against.
//
// Pure value-types. Foundation only · no RoomPlan dependency, so this module
// is unit-testable without a real `CapturedRoom`.
//

import Foundation

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

/// Lightweight 3D vector (Right-Handed Y-Up, meters). Mirrors the canonical
/// TS `Vector3`.
public struct CanonicalVector3: Equatable {
    public var x: Double
    public var y: Double
    public var z: Double
    public init(x: Double, y: Double, z: Double) {
        self.x = x; self.y = y; self.z = z
    }
    public static let zero = CanonicalVector3(x: 0, y: 0, z: 0)
}

/// Wall-geometry inputs the matcher needs. Matches the TS
/// `WallGeometryInput` shape minus the parametric fields we don't use here.
public struct CanonicalWallGeometry: Equatable {
    public var startPoint: CanonicalVector3
    public var endPoint: CanonicalVector3
    public var thicknessM: Double
    public var baseHeightM: Double
    public var heightM: Double
    public init(
        startPoint: CanonicalVector3,
        endPoint: CanonicalVector3,
        thicknessM: Double,
        baseHeightM: Double = 0,
        heightM: Double = 2.5
    ) {
        self.startPoint = startPoint
        self.endPoint = endPoint
        self.thicknessM = thicknessM
        self.baseHeightM = baseHeightM
        self.heightM = heightM
    }
}

/// Wall candidate paired with its canonical id (typically the RoomPlan
/// `identifier.uuidString`).
public struct HostWallCandidate: Equatable {
    public var id: String
    public var geometry: CanonicalWallGeometry
    public init(id: String, geometry: CanonicalWallGeometry) {
        self.id = id
        self.geometry = geometry
    }
}

/// Outcome of the host-wall matcher. `winner` is `nil` only when no
/// candidate fell within `maxDistanceM`.
public struct HostWallMatchResult: Equatable {
    public var winner: HostWallCandidate?
    /// 1.0 = unique winner · 0.5 = ambiguous (second candidate within
    /// tolerance · H17) · 0.0 = no candidate found.
    public var confidence: Double
    public var warnings: [String]
}

/// Configurable thresholds for the host-wall matcher. Defaults mirror the
/// TS bridge with one exception: `ambiguityToleranceM` defaults to 0.10 m
/// here (audit-finding H8) — see `CanonicalConverterOptions`.
public struct HostWallMatchOptions {
    public var maxDistanceM: Double
    public var ambiguityToleranceM: Double
    public var alongToleranceM: Double
    public init(
        maxDistanceM: Double = 0.5,
        ambiguityToleranceM: Double = 0.10,
        alongToleranceM: Double = 0.10
    ) {
        self.maxDistanceM = maxDistanceM
        self.ambiguityToleranceM = ambiguityToleranceM
        self.alongToleranceM = alongToleranceM
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall-geometry helpers (Swift port of `geometry/wall-geometry.ts`)
//
// Kept fileprivate-ish (internal) so the matcher + doubling-detector + the
// converter can share the same primitives without leaking helper types to
// public API.
// ─────────────────────────────────────────────────────────────────────────────

/// Shared pure-geometry helpers used by both `HostWallMatcher` and
/// `WallDoublingDetector`. Bumped to `public` so the same-target sibling
/// file resolves the symbol cleanly under SourceKit (the visibility itself
/// is `module`-equivalent — Swift's `internal` should suffice, but explicit
/// `public` avoids one class of false-positive SourceKit "Cannot find"
/// reports that surface before the first full Xcode build runs).
public enum WallGeometry {
    public static let epsilon = 1e-9

    public static func length(_ wall: CanonicalWallGeometry) -> Double {
        let dx = wall.endPoint.x - wall.startPoint.x
        let dy = wall.endPoint.y - wall.startPoint.y
        let dz = wall.endPoint.z - wall.startPoint.z
        return (dx * dx + dy * dy + dz * dz).squareRoot()
    }

    /// 2D outward-facing unit normal on the XZ plane. Right-hand rule: when
    /// walking start→end, the outward face is on the right.
    static func normal(_ wall: CanonicalWallGeometry) -> CanonicalVector3 {
        let dx = wall.endPoint.x - wall.startPoint.x
        let dz = wall.endPoint.z - wall.startPoint.z
        let len = (dx * dx + dz * dz).squareRoot()
        if len < epsilon { return .zero }
        return CanonicalVector3(x: dz / len, y: 0, z: -dx / len)
    }

    /// Project a point onto the wall plane; return signed perpendicular
    /// distance (positive on the outer side).
    static func projectOntoPlane(
        _ wall: CanonicalWallGeometry,
        point: CanonicalVector3
    ) -> (projected: CanonicalVector3, signedDistance: Double) {
        let n = normal(wall)
        if n.x == 0 && n.y == 0 && n.z == 0 {
            return (point, 0)
        }
        let dx = point.x - wall.startPoint.x
        let dy = point.y - wall.startPoint.y
        let dz = point.z - wall.startPoint.z
        let d = dx * n.x + dy * n.y + dz * n.z
        return (
            CanonicalVector3(
                x: point.x - n.x * d,
                y: point.y - n.y * d,
                z: point.z - n.z * d
            ),
            d
        )
    }

    /// How far along the wall centerline a point projects to.
    static func offsetAlong(
        _ wall: CanonicalWallGeometry,
        point: CanonicalVector3
    ) -> Double {
        let len = length(wall)
        if len < epsilon { return 0 }
        let dirX = (wall.endPoint.x - wall.startPoint.x) / len
        let dirY = (wall.endPoint.y - wall.startPoint.y) / len
        let dirZ = (wall.endPoint.z - wall.startPoint.z) / len
        return (point.x - wall.startPoint.x) * dirX
             + (point.y - wall.startPoint.y) * dirY
             + (point.z - wall.startPoint.z) * dirZ
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Host-wall matcher
// ─────────────────────────────────────────────────────────────────────────────

public enum HostWallMatcher {

    /// Match a free-floating door / window / opening centroid to the wall
    /// it lives on.
    ///
    /// Algorithm (mirrors TS `findHostWall`):
    ///   1. For every wall: project the centroid onto the wall plane, record
    ///      `(perpDistance, alongDistance)`.
    ///   2. Sort by ascending perpendicular distance.
    ///   3. Filter to candidates whose along-wall distance lies within
    ///      `[-alongTolerance, length + alongTolerance]` AND whose
    ///      perpendicular distance is below `maxDistance`.
    ///   4. If the next candidate sits within `ambiguityTolerance` of the
    ///      winner, set `confidence = 0.5` and emit `DOOR_HOST_WALL_AMBIGUOUS`
    ///      (audit-finding H17).
    public static func findHostWall(
        doorCentroid: CanonicalVector3,
        walls: [HostWallCandidate],
        options: HostWallMatchOptions = HostWallMatchOptions()
    ) -> HostWallMatchResult {
        struct Scored {
            let candidate: HostWallCandidate
            let perpDistance: Double
            let alongDistance: Double
        }

        let scored: [Scored] = walls.map { c in
            let (_, signed) = WallGeometry.projectOntoPlane(c.geometry, point: doorCentroid)
            let along = WallGeometry.offsetAlong(c.geometry, point: doorCentroid)
            return Scored(candidate: c, perpDistance: abs(signed), alongDistance: along)
        }
        .sorted { $0.perpDistance < $1.perpDistance }

        let eligible = scored.filter { entry in
            let len = WallGeometry.length(entry.candidate.geometry)
            return entry.alongDistance >= -options.alongToleranceM
                && entry.alongDistance <= len + options.alongToleranceM
        }

        guard let winner = eligible.first, winner.perpDistance <= options.maxDistanceM else {
            return HostWallMatchResult(
                winner: nil,
                confidence: 0,
                warnings: ["DOOR_HOST_WALL_NOT_FOUND: no wall within tolerance"]
            )
        }

        var confidence = 1.0
        var warnings: [String] = []

        if eligible.count > 1,
           eligible[1].perpDistance - winner.perpDistance <= options.ambiguityToleranceM {
            confidence = 0.5
            warnings.append(
                "DOOR_HOST_WALL_AMBIGUOUS: walls \(winner.candidate.id) and "
                + "\(eligible[1].candidate.id) are within "
                + String(format: "%.3f", options.ambiguityToleranceM)
                + " m of the door centroid"
            )
        }

        return HostWallMatchResult(
            winner: winner.candidate,
            confidence: confidence,
            warnings: warnings
        )
    }
}
