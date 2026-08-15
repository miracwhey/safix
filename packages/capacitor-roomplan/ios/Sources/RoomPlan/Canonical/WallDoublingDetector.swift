// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Risk R12: RoomPlan often splits a single thick wall into two parallel
// thin walls. The TS bridge collapses these pairs PRE host-matching (audit-
// finding H28) so doors attach to the surviving wall, not the dropped one.
// This module is the Swift port of `findOverlappingWalls` from
// `src/lib/spatial/canonical/geometry/door-portal.ts`.
//
// Heuristic (matches the TS defaults · Master-Spec §14.3 wall-doubling):
//
//   - Normals anti-parallel (≈ π apart) OR parallel (≈ 0 apart) within
//     `angleToleranceRad` (default 5°). H10 audit-fix: parallel-case
//     covers RoomPlan emitters that haven't flipped the second-surface
//     normal direction yet.
//   - Perpendicular distance between centerlines ≤ `maxPerpDistanceM`
//     (default 0.30 m).
//   - Length-overlap ratio ≥ `minOverlapRatio` (default 0.80).
//
// Returns each detected pair as `(surviveId, dropId)` where the survivor
// is the first-of-pair in input order — matches the TS bridge's "drop the
// second-of-pair" convention so downstream id-stability holds.
//

import Foundation

public struct WallDoublingPair: Equatable {
    public let surviveId: String
    public let dropId: String
    /// Perpendicular distance between centerlines (XZ projection).
    public let perpDistanceM: Double
    /// Length-overlap ratio in [0, 1].
    public let lengthOverlapRatio: Double
    /// Angle between outward normals in radians (≈ π means anti-parallel).
    public let normalAngleRad: Double

    public init(
        surviveId: String,
        dropId: String,
        perpDistanceM: Double,
        lengthOverlapRatio: Double,
        normalAngleRad: Double
    ) {
        self.surviveId = surviveId
        self.dropId = dropId
        self.perpDistanceM = perpDistanceM
        self.lengthOverlapRatio = lengthOverlapRatio
        self.normalAngleRad = normalAngleRad
    }
}

public struct WallDoublingOptions {
    public var angleToleranceRad: Double
    public var maxPerpDistanceM: Double
    public var minOverlapRatio: Double
    public init(
        angleToleranceRad: Double = .pi / 36, // 5°
        maxPerpDistanceM: Double = 0.30,
        minOverlapRatio: Double = 0.80
    ) {
        self.angleToleranceRad = angleToleranceRad
        self.maxPerpDistanceM = maxPerpDistanceM
        self.minOverlapRatio = minOverlapRatio
    }
}

public enum WallDoublingDetector {

    /// Detect pairs of walls that look like a single thicker wall RoomPlan
    /// split into two parallel thin walls.
    ///
    /// Each pair is reported once with `surviveId` = the first-of-pair in
    /// input order (so collapse is deterministic across runs of the same
    /// `CapturedRoom`).
    public static func detect(
        walls: [HostWallCandidate],
        options: WallDoublingOptions = WallDoublingOptions()
    ) -> [WallDoublingPair] {
        var pairs: [WallDoublingPair] = []
        guard walls.count >= 2 else { return pairs }

        for i in 0..<walls.count {
            for j in (i + 1)..<walls.count {
                let a = walls[i]
                let b = walls[j]

                let nA = WallGeometry.normal(a.geometry)
                let nB = WallGeometry.normal(b.geometry)
                let dot = nA.x * nB.x + nA.z * nB.z
                let clamped = max(-1.0, min(1.0, dot))
                let angle = acos(clamped)

                let isAntiParallel = abs(angle - .pi) < options.angleToleranceRad
                let isParallel = abs(angle) < options.angleToleranceRad
                guard isAntiParallel || isParallel else { continue }

                // Perpendicular distance: project B's start onto A's plane.
                let (_, signed) = WallGeometry.projectOntoPlane(
                    a.geometry,
                    point: b.geometry.startPoint
                )
                let perp = abs(signed)
                guard perp <= options.maxPerpDistanceM else { continue }

                let lenA = WallGeometry.length(a.geometry)
                guard lenA > WallGeometry.epsilon else { continue }
                let t0 = WallGeometry.offsetAlong(a.geometry, point: b.geometry.startPoint)
                let t1 = WallGeometry.offsetAlong(a.geometry, point: b.geometry.endPoint)
                let lo = max(0.0, min(t0, t1))
                let hi = min(lenA, max(t0, t1))
                let overlap = max(0.0, hi - lo)
                let ratio = overlap / lenA
                guard ratio >= options.minOverlapRatio else { continue }

                pairs.append(
                    WallDoublingPair(
                        surviveId: a.id,
                        dropId: b.id,
                        perpDistanceM: perp,
                        lengthOverlapRatio: ratio,
                        normalAngleRad: angle
                    )
                )
            }
        }
        return pairs
    }
}
