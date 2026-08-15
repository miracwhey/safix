/**
 * Spatial · Canonical · Validator · Scene-level DIN/VDE Summary (Provider-facing)
 *
 * Pure-L1 aggregator over {@link evaluateWallObjectDin}. The per-candidate
 * validator is run customer-side during edits; here it is swept across a WHOLE
 * scene (every opening + every wall-mounted object on every wall) so the
 * craftsman gets the same 7 DIN/VDE norm hints read-only on the Stückliste tab —
 * and can turn each into a billable position.
 *
 * No RLS, no migration, no new persistence: the warnings are DERIVED from the
 * already-hydrated parametric scene, never stored. The radiator↔electrical
 * proximity rule (VDE 0100-520) fires from both objects; {@link dinWarningKey}
 * collapses the mirror pair so it is reported once.
 */

import type { RoomScene } from '../types/scene-graph'
import type { BomUnit } from '../workflow/bomModel'
import {
  evaluateWallObjectDin,
  type DinWarning,
  type DinWarningCode,
} from './wallObjectDinValidator'

/**
 * Stable identity for a warning — its code plus its affected-id SET (sorted, so
 * the mirrored radiator/outlet pair, which differs only in id order, collapses).
 * Reused by the UI to track which warnings have already been added as positions.
 */
export function dinWarningKey(w: DinWarning): string {
  return `${w.code}:${[...w.affectedIds].sort().join(',')}`
}

/**
 * Evaluate DIN/VDE soft-plausibility across the whole scene and return the
 * de-duplicated warnings. Pure L1 (no three.js / React / DOM).
 */
export function evaluateSceneDin(scene: RoomScene): DinWarning[] {
  const out: DinWarning[] = []
  const seen = new Set<string>()
  const push = (warnings: DinWarning[]): void => {
    for (const w of warnings) {
      const key = dinWarningKey(w)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(w)
    }
  }

  for (const wall of scene.walls) {
    const wallLengthM = wall.length_m
    for (const opening of wall.openings) {
      push(
        evaluateWallObjectDin({
          wall,
          wallLengthM,
          candidate: { kind: 'opening', opening },
          roomCategory: scene.category,
        }),
      )
    }
    for (const object of wall.wall_mounted) {
      push(
        evaluateWallObjectDin({
          wall,
          wallLengthM,
          candidate: { kind: 'wall_mounted', object },
          roomCategory: scene.category,
        }),
      )
    }
  }

  return out
}

// ─── DIN warning → BoM position draft ────────────────────────────────────────

/** A manual-position draft minus the fields the BoM model derives (id/position/source). */
export interface BomPositionDraft {
  description: string
  category: string
  quantity: number
  unit: BomUnit
  unitPriceCents: number
}

/**
 * Trade-actionable position text + unit per DIN code. The description is what a
 * craftsman would write on the quote ("…versetzen"), not the raw norm hint, so
 * the added line item reads like real work, not a warning.
 */
const DIN_POSITION_TEMPLATES: Record<DinWarningCode, { description: string; unit: BomUnit }> = {
  DIN_OUTLET_HEIGHT: { description: 'Steckdosen auf Normhöhe versetzen', unit: 'pcs' },
  DIN_SWITCH_HEIGHT: { description: 'Schalter auf Normhöhe versetzen', unit: 'pcs' },
  DIN_WINDOW_SILL_LOW: { description: 'Absturzsicherung Fenster prüfen / nachrüsten', unit: 'pcs' },
  DIN_DOOR_NEAR_CORNER: { description: 'Türanschlag / Bewegungsfläche prüfen', unit: 'pcs' },
  DIN_RADIATOR_NOT_UNDER_WINDOW: { description: 'Heizkörperposition prüfen', unit: 'pcs' },
  DIN_OUTLET_NEAR_HEATING: { description: 'Wärmeabstand Elektro zu Heizkörper herstellen', unit: 'pcs' },
  DIN_BATHROOM_ZONE: { description: 'Bad: Elektro-Schutzbereiche umsetzen', unit: 'pcs' },
}

/**
 * Turn a DIN warning into a manual BoM-position draft (quantity 1, unpriced —
 * the craftsman enters the price). `category: 'Sonstiges'` maps onto the offer
 * domain's `other` bucket via the BoM-category heuristic.
 */
export function dinWarningToBomDraft(warning: DinWarning): BomPositionDraft {
  const tpl = DIN_POSITION_TEMPLATES[warning.code]
  return {
    description: tpl.description,
    category: 'Sonstiges',
    quantity: 1,
    unit: tpl.unit,
    unitPriceCents: 0,
  }
}
