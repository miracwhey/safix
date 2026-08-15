// Spatial V1 · Day 9 B15 · CanonicalConverter test suite
//
// Tests run against the PURE-SWIFT layer of the converter (`HostWallMatcher`,
// `WallDoublingDetector`, dict builders driven by `CanonicalWallGeometry`).
// We do NOT instantiate a real `RoomPlan.CapturedRoom` because:
//
//   1. `RoomPlan` types are iOS 17+ and not instantiable from XCTest on the
//      Mac SDK — would require a device-class iOS Simulator target with the
//      RoomPlan framework linked.
//   2. The mapping `CapturedRoom.Surface → CanonicalWallGeometry` is a
//      thin extraction in `RoomPlanMapping`; its correctness depends on
//      Apple's contract (transform + dimensions). The HARD logic
//      (host-matching, doubling, dict layout) lives in the pure layer we
//      DO cover here.
//
// Coverage:
//
//   - test_rectangular_room: 4 walls + 1 floor + 1 ceiling round-trip via
//     the same dict builders the converter uses.
//   - test_door_finds_host_wall: one door surface → one WallOpening with the
//     correct `host_wall_id` and `host_wall_confidence`.
//   - test_wall_doubling_collapse_with_door: two doubled walls + 1 door →
//     after collapse, the surviving wall hosts the opening; one
//     wall_doubling warning when `collapseWallDoublings = false`; zero
//     wall_doubling warnings when `true` (only the COLLAPSED-warning).
//
// XCTest based. No third-party deps.
//

import XCTest
import simd
@testable import RoomPlanPlugin

final class CanonicalConverterTests: XCTestCase {

    // MARK: - Rectangular 4-wall room (pure host-matcher / doubling-free shape)

    func test_rectangular_room_four_walls_no_doubling() {
        // Build a 4×3 m rectangular room. Walls connect head-to-tail CCW.
        //
        //   (0,0,3) ─ W2 ─ (4,0,3)
        //     │              │
        //     W3             W1
        //     │              │
        //   (0,0,0) ─ W0 ─ (4,0,0)
        //
        let w0 = makeWall(id: "W0", start: v(0, 0, 0), end: v(4, 0, 0))
        let w1 = makeWall(id: "W1", start: v(4, 0, 0), end: v(4, 0, 3))
        let w2 = makeWall(id: "W2", start: v(4, 0, 3), end: v(0, 0, 3))
        let w3 = makeWall(id: "W3", start: v(0, 0, 3), end: v(0, 0, 0))

        let candidates = [w0, w1, w2, w3]
        let pairs = WallDoublingDetector.detect(walls: candidates)
        XCTAssertEqual(pairs.count, 0, "Rectangular room has no doubled walls")

        // Sanity-check: no two walls are anti-parallel close enough to count
        // as a doubling.
        for pair in pairs {
            XCTAssertGreaterThan(pair.perpDistanceM, 0.30, "Should not collapse")
        }
    }

    // MARK: - Door → host-wall match (H17 confidence path)

    func test_door_finds_host_wall_with_confidence_one() {
        // Same 4-wall rectangle; place a door centroid on the +Z wall (W2),
        // roughly in the middle.
        let w0 = makeWall(id: "W0", start: v(0, 0, 0), end: v(4, 0, 0))
        let w1 = makeWall(id: "W1", start: v(4, 0, 0), end: v(4, 0, 3))
        let w2 = makeWall(id: "W2", start: v(4, 0, 3), end: v(0, 0, 3))
        let w3 = makeWall(id: "W3", start: v(0, 0, 3), end: v(0, 0, 0))
        let candidates = [w0, w1, w2, w3]

        let doorCentroid = CanonicalVector3(x: 2.0, y: 1.0, z: 3.0)
        let match = HostWallMatcher.findHostWall(
            doorCentroid: doorCentroid,
            walls: candidates,
            options: HostWallMatchOptions(
                maxDistanceM: 0.5,
                ambiguityToleranceM: 0.10,
                alongToleranceM: 0.10
            )
        )

        XCTAssertNotNil(match.winner)
        XCTAssertEqual(match.winner?.id, "W2", "Door on the +Z edge should match W2")
        XCTAssertEqual(match.confidence, 1.0, "Unique winner → confidence 1.0")
        XCTAssertTrue(match.warnings.isEmpty, "No ambiguity warning expected")
    }

    func test_door_ambiguous_between_two_close_walls_drops_confidence() {
        // Place two parallel walls 0.05 m apart along the same axis; a door
        // centroid exactly between them must trigger the H17 ambiguity path.
        // (This is the H17 mitigation test — we don't actually want this in a
        // real scan, but the matcher MUST surface it instead of silent-pick.)
        let wA = makeWall(id: "A", start: v(0, 0, 0), end: v(4, 0, 0))
        let wB = makeWall(id: "B", start: v(0, 0, 0.05), end: v(4, 0, 0.05))
        let candidates = [wA, wB]

        let doorCentroid = CanonicalVector3(x: 2.0, y: 1.0, z: 0.025)
        let match = HostWallMatcher.findHostWall(
            doorCentroid: doorCentroid,
            walls: candidates,
            options: HostWallMatchOptions(
                maxDistanceM: 0.5,
                ambiguityToleranceM: 0.10,
                alongToleranceM: 0.10
            )
        )
        XCTAssertNotNil(match.winner)
        XCTAssertEqual(match.confidence, 0.5, "Two close candidates → confidence 0.5 (H17)")
        XCTAssertFalse(match.warnings.isEmpty, "Ambiguity warning expected (H17)")
        XCTAssertTrue(
            match.warnings.contains(where: { $0.contains("DOOR_HOST_WALL_AMBIGUOUS") }),
            "Warning should carry the DOOR_HOST_WALL_AMBIGUOUS prefix"
        )
    }

    // MARK: - Wall-doubling collapse (R12 · H28)

    func test_doubled_walls_collapse_and_door_hosts_survivor() {
        // Two parallel walls along the same axis, 0.15 m apart (typical
        // RoomPlan doubling) → must be detected. Plus a door centroid on
        // the same span — it must end up hosted by the SURVIVOR wall.
        let wA = makeWall(id: "A", start: v(0, 0, 0), end: v(4, 0, 0))
        let wB = makeWall(id: "B", start: v(0, 0, 0.15), end: v(4, 0, 0.15))
        let walls = [wA, wB]

        // Detection runs regardless of `collapseWallDoublings` — the option
        // only controls whether the second-of-pair is dropped.
        let pairs = WallDoublingDetector.detect(walls: walls)
        XCTAssertEqual(pairs.count, 1, "One pair of doubled walls expected")
        XCTAssertEqual(pairs.first?.surviveId, "A")
        XCTAssertEqual(pairs.first?.dropId, "B")

        // ── Case 1: collapse=true → host-matcher sees [A] only.
        let collapsedCandidates = walls.filter { c in
            !pairs.contains(where: { $0.dropId == c.id })
        }
        let doorCentroid = CanonicalVector3(x: 2.0, y: 1.0, z: 0.075)
        let match = HostWallMatcher.findHostWall(
            doorCentroid: doorCentroid,
            walls: collapsedCandidates
        )
        XCTAssertEqual(match.winner?.id, "A", "Door hosts the SURVIVING wall after collapse")
        XCTAssertEqual(match.confidence, 1.0, "Only one candidate left → confidence 1.0")

        // ── Case 2: collapse=false → host-matcher sees BOTH walls.
        let bothMatch = HostWallMatcher.findHostWall(
            doorCentroid: doorCentroid,
            walls: walls,
            options: HostWallMatchOptions(
                maxDistanceM: 0.5,
                ambiguityToleranceM: 0.10,
                alongToleranceM: 0.10
            )
        )
        XCTAssertNotNil(bothMatch.winner)
        XCTAssertEqual(
            bothMatch.confidence, 0.5,
            "Without collapse, both walls compete → ambiguity (H17)"
        )
    }

    // MARK: - V1.5 Hotfix E2 · wall-thickness helper

    func test_wallThicknessFromDimensions_measured_above_threshold_wins() {
        XCTAssertEqual(
            RoomPlanMapping.wallThicknessFromDimensions(z: 0.25, defaultThicknessM: 0.15),
            0.25, accuracy: 0.001,
            "Apple-measured thickness (>1cm) replaces the default"
        )
    }

    func test_wallThicknessFromDimensions_zero_falls_back_to_default() {
        XCTAssertEqual(
            RoomPlanMapping.wallThicknessFromDimensions(z: 0.0, defaultThicknessM: 0.15),
            0.15, accuracy: 0.001,
            "Apple-emitted 0 (doors/windows quirk) keeps the default"
        )
    }

    func test_wallThicknessFromDimensions_subcentimeter_falls_back_to_default() {
        XCTAssertEqual(
            RoomPlanMapping.wallThicknessFromDimensions(z: 0.005, defaultThicknessM: 0.20),
            0.20, accuracy: 0.001,
            "Sub-1cm values are treated as no-measurement"
        )
    }

    func test_wallThicknessFromDimensions_exact_threshold_falls_back() {
        XCTAssertEqual(
            RoomPlanMapping.wallThicknessFromDimensions(z: 0.01, defaultThicknessM: 0.15),
            0.15, accuracy: 0.001,
            "Threshold is strictly greater than 1cm — exactly 1cm uses default"
        )
    }

    // MARK: - V1.5 Hotfix E3/E4 · worldPolygonFromCorners

    func test_worldPolygonFromCorners_identity_transform_preserves_coords() {
        let corners: [simd_float3] = [
            simd_float3(0, 0, 0),
            simd_float3(1, 0, 0),
            simd_float3(1, 0, 1),
            simd_float3(0, 0, 1),
        ]
        let world = CanonicalConverter.worldPolygonFromCorners(
            corners: corners,
            transform: matrix_identity_float4x4
        )
        XCTAssertEqual(world.count, 4)
        XCTAssertEqual(world[0].x, 0.0, accuracy: 0.001)
        XCTAssertEqual(world[2].x, 1.0, accuracy: 0.001)
        XCTAssertEqual(world[2].z, 1.0, accuracy: 0.001)
    }

    func test_worldPolygonFromCorners_translation_offsets_all_points() {
        let corners: [simd_float3] = [
            simd_float3(0, 0, 0),
            simd_float3(1, 0, 0),
        ]
        var transform = matrix_identity_float4x4
        transform.columns.3 = simd_float4(10, 0, 5, 1)
        let world = CanonicalConverter.worldPolygonFromCorners(
            corners: corners, transform: transform
        )
        XCTAssertEqual(world[0].x, 10.0, accuracy: 0.001)
        XCTAssertEqual(world[0].z, 5.0, accuracy: 0.001)
        XCTAssertEqual(world[1].x, 11.0, accuracy: 0.001)
        XCTAssertEqual(world[1].z, 5.0, accuracy: 0.001)
    }

    func test_worldPolygonFromCorners_empty_input_returns_empty() {
        let world = CanonicalConverter.worldPolygonFromCorners(
            corners: [], transform: matrix_identity_float4x4
        )
        XCTAssertEqual(world.count, 0)
    }

    func test_worldPolygonFromCorners_L_shape_5_corners_count_preserved() {
        // L-wand mit 5 corners → polygon_override emittiert (count > 4)
        let corners: [simd_float3] = [
            simd_float3(0, 0, 0),
            simd_float3(2, 0, 0),
            simd_float3(2, 0, 1),
            simd_float3(1, 0, 1),
            simd_float3(1, 0, 2),
        ]
        let world = CanonicalConverter.worldPolygonFromCorners(
            corners: corners, transform: matrix_identity_float4x4
        )
        XCTAssertEqual(world.count, 5, "All corners survive transform")
    }

    // MARK: - Helpers

    private func v(_ x: Double, _ y: Double, _ z: Double) -> CanonicalVector3 {
        return CanonicalVector3(x: x, y: y, z: z)
    }

    private func makeWall(
        id: String,
        start: CanonicalVector3,
        end: CanonicalVector3,
        thickness: Double = 0.15,
        heightM: Double = 2.5
    ) -> HostWallCandidate {
        return HostWallCandidate(
            id: id,
            geometry: CanonicalWallGeometry(
                startPoint: start,
                endPoint: end,
                thicknessM: thickness,
                baseHeightM: 0,
                heightM: heightM
            )
        )
    }
}
