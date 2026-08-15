/**
 * Spatial · Canonical · Validator · Wall-Object DIN-Plausibility (V1.6.1 · Lane-1)
 *
 * The Phase-L1 SOFT-WARN companion to {@link objectPositionValidator}. Where
 * `validateObjectPosition` hard-rejects geometrically illegal placements
 * (out-of-wall / breach / overlap), THIS validator never blocks — it surfaces
 * DIN/VDE plausibility hints so a customer placing doors, windows, heating and
 * electrical points gets the same norm-guidance a craftsman would, WITHOUT
 * being trapped (the customer reports the actual state; the craftsman verifies).
 *
 *   ┌ objectPositionValidator  → hard geometry (block)
 *   └ wallObjectDinValidator   → soft DIN/VDE plausibility (warn + citation)
 *
 * The header of `objectPositionValidator.ts` explicitly anticipates this split
 * ("Soft-checks (Phase L1 DIN-plausibility — separate validator)"). We stay
 * wall-local + parametric (the contract the customer path already speaks) — we
 * deliberately do NOT route through the provider `validateComponentMove`, which
 * is keyed on world-space `EditOperation`s / resolved-scene `host` objects.
 *
 * Severity policy V1: every rule is `severity: 'warn'` (product decision
 * 2026-05-31 — "alle Soft-Warn", geometry stays the only hard gate). The
 * `severity` field exists so a later block can promote a rule to `'block'`
 * without changing the call sites.
 *
 * Pure L1: no three.js / React / DOM. vitest-fähig.
 */

import type { Wall, WallOpening } from '../types/geometry'
import type { SpatialObject, ObjectCategory } from '../types/objects'
import type { RoomCategory } from '../types/scene-graph'
import {
  aabbForOpening,
  aabbForWallMounted,
  type WallPlaneAABB,
} from './objectPositionValidator'

// ─────────────────────────────────────────────────────────────────────────────
// DIN/VDE thresholds (binding numeric constants — keep the citation in sync)
// ─────────────────────────────────────────────────────────────────────────────

/** Door/opening within this distance of a wall corner → near-corner warn. */
const DOOR_CORNER_MIN_M = 0.2
/** Window sill below this height may require fall protection (Absturzsicherung). */
const WINDOW_SILL_ABSTURZ_M = 0.8
/** Light-switch DIN handle height (DIN 18015-2). */
const SWITCH_DIN_M = 1.05
/** General socket DIN height (DIN 18015-2). */
const OUTLET_LOW_DIN_M = 0.3
/** Worktop socket DIN height (DIN 18015-2 — above kitchen counter). */
const OUTLET_HIGH_DIN_M = 1.1
/** Tolerance band around a DIN reference height before warning. */
const HEIGHT_TOL_M = 0.15
/** Min distance an electrical point should keep from a radiator (VDE 0100-520). */
const OUTLET_HEATING_MIN_M = 0.5
/** Vertical auto-snap pull distance toward a DIN reference height. */
const DIN_VSNAP_DIST_M = 0.08

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type DinWarningCode =
  | 'DIN_DOOR_NEAR_CORNER'
  | 'DIN_WINDOW_SILL_LOW'
  | 'DIN_RADIATOR_NOT_UNDER_WINDOW'
  | 'DIN_SWITCH_HEIGHT'
  | 'DIN_OUTLET_HEIGHT'
  | 'DIN_OUTLET_NEAR_HEATING'
  | 'DIN_BATHROOM_ZONE'

export interface DinWarning {
  code: DinWarningCode
  /** V1: always 'warn'. Reserved so a rule can later be promoted to 'block'. */
  severity: 'warn' | 'block'
  /** User-facing German hint for the toast / EditSheet banner. */
  message: string
  /** Citation chip, e.g. 'DIN 18015-2'. */
  dinRef: string
  /** Object ids the warning concerns (candidate + any conflicting neighbour). */
  affectedIds: string[]
  /** Id of the neighbour the candidate conflicts with, when applicable. */
  conflictingId?: string
}

/** The thing being placed / moved, in wall-local parametric form. */
export type DinCandidate =
  | { kind: 'opening'; opening: WallOpening }
  | { kind: 'wall_mounted'; object: SpatialObject }

// ─────────────────────────────────────────────────────────────────────────────
// Auto-snap (DIN reference heights) — Master decision: switch + outlet only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Magnetize a wall-object's bottom-edge height toward the nearest DIN reference
 * for its category, when the requested height is within {@link DIN_VSNAP_DIST_M}.
 * Returns the snapped height, or the input unchanged when out of pull-range or
 * the category carries no DIN snap target (doors/windows/radiators).
 *
 * Mirrors the provider 15°/wall snap feel: it pulls only NEAR the target, so a
 * deliberate drag away from the DIN height is never fought.
 */
export function snapWallObjectVerticalToDin(
  category: ObjectCategory,
  offsetFromFloorM: number,
): number {
  const targets =
    category === 'light_switch'
      ? [SWITCH_DIN_M]
      : category === 'electrical_outlet'
        ? [OUTLET_LOW_DIN_M, OUTLET_HIGH_DIN_M]
        : null
  if (!targets) return offsetFromFloorM
  let best = offsetFromFloorM
  let bestDist = DIN_VSNAP_DIST_M
  for (const t of targets) {
    const d = Math.abs(offsetFromFloorM - t)
    if (d < bestDist) {
      bestDist = d
      best = t
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate DIN/VDE soft-plausibility for one candidate on its host wall.
 *
 * Returns every fired warning (possibly empty). The candidate is the
 * POST-mutation opening/object; `excludeId` skips it when scanning neighbours.
 * `roomCategory` gates the bathroom-only VDE 0100-701 reminder.
 */
export function evaluateWallObjectDin(input: {
  wall: Wall
  wallLengthM: number
  candidate: DinCandidate
  excludeId?: string
  roomCategory?: RoomCategory
}): DinWarning[] {
  const { wall, wallLengthM, candidate, excludeId, roomCategory } = input
  const warnings: DinWarning[] = []

  if (candidate.kind === 'opening') {
    const op = candidate.opening
    const aabb = aabbForOpening(op)

    // Eckabstand — door / generic opening too close to a wall corner.
    if (op.type === 'door' || op.type === 'opening') {
      const gapStart = aabb.left
      const gapEnd = wallLengthM - aabb.right
      if (gapStart < DOOR_CORNER_MIN_M || gapEnd < DOOR_CORNER_MIN_M) {
        warnings.push({
          code: 'DIN_DOOR_NEAR_CORNER',
          severity: 'warn',
          message: 'Tür sehr nah an der Wandecke (< 20 cm) — Anschlag/Bewegungsfläche prüfen',
          dinRef: 'DIN 18101',
          affectedIds: [op.id, wall.id],
        })
      }
    }

    // Brüstungshöhe — low window sill may need fall protection.
    if (op.type === 'window' && op.offset_from_floor_m < WINDOW_SILL_ABSTURZ_M) {
      warnings.push({
        code: 'DIN_WINDOW_SILL_LOW',
        severity: 'warn',
        message: 'Fenster-Brüstung unter 80 cm — ggf. Absturzsicherung nötig',
        dinRef: 'DIN 18065',
        affectedIds: [op.id, wall.id],
      })
    }
    return warnings
  }

  // ── wall_mounted (radiator / outlet / switch) ──────────────────────────────
  const obj = candidate.object
  const candidateAabb = aabbForWallMounted(obj)
  if (!candidateAabb) return warnings
  const category = obj.category
  const isElectrical = category === 'electrical_outlet' || category === 'light_switch'

  // Schalter-Höhe — light switch off the DIN handle band.
  if (category === 'light_switch') {
    if (Math.abs((obj.height_from_floor_m ?? 0) - SWITCH_DIN_M) > HEIGHT_TOL_M) {
      warnings.push({
        code: 'DIN_SWITCH_HEIGHT',
        severity: 'warn',
        message: 'Schalter-Höhe weicht von ~105 cm ab (DIN-Standard)',
        dinRef: 'DIN 18015-2',
        affectedIds: [obj.id, wall.id],
      })
    }
  }

  // Steckdosen-Höhe — outlet outside both DIN bands (30 cm general / 110 cm worktop).
  if (category === 'electrical_outlet') {
    const h = obj.height_from_floor_m ?? 0
    const inLow = Math.abs(h - OUTLET_LOW_DIN_M) <= HEIGHT_TOL_M
    const inHigh = Math.abs(h - OUTLET_HIGH_DIN_M) <= HEIGHT_TOL_M
    if (!inLow && !inHigh) {
      warnings.push({
        code: 'DIN_OUTLET_HEIGHT',
        severity: 'warn',
        message: 'Steckdosen-Höhe unüblich — Standard 30 cm bzw. 110 cm über Arbeitsplatte',
        dinRef: 'DIN 18015-2',
        affectedIds: [obj.id, wall.id],
      })
    }
  }

  // Heizkörper unter Fenster — radiator should sit under a window for comfort.
  if (category === 'radiator') {
    const underWindow = wall.openings.some(
      (o) =>
        o.type === 'window' &&
        o.offset_along_wall_m < candidateAabb.right &&
        o.offset_along_wall_m + o.width_m > candidateAabb.left,
    )
    if (!underWindow) {
      warnings.push({
        code: 'DIN_RADIATOR_NOT_UNDER_WINDOW',
        severity: 'warn',
        message: 'Heizkörper sitzt nicht unter einem Fenster — Heizleistung/Komfort prüfen',
        dinRef: 'VDI 6036',
        affectedIds: [obj.id, wall.id],
      })
    }
  }

  // VDE 0100-520 — electrical point too close to a radiator (or vice versa).
  {
    const conflict = findCloseHeatElectricalPair(wall, obj, candidateAabb, category, excludeId)
    if (conflict) {
      warnings.push({
        code: 'DIN_OUTLET_NEAR_HEATING',
        severity: 'warn',
        message: 'Steckdose/Schalter sehr nah am Heizkörper (< 50 cm) — Wärmeabstand prüfen',
        dinRef: 'VDE 0100-520',
        affectedIds: [obj.id, conflict.id, wall.id],
        conflictingId: conflict.id,
      })
    }
  }

  // VDE 0100-701 — electrical inside a bathroom: protective-zone reminder.
  if (isElectrical && roomCategory === 'bathroom') {
    warnings.push({
      code: 'DIN_BATHROOM_ZONE',
      severity: 'warn',
      message: 'Bad: Schutzbereiche beachten — Abstand zu Dusche/Wanne prüfen',
      dinRef: 'VDE 0100-701',
      affectedIds: [obj.id, wall.id],
    })
  }

  return warnings
}

/**
 * For a candidate radiator, find the nearest electrical point on the wall within
 * {@link OUTLET_HEATING_MIN_M}; for a candidate electrical point, find the
 * nearest radiator. Returns the conflicting object or null.
 */
function findCloseHeatElectricalPair(
  wall: Wall,
  candidate: SpatialObject,
  candidateAabb: WallPlaneAABB,
  category: ObjectCategory,
  excludeId?: string,
): SpatialObject | null {
  const wantsRadiator = category === 'electrical_outlet' || category === 'light_switch'
  const wantsElectrical = category === 'radiator'
  if (!wantsRadiator && !wantsElectrical) return null
  for (const other of wall.wall_mounted) {
    if (other.id === candidate.id) continue
    if (excludeId && other.id === excludeId) continue
    const isRadiator = other.category === 'radiator'
    const isElectrical = other.category === 'electrical_outlet' || other.category === 'light_switch'
    if (wantsRadiator && !isRadiator) continue
    if (wantsElectrical && !isElectrical) continue
    const otherAabb = aabbForWallMounted(other)
    if (!otherAabb) continue
    if (aabbGap(candidateAabb, otherAabb) < OUTLET_HEATING_MIN_M) return other
  }
  return null
}

/** Shortest edge-to-edge gap between two wall-plane AABBs (0 when overlapping). */
function aabbGap(a: WallPlaneAABB, b: WallPlaneAABB): number {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right))
  const dy = Math.max(0, Math.max(a.bottom - b.top, b.bottom - a.top))
  return Math.hypot(dx, dy)
}

/**
 * One-line toast summary for a set of DIN warnings: the first message + its
 * citation, with a "+N" suffix when more fired. Empty string when none.
 */
export function summarizeDinWarnings(warnings: ReadonlyArray<DinWarning>): string {
  if (warnings.length === 0) return ''
  const first = warnings[0]
  const base = `${first.message} (${first.dinRef})`
  return warnings.length > 1 ? `${base} · +${warnings.length - 1} Hinweis(e)` : base
}
