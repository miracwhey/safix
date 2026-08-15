/**
 * Spatial · Workflow · Verify-Flow Change Summary (Phase 3 · Block 3.8)
 *
 * The pure derivation layer for the Customer-Verify Stage-5 (Confirm) overview.
 * Given the base canonical {@link RoomScene} and the resolved scene (with the
 * `customer_corrections` overrides applied) it produces a structured
 * {@link VerifyChangeSummary} — the list of every change the customer made
 * across Stages 2-4 (measurement corrections, layout edits, wish-pins).
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * PURE workflow logic — no React, no zustand, no three.js, no DB. Deterministic
 * over `(baseScene, resolvedScene)`. The VerifyStageConfirm UI consumes the
 * result; it never re-derives the diff itself.
 *
 * ── Why base-vs-resolved, not the undo stack ────────────────────────────────
 * The session command stack (`editHistoryStore.undoStack`) is ephemeral — it
 * is wiped on reload / logout. The Stage-5 summary must survive an App-Kill +
 * Resume (Implementation-Spec §2.3), so it is derived from the PERSISTED
 * `customer_corrections` layer instead: the base scene vs the resolved scene.
 * A correction that was applied, persisted, then the app killed still shows up
 * on resume because the override is on the persisted layer.
 *
 * ── What counts as a change (Mockup 15 · Phone 5) ───────────────────────────
 *   - measurement: a wall whose height / thickness differs from base,
 *   - layout: a base wall deleted, an opening added/removed/moved,
 *   - pins: every customer pin not present on the base scene.
 * The three buckets map 1:1 onto the Mockup-15 Stage-5 summary card.
 */

import type { RoomScene } from '../canonical/types/scene-graph'
import type { Pin } from '../canonical/types/annotations'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** One wall whose dimensions the customer corrected in Stage 2. */
export interface VerifyMeasurementChange {
  /** Canonical wall id. */
  wallId: string
  /** Wall display name (e.g. "Eingangswand"). */
  wallName: string
  /** Height before / after the correction (meters). */
  heightBeforeM: number
  heightAfterM: number
}

/** The kind of a Stage-3 layout change. */
export type VerifyLayoutChangeKind =
  /** A base wall was deleted via the `__deleted` override marker. */
  | 'wall_deleted'
  /** A door / window opening was added that is not on the base scene. */
  | 'opening_added'
  /** A base opening was moved along its host wall. */
  | 'opening_moved'

/** One Stage-3 layout edit. */
export interface VerifyLayoutChange {
  kind: VerifyLayoutChangeKind
  /** The affected node id (wall / opening). */
  nodeId: string
  /** German one-line label for the summary list. */
  label: string
}

/** One customer wish-pin added in Stage 4. */
export interface VerifyPinChange {
  /** Canonical pin id. */
  pinId: string
  /** The pin kind — one of the 4 customer types. */
  pinType: Pin['pin_type']
  /** Pin title / name for the summary list. */
  title: string
  /** Severity — meaningful for `damage` pins (drives the VF-2 trigger). */
  severity?: Pin['severity']
}

/**
 * The full Stage-5 change overview. The single object the VerifyStageConfirm
 * stage renders. `isEmpty` is `true` when the customer ran all five stages
 * without touching anything (a pure sanity-check pass).
 */
export interface VerifyChangeSummary {
  /** Stage-2 wall-measurement corrections. */
  measurements: VerifyMeasurementChange[]
  /** Stage-3 layout edits. */
  layout: VerifyLayoutChange[]
  /** Stage-4 wish-pins. */
  pins: VerifyPinChange[]
  /** Total change count across all three buckets. */
  totalChanges: number
  /** `true` when no change was made at all. */
  isEmpty: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The relative dimension delta below which a measurement change is treated as
 * noise (floating-point round-trip, sub-millimeter). A wall whose height moved
 * by less than this fraction is NOT listed as a correction.
 */
const MEASUREMENT_EPSILON = 1e-4

/** German label per customer pin kind — the Stage-5 summary copy. */
const PIN_KIND_LABEL: Record<string, string> = {
  damage: 'Schaden',
  wish: 'Wunsch',
  note: 'Notiz',
  photo: 'Foto',
}

/** `true` when two meter values differ by more than {@link MEASUREMENT_EPSILON}. */
function dimensionChanged(beforeM: number, afterM: number): boolean {
  if (beforeM <= 0) return Math.abs(afterM - beforeM) > MEASUREMENT_EPSILON
  return Math.abs(afterM - beforeM) / beforeM > MEASUREMENT_EPSILON
}

/**
 * Collect every door / window opening on a scene keyed by id, together with
 * its host wall id and parametric offset (so a move can be detected).
 */
function collectOpenings(
  scene: RoomScene,
): Map<string, { wallId: string; offsetM: number; type: string }> {
  const map = new Map<string, { wallId: string; offsetM: number; type: string }>()
  for (const wall of scene.walls) {
    for (const opening of wall.openings) {
      map.set(opening.id, {
        wallId: wall.id,
        offsetM: opening.offset_along_wall_m,
        type: opening.type,
      })
    }
  }
  return map
}

/**
 * Derive the full Stage-5 {@link VerifyChangeSummary} by diffing the base
 * scene against the resolved (`customer_corrections`-applied) scene.
 *
 * `baseScene` is the canonical scene WITHOUT customer overrides — the
 * `base_roomplan` truth. `resolvedScene` is the same scene with the
 * `customer_corrections` layer merged in. When either is `null` the summary is
 * empty (the Confirm stage then shows the "nichts geändert" copy and the
 * customer can still submit / skip).
 */
export function deriveVerifyChangeSummary(
  baseScene: RoomScene | null,
  resolvedScene: RoomScene | null,
): VerifyChangeSummary {
  const empty: VerifyChangeSummary = {
    measurements: [],
    layout: [],
    pins: [],
    totalChanges: 0,
    isEmpty: true,
  }
  if (!baseScene || !resolvedScene) return empty

  // ── Measurements — walls whose height changed ──────────────────────────────
  const baseWalls = new Map(baseScene.walls.map((w) => [w.id, w]))
  const measurements: VerifyMeasurementChange[] = []
  for (const wall of resolvedScene.walls) {
    const base = baseWalls.get(wall.id)
    if (!base) continue
    if (dimensionChanged(base.height_m, wall.height_m)) {
      measurements.push({
        wallId: wall.id,
        wallName: wall.name || 'Wand',
        heightBeforeM: base.height_m,
        heightAfterM: wall.height_m,
      })
    }
  }

  // ── Layout — deleted walls + added / moved openings ────────────────────────
  const layout: VerifyLayoutChange[] = []
  const resolvedWallIds = new Set(resolvedScene.walls.map((w) => w.id))
  for (const wall of baseScene.walls) {
    if (!resolvedWallIds.has(wall.id)) {
      layout.push({
        kind: 'wall_deleted',
        nodeId: wall.id,
        label: `${wall.name || 'Wand'} entfernt`,
      })
    }
  }
  const baseOpenings = collectOpenings(baseScene)
  const resolvedOpenings = collectOpenings(resolvedScene)
  for (const [openingId, resolved] of resolvedOpenings) {
    const base = baseOpenings.get(openingId)
    if (!base) {
      layout.push({
        kind: 'opening_added',
        nodeId: openingId,
        label: resolved.type === 'window' ? 'Fenster hinzugefügt' : 'Tür hinzugefügt',
      })
    } else if (
      base.wallId !== resolved.wallId ||
      dimensionChanged(base.offsetM, resolved.offsetM)
    ) {
      layout.push({
        kind: 'opening_moved',
        nodeId: openingId,
        label: resolved.type === 'window' ? 'Fenster verschoben' : 'Tür verschoben',
      })
    }
  }

  // ── Pins — every customer pin not on the base scene ────────────────────────
  const basePinIds = new Set(baseScene.pins.map((p) => p.id))
  const pins: VerifyPinChange[] = []
  for (const pin of resolvedScene.pins) {
    if (basePinIds.has(pin.id)) continue
    pins.push({
      pinId: pin.id,
      pinType: pin.pin_type,
      title: pin.title?.trim() || pin.name || PIN_KIND_LABEL[pin.pin_type] || 'Markierung',
      severity: pin.severity,
    })
  }

  const totalChanges = measurements.length + layout.length + pins.length
  return {
    measurements,
    layout,
    pins,
    totalChanges,
    isEmpty: totalChanges === 0,
  }
}

/**
 * German one-line summary of the measurement bucket for the Stage-5 card
 * (e.g. "3 Maß-Korrekturen"). Returns `null` when the bucket is empty.
 */
export function measurementSummaryLine(summary: VerifyChangeSummary): string | null {
  const n = summary.measurements.length
  if (n === 0) return null
  return n === 1 ? '1 Maß-Korrektur' : `${n} Maß-Korrekturen`
}

/**
 * German one-line summary of the layout bucket for the Stage-5 card. Returns
 * `null` when the bucket is empty.
 */
export function layoutSummaryLine(summary: VerifyChangeSummary): string | null {
  const n = summary.layout.length
  if (n === 0) return null
  return n === 1 ? '1 Layout-Änderung' : `${n} Layout-Änderungen`
}

/**
 * German one-line summary of the pin bucket for the Stage-5 card, broken down
 * by kind (e.g. "5 Pins · 2 Schäden · 2 Wünsche · 1 Foto"). Returns `null`
 * when the bucket is empty.
 */
export function pinSummaryLine(summary: VerifyChangeSummary): string | null {
  const n = summary.pins.length
  if (n === 0) return null
  const counts: Record<string, number> = {}
  for (const pin of summary.pins) {
    counts[pin.pinType] = (counts[pin.pinType] ?? 0) + 1
  }
  const head = n === 1 ? '1 Pin' : `${n} Pins`
  const parts: string[] = []
  for (const [kind, count] of Object.entries(counts)) {
    parts.push(`${count} ${PIN_KIND_LABEL[kind] ?? kind}`)
  }
  return parts.length > 0 ? `${head} · ${parts.join(' · ')}` : head
}
