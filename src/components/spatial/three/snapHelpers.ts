/**
 * Spatial Core · Block E2 · Pure-function helpers (snap, UV resolve)
 *
 * Pure-function utilities used by the three.js scene. Lives outside the
 * `.tsx` components so they can be vitest-covered without spinning up
 * jsdom + a fake Canvas.
 *
 *   * Cardinal-angle snap for the Top-Down camera rotation.
 *   * UV → world-position resolve for D2 hybrid anchors. Mirrors the SQL
 *     anchor SoT discipline: when the cache is suspect, fall back to a
 *     surface-bounds approximation rather than returning a stale XYZ.
 */

import type { AnchorWorldCache } from '../../../lib/spatial/types'

/** Cardinal angles in radians, in CCW order starting at +X. */
export const CARDINAL_ANGLES_RAD = [
  0,
  Math.PI / 2,
  Math.PI,
  (3 * Math.PI) / 2,
] as const

/** Snap distance: how close (in rad) the current angle must be to a cardinal
 *  before we lock to it. ~5.7° — generous enough to feel sticky without
 *  blocking deliberate off-cardinal viewing. */
export const SNAP_TOLERANCE_RAD = 0.1

/** Normalise an angle in radians to [0, 2π). */
export function normalizeAngle(angleRad: number): number {
  const twoPi = Math.PI * 2
  const wrapped = angleRad % twoPi
  return wrapped < 0 ? wrapped + twoPi : wrapped
}

/**
 * Snap a Top-Down rotation to the nearest cardinal (0/90/180/270°) when
 * within {@link SNAP_TOLERANCE_RAD}. Returns the snapped angle plus a flag
 * telling the caller whether snapping occurred — UI uses the flag to fire
 * `useHaptics.selection()` for the snap-acquire feedback.
 */
export function snapToCardinal(angleRad: number): {
  angle: number
  didSnap: boolean
} {
  const normalized = normalizeAngle(angleRad)
  for (const target of CARDINAL_ANGLES_RAD) {
    const diff = Math.abs(normalized - target)
    // Account for wrap at 2π → 0.
    const wrappedDiff = Math.min(diff, Math.PI * 2 - diff)
    if (wrappedDiff <= SNAP_TOLERANCE_RAD) {
      return { angle: target, didSnap: normalized !== target }
    }
  }
  return { angle: normalized, didSnap: false }
}

/**
 * Resolve an anchor to a world-XYZ in the glTF coordinate frame.
 *
 * Priority chain follows D2:
 *   1. Per-format world cache (fast path, the common case).
 *   2. Caller-supplied surface-bounds centroid fallback (when cache is
 *      missing or the format is not yet computed). Returning `null` is the
 *      "show this pin as 2D ghost" signal for the renderer.
 *
 * We never invent an XYZ from anchorUv alone here — that math depends on
 * the mesh geometry and is performed inside `<AnchorPins>` via a raycast
 * against the loaded scene. This helper is the cache-only short-circuit.
 */
export function resolveAnchorWorldXyz(
  cache: AnchorWorldCache | null,
  format: 'gltf' | 'usdz',
  fallbackCentroid: { x: number; y: number; z: number } | null,
): { x: number; y: number; z: number } | null {
  const cached = cache?.[format]
  if (cached) return cached
  return fallbackCentroid
}
