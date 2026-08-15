// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// Public option struct for `CanonicalConverter`. Defaults mirror the
// TS bridge (`src/lib/spatial/canonical/bridge/scanToParametric.ts`):
//
//   - `collapseWallDoublings = true`     · R12 mitigation, collapse PRE
//                                          host-matching (audit-finding H28).
//   - `defaultWallThicknessM = 0.15`     · RoomPlan rarely returns reliable
//                                          thickness, so default to the L1
//                                          canonical default (`DEFAULT_WALL_
//                                          THICKNESS_M` in scanToParametric.ts).
//   - `ambiguityToleranceM = 0.10`       · Audit-finding H8: widen the default
//                                          from the TS-side 0.05 because
//                                          RoomPlan's centroids are noisier
//                                          than the synthetic test inputs the
//                                          TS matcher was tuned against.
//
// Pure value-type · Foundation only · no third-party deps.
//

import Foundation

public struct CanonicalConverterOptions {
    /// When two walls look like a single thicker wall (R12), merge them into
    /// the survivor and drop the second-of-pair before host-matching runs.
    public var collapseWallDoublings: Bool

    /// Fallback wall thickness when RoomPlan does not supply a reliable
    /// `wallThickness` value on the captured surface.
    public var defaultWallThicknessM: Double

    /// Host-wall matcher ambiguity tolerance — when a second candidate sits
    /// within this perpendicular-distance band of the winner, the matcher
    /// drops confidence below 1.0 and emits a `DOOR_HOST_WALL_AMBIGUOUS`
    /// warning (audit-finding H17).
    public var ambiguityToleranceM: Double

    public init(
        collapseWallDoublings: Bool = true,
        defaultWallThicknessM: Double = 0.15,
        ambiguityToleranceM: Double = 0.10
    ) {
        self.collapseWallDoublings = collapseWallDoublings
        self.defaultWallThicknessM = defaultWallThicknessM
        self.ambiguityToleranceM = ambiguityToleranceM
    }

    /// Production-tuned defaults. Match the TS bridge `BRIDGE_DEFAULTS`.
    public static let `default` = CanonicalConverterOptions()
}
