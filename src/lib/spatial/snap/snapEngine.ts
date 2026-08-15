/**
 * Spatial Core · Block F.6 · Snap Engine
 *
 * Pure-function snap target lookup used by the Pin-Editor reticle. Given
 * a world position + the loaded surfaces + a camera projection, returns
 * the nearest snap candidate in screen-space (Vertex > Edge-Mid > Edge >
 * Face priority) or null when nothing is within `thresholdPx`.
 *
 * Pure + dependency-light so it can vitest without a three.js Canvas.
 * The caller projects world points to screen via a `projector` callback
 * (Scene wires `arView.project` / `WebGLRenderer.project`).
 */

export interface SnapPoint {
  /** Stable id — surface external id + corner index, or "<surfaceId>:edge-mid:<n>". */
  id: string
  /** World-space XYZ of the candidate. */
  world: [number, number, number]
  /** Priority bucket — affects the bonus radius (Vertex gets 1.5x). */
  kind: 'vertex' | 'edge_mid' | 'edge' | 'face'
}

export interface SnapResult {
  point: SnapPoint
  /** Pixel distance between the cursor and the snapped target. */
  distancePx: number
}

const KIND_BONUS: Record<SnapPoint['kind'], number> = {
  vertex: 1.5,
  edge_mid: 1.2,
  edge: 1.0,
  face: 0.8,
}

export interface FindSnapTargetInput {
  /** Cursor position in screen-space (px). */
  cursorPx: { x: number; y: number }
  candidates: SnapPoint[]
  /** Maximum cursor-to-candidate distance in px (default 20). */
  thresholdPx?: number
  /** Project a world point to screen-space. Return null when off-camera
   *  (occluded / behind near plane / outside viewport). */
  projector: (world: [number, number, number]) => { x: number; y: number } | null
}

export function findSnapTarget(input: FindSnapTargetInput): SnapResult | null {
  const threshold = input.thresholdPx ?? 20
  let best: SnapResult | null = null
  for (const candidate of input.candidates) {
    const projected = input.projector(candidate.world)
    if (!projected) continue
    const dx = projected.x - input.cursorPx.x
    const dy = projected.y - input.cursorPx.y
    const distancePx = Math.sqrt(dx * dx + dy * dy)
    // Effective threshold = base × kind bonus — vertex grabs a larger radius
    // so the user feels the snap before reaching the actual pixel.
    const effective = threshold * KIND_BONUS[candidate.kind]
    if (distancePx > effective) continue
    // Rank: prefer higher-priority kinds at equal distance, then closer
    // pixel distance.
    if (!best) {
      best = { point: candidate, distancePx }
      continue
    }
    if (KIND_BONUS[candidate.kind] > KIND_BONUS[best.point.kind]) {
      best = { point: candidate, distancePx }
    } else if (
      KIND_BONUS[candidate.kind] === KIND_BONUS[best.point.kind] &&
      distancePx < best.distancePx
    ) {
      best = { point: candidate, distancePx }
    }
  }
  return best
}

/**
 * Convenience: build a `SnapPoint[]` from a list of surface endpoints
 * (`mesh.geometry.boundingBox` corners) keyed by surface external id.
 * Block X's planned mesh-userData mapping will replace this placeholder
 * with real vertex + edge enumeration.
 */
export function buildSnapPointsFromSurfaceEndpoints(
  endpoints: Record<string, { start: [number, number, number]; end: [number, number, number] }>,
): SnapPoint[] {
  const out: SnapPoint[] = []
  for (const [surfaceId, { start, end }] of Object.entries(endpoints)) {
    out.push({ id: `${surfaceId}:vertex:start`, world: start, kind: 'vertex' })
    out.push({ id: `${surfaceId}:vertex:end`, world: end, kind: 'vertex' })
    const mid: [number, number, number] = [
      (start[0] + end[0]) / 2,
      (start[1] + end[1]) / 2,
      (start[2] + end[2]) / 2,
    ]
    out.push({ id: `${surfaceId}:edge_mid:0`, world: mid, kind: 'edge_mid' })
  }
  return out
}
