/**
 * Spatial · fit-scale for the scan render-fallback.
 *
 * Scan objects (native RoomPlan → CanonicalConverter) carry a MEASURED AABB but
 * no asset_id, so ObjectAdapter renders them via a category-default model (GLB or
 * procedural) that is CATALOG-sized. Centre-anchoring a catalog-sized model at the
 * scan-height host position floats/sinks its feet by (scanH − modelH)/2. This pure
 * helper returns the per-axis scale that makes a centre-anchored model exactly fill
 * the measured AABB (feet flush, no load-time pop).
 *
 * Pure math (zero three.js / React) — L1, importable from the L3 ObjectAdapter and
 * unit-tested. `target === null` (asset_id set → Manual/Example) returns null so the
 * caller skips the scale wrap and renders the native catalog size unchanged. A zero
 * source extent on any axis falls back to 1 on that axis (never divides by zero).
 */
export interface Vec3Extent {
  x: number
  y: number
  z: number
}

export interface FitTargetDims {
  w: number
  h: number
  d: number
}

const EPS = 1e-6

/**
 * Per-axis scale that maps a model's own AABB extent (`source`) onto the measured
 * target dimensions, or `null` when no target is given. Each axis with a degenerate
 * (≤EPS) source extent stays at scale 1.
 */
export function fitScaleForDims(
  source: Vec3Extent,
  target: FitTargetDims | null,
): [number, number, number] | null {
  if (!target) return null
  return [
    source.x > EPS ? target.w / source.x : 1,
    source.y > EPS ? target.h / source.y : 1,
    source.z > EPS ? target.d / source.z : 1,
  ]
}

/** Convenience: extent of an AABB given as `{ min, max }` (e.g. a procedural bbox). */
export function extentOfBox(box: {
  min: Vec3Extent
  max: Vec3Extent
}): Vec3Extent {
  return {
    x: box.max.x - box.min.x,
    y: box.max.y - box.min.y,
    z: box.max.z - box.min.z,
  }
}
