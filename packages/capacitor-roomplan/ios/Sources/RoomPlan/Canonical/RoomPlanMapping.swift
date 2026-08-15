// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Pure RoomPlan→canonical-shape mapping helpers.
//
// Maps `CapturedRoom.Surface` and `CapturedRoom.Object` into:
//   - canonical wall geometry (start_point / end_point / thickness)
//   - canonical wall/opening/floor/ceiling/object JSON dicts (built by
//     `CanonicalConverter`; this file only produces the value-types and
//     primitive coords).
//
// Coordinate-system note (binding · Master-Spec §2):
//
//   RoomPlan ships a Right-Handed Y-Up coordinate system that matches our
//   canonical convention. The "left-handed in some axes" gotcha applies to
//   ARKit's anchor poses in certain modes — RoomPlan's `simd_float4x4`
//   `transform` columns are already in the RH-Y-up world frame, so the
//   converter passes positions straight through without sign-flip.
//   See `RoomScanViewController.buildMetadata` (already in tree) for the
//   parallel pattern used by the JS-side metadata dump.
//
// iOS-17 audit bake-in (`feedback_swift_ios17_stored_property_anyobject`):
//
//   `CapturedRoom.floors`, `CapturedRoom.Surface.completedEdges`, and
//   `Surface.polygonCorners` are iOS-17-only API surface; this module's
//   public entrypoints are gated with `@available(iOS 17.0, *)` and the
//   plugin stores `lastCapturedRoom` as a typeless `AnyObject` so the
//   property declaration itself does NOT pull an iOS-17-only type into
//   load-time symbol resolution.
//
// Pure: Foundation + RoomPlan + simd · no third-party deps.
//

import Foundation
import RoomPlan
import simd

@available(iOS 17.0, *)
internal enum RoomPlanMapping {

    // ─────────────────────────────────────────────────────────────────────
    // Stable ids
    //
    // RoomPlan's `CapturedRoom.Surface.identifier` is a UUID that survives
    // re-scans of the same room (per Apple docs) → we reuse it as the
    // canonical `Wall.id` / `WallOpening.id` so Block-A's
    // `surfaceExternalId` convention stays intact (Day 8 B13 alignment).
    // ─────────────────────────────────────────────────────────────────────

    static func externalId(forSurface surface: CapturedRoom.Surface) -> String {
        return surface.identifier.uuidString
    }

    static func externalId(forObject object: CapturedRoom.Object) -> String {
        return object.identifier.uuidString
    }

    // ─────────────────────────────────────────────────────────────────────
    // Position / transform extraction
    //
    // RoomPlan's `simd_float4x4.columns.3` is the translation. The wall's
    // local +X axis is `columns.0` — projecting that onto the XZ plane gives
    // us the wall's centerline direction in world space.
    // ─────────────────────────────────────────────────────────────────────

    static func position(from transform: simd_float4x4) -> CanonicalVector3 {
        let t = transform.columns.3
        return CanonicalVector3(x: Double(t.x), y: Double(t.y), z: Double(t.z))
    }

    /// Wall local +X axis projected to world space (XZ plane only · Y
    /// component dropped because V1 walls are vertical).
    static func wallAxisXZ(from transform: simd_float4x4) -> (x: Double, z: Double) {
        let lx = transform.columns.0
        return (Double(lx.x), Double(lx.z))
    }

    // ─────────────────────────────────────────────────────────────────────
    // Surface → canonical wall geometry
    //
    // Derive start_point / end_point from `transform` + `dimensions`:
    // RoomPlan emits the wall's CENTERPOINT in `transform.columns.3`, with
    // `dimensions.x` = width along the local +X axis. start/end are
    // `center ± (width/2) · axis`.
    // ─────────────────────────────────────────────────────────────────────

    static func wallGeometry(
        from surface: CapturedRoom.Surface,
        defaultThicknessM: Double
    ) -> CanonicalWallGeometry {
        let pos = position(from: surface.transform)
        let axis = wallAxisXZ(from: surface.transform)
        let widthM = Double(surface.dimensions.x)
        let heightM = Double(surface.dimensions.y)
        let half = widthM / 2

        let start = CanonicalVector3(
            x: pos.x - axis.x * half,
            y: pos.y,
            z: pos.z - axis.z * half
        )
        let end = CanonicalVector3(
            x: pos.x + axis.x * half,
            y: pos.y,
            z: pos.z + axis.z * half
        )

        // V1.5 Hotfix E2 (T-05): prefer Apple's measured wall thickness when
        // present. `surface.dimensions.z` is the wall depth in meters; values
        // <= 1 cm are treated as "no reliable measurement" (Apple emits 0 for
        // thin partitions / doors / windows — a documented quirk). The default
        // fallback preserves the pre-hotfix behaviour for those edge-cases.
        let thicknessM = wallThicknessFromDimensions(
            z: surface.dimensions.z,
            defaultThicknessM: defaultThicknessM
        )

        return CanonicalWallGeometry(
            startPoint: start,
            endPoint: end,
            thicknessM: thicknessM,
            baseHeightM: 0,
            heightM: heightM
        )
    }

    // ─────────────────────────────────────────────────────────────────────
    // V1.5 Hotfix E2 · pure thickness helper
    //
    // Extracted from wallGeometry so the Mac-SDK-buildable test target can
    // verify the > 1cm threshold without needing a CapturedRoom.Surface
    // fixture (which the macOS SDK does not ship).
    // ─────────────────────────────────────────────────────────────────────

    static func wallThicknessFromDimensions(
        z: Float,
        defaultThicknessM: Double
    ) -> Double {
        let measured = Double(z)
        return measured > 0.01 ? measured : defaultThicknessM
    }

    // ─────────────────────────────────────────────────────────────────────
    // V1.5 Hotfix E4 · wall polygon_override emission (iOS 17+)
    //
    // RoomPlan's `Surface.polygonCorners` is the precise local-plane corner
    // ring of a wall — for rectangular walls it is 4 corners deckungsgleich
    // with `dimensions`, for irregular walls (Erker, Schräge, Heizungs-Nische,
    // Mansarden) it is the only accurate geometry source. The parametric
    // bridge already accepts `Wall.polygon_override?: Vector3[]` (TS schema
    // at `src/lib/spatial/canonical/types/geometry.ts:58`); this hotfix
    // wires the iOS-side emission so the renderer finally sees the correct
    // shape for non-rectangular walls.
    //
    // Skip-rule: emit nil for the 4-corner case so we do not bloat the blob
    // with redundant data already representable as start/end/thickness.
    // ─────────────────────────────────────────────────────────────────────

    static func wallPolygonOverride(
        from surface: CapturedRoom.Surface
    ) -> [CanonicalVector3]? {
        guard surface.polygonCorners.count > 4 else { return nil }
        return CanonicalConverter.worldPolygonFromCorners(
            corners: surface.polygonCorners,
            transform: surface.transform
        )
    }

    // ─────────────────────────────────────────────────────────────────────
    // Opening centroid / dimensions
    // ─────────────────────────────────────────────────────────────────────

    static func openingCentroid(from surface: CapturedRoom.Surface) -> CanonicalVector3 {
        return position(from: surface.transform)
    }

    static func dimensionsM(from surface: CapturedRoom.Surface) -> (width: Double, height: Double) {
        return (Double(surface.dimensions.x), Double(surface.dimensions.y))
    }

    // ─────────────────────────────────────────────────────────────────────
    // Object category → canonical category string
    //
    // Maps `CapturedRoom.Object.Category` → canonical `ObjectCategory`
    // (snake_case, matches `src/lib/spatial/canonical/types/objects.ts`).
    // Anything we don't have a dedicated bucket for becomes
    // `generic_cuboid` — that's the canonical fallback.
    // ─────────────────────────────────────────────────────────────────────

    static func categoryString(_ category: CapturedRoom.Object.Category) -> String {
        switch category {
        case .storage:           return "wardrobe"
        case .refrigerator:      return "refrigerator"
        case .stove:             return "cooktop"
        case .bed:               return "bed"
        case .sink:              return "sink"
        case .washerDryer:       return "washing_machine"
        case .toilet:            return "toilet"
        case .bathtub:           return "bathtub"
        case .oven:              return "oven"
        case .dishwasher:        return "dishwasher"
        case .table:             return "table"
        case .sofa:              return "sofa"
        case .chair:             return "chair"
        case .fireplace:         return "fireplace"
        case .television:        return "tv_cabinet"
        case .stairs:            return "generic_cuboid"
        @unknown default:
            // TODO(day-9-xcode-check): Apple may add new RoomPlan object
            // categories in future iOS — default to generic_cuboid so the
            // validator does NOT reject the document at ingest.
            return "generic_cuboid"
        }
    }
}
