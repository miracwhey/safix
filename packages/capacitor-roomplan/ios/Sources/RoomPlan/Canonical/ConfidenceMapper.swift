// Spatial V1 · Day 9 B15 · iOS-native canonical converter
//
// RoomPlan's `CapturedRoom.Confidence` is a 3-bucket enum (`.high`,
// `.medium`, `.low`). The canonical scene-graph stores a Double in [0, 1],
// matching the TS-side bridge (`anchorConfidenceToNumber` in
// scanToParametric.ts).
//
// Mapping (matches scanToParametric.ts:896-909):
//
//   .high   → 0.9
//   .medium → 0.6
//   .low    → 0.3
//
// `.high` is intentionally 0.9, not 1.0 — RoomPlan never gives a
// "ground-truth" confidence, so we reserve 1.0 for canonical-domain values
// that have been verified by the user / measurement input.
//
// iOS 17 note (audit feedback `feedback_swift_ios17_stored_property_anyobject`):
// `CapturedRoom.Confidence` is available on iOS 16+ for surfaces, so we can
// reference it directly. RoomPlan polygon-wall APIs that ARE iOS-17-only are
// guarded in `RoomPlanMapping.swift`, not here.
//

import Foundation
import RoomPlan

public enum ConfidenceMapper {
    /// RoomPlan-emitted `Confidence` → canonical `[0, 1]` Double. Matches
    /// the TS bridge default mapping bake-in (binding).
    public static func toDouble(_ confidence: CapturedRoom.Confidence) -> Double {
        switch confidence {
        case .high:   return 0.9
        case .medium: return 0.6
        case .low:    return 0.3
        @unknown default:
            // TODO(day-9-xcode-check): Apple may add `.unknown` or new tiers
            // in a future iOS. Default to medium to keep the validator out of
            // the "no confidence" code-path until the new tier is mapped.
            return 0.6
        }
    }
}
