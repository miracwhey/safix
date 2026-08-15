/**
 * Spatial · Canonical · Snap · Clearance-Zone Derivation (Phase 2 · Block 2.8)
 *
 * Pure L1 helper that derives an ergonomic {@link ClearanceZone} for a placed
 * {@link SpatialObject}. The clearance zone is the free space that should stay
 * unobstructed around a fixture (knee room in front of a WC, approach space at
 * a sink, ...). The Phase-2 edit-system surfaces it two ways:
 *   - the per-move validator warns when another object intrudes (§8.2),
 *   - the L3 `<ClearanceZoneOverlay>` renders it as a translucent volume.
 *
 * Source of truth, in priority order:
 *   1. an explicit per-asset `ClearanceZone` on the catalog `Asset` (V1.x —
 *      most catalog rows do not carry one yet),
 *   2. the asset's {@link SnapRule} `min_distance_to_other_objects_m` /
 *      `min_distance_to_corner_m` (the catalog DOES ship these),
 *   3. a per-category default table for the common sanitary fixtures.
 *
 * Layer: pure L1 — no three.js / React / DOM.
 */

import type { ClearanceZone, SnapRule } from '../types/asset.ts'
import type { ObjectCategory } from '../types/objects.ts'
import { DEFAULT_SNAP_RULE } from './asset-snap.ts'

/**
 * Per-category clearance defaults (meters). Front clearance is the dominant
 * ergonomic dimension — knee/approach room — so it carries the largest value;
 * sides + above are conservative minima. Categories not listed fall back to
 * {@link FALLBACK_CLEARANCE}.
 */
const CATEGORY_CLEARANCE: Partial<Record<ObjectCategory, ClearanceZone>> = {
  toilet: { front_m: 0.6, sides_m: 0.2, above_m: 0 },
  bidet: { front_m: 0.6, sides_m: 0.2, above_m: 0 },
  sink: { front_m: 0.55, sides_m: 0.15, above_m: 0 },
  kitchen_sink: { front_m: 0.55, sides_m: 0.15, above_m: 0 },
  bathtub: { front_m: 0.6, sides_m: 0.1, above_m: 0 },
  shower: { front_m: 0.6, sides_m: 0.1, above_m: 0 },
  oven: { front_m: 0.7, sides_m: 0.1, above_m: 0 },
  dishwasher: { front_m: 0.7, sides_m: 0.1, above_m: 0 },
  refrigerator: { front_m: 0.7, sides_m: 0.1, above_m: 0 },
  cooktop: { front_m: 0.7, sides_m: 0.1, above_m: 0 },
  washing_machine: { front_m: 0.7, sides_m: 0.05, above_m: 0 },
  fireplace: { front_m: 0.6, sides_m: 0.1, above_m: 0 },
  // A rug is a flat floor covering — furniture is placed ON it, so it must not
  // reserve any approach clearance that would push neighbours away.
  rug: { front_m: 0, sides_m: 0, above_m: 0 },
}

/** Default clearance for any category without a dedicated entry. */
export const FALLBACK_CLEARANCE: ClearanceZone = Object.freeze({
  front_m: 0.2,
  sides_m: 0.2,
  above_m: 0,
})

/**
 * Derive a {@link ClearanceZone} for an object of the given category.
 *
 * @param category    fine object category (drives the default table)
 * @param explicit    an explicit per-asset clearance zone, when the catalog
 *                    row carries one — wins over everything else
 * @param snapRule    the asset's snap rule — its `min_distance_*` fields raise
 *                    the derived front/sides clearance when larger than the
 *                    category default
 */
export function deriveClearanceZone(
  category: ObjectCategory,
  explicit?: ClearanceZone,
  snapRule?: SnapRule,
): ClearanceZone {
  if (explicit) return { ...explicit }

  const base = CATEGORY_CLEARANCE[category] ?? FALLBACK_CLEARANCE
  const rule = snapRule ?? DEFAULT_SNAP_RULE[category]

  const otherMin = rule?.min_distance_to_other_objects_m
  const cornerMin = rule?.min_distance_to_corner_m

  return {
    // The object-to-object minimum is an all-round minimum; the front
    // clearance should never be smaller than it.
    front_m: Math.max(base.front_m, otherMin ?? 0),
    sides_m: Math.max(base.sides_m, otherMin ?? 0, cornerMin ?? 0),
    above_m: base.above_m,
  }
}

/**
 * `true` when the derived clearance zone has any non-zero extent — i.e. it is
 * worth rendering / checking at all. A zero zone (e.g. a ceiling lamp) is
 * skipped by the overlay.
 */
export function clearanceZoneHasExtent(zone: ClearanceZone): boolean {
  return zone.front_m > 0 || zone.sides_m > 0 || zone.above_m > 0
}
