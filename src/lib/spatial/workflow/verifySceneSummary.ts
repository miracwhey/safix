/**
 * Spatial · Workflow · Verify-Flow Scene Summary (Phase 3 · Block 3.2)
 *
 * The pure derivation layer for the Customer-Verify Stage-1 (Welcome) sanity
 * check. Given a resolved canonical {@link RoomScene} it produces:
 *
 *   - the element counts the Welcome stage lists (walls / doors / windows /
 *     objects),
 *   - the simplified Quality-Score (VF-1 · simplified 0-100 + label),
 *   - the {@link VerifyValidationPath} — `ok` / `warnings` / `unrenderable` —
 *     which drives the three Stage-1 render branches.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * PURE workflow logic — no React, no zustand, no three.js, no DB. Deterministic
 * over a single `RoomScene`. The VerifySheet UI consumes the result; it never
 * re-derives counts or scores itself.
 *
 * ── Quality source (VF-1 · binding) ─────────────────────────────────────────
 * The score is NOT a second algorithm. It reuses the canonical
 * {@link runQualityEngine} (`lib/spatial/quality/`) — the exact same rules +
 * weights the scan-capture path runs. This module only PROJECTS a canonical
 * `RoomScene` onto the engine's {@link QualityInput} shape. "Simplified" (VF-1)
 * means the Welcome card shows ONE number + ONE label; the full warning list
 * stays available for the tap-through Detail-Sheet (Block 3.2 future) but is
 * not shown inline.
 *
 * ── Validation path source ──────────────────────────────────────────────────
 * `unrenderable` vs `warnings` vs `ok` is derived from the canonical
 * scene-validator's permissive `is_renderable` flag (`run-validator.ts`) plus
 * the error / warning buckets — never re-implemented. A scene the renderer
 * cannot draw (`is_renderable === false`) is the hard `unrenderable` path; a
 * renderable scene with validator errors/warnings is the `warnings` path;
 * a clean renderable scene is `ok`.
 */

import type { RoomScene } from '../canonical/types/scene-graph'
import { runValidator } from '../canonical/validator/run-validator'
import { runQualityEngine, type QualityResult } from '../quality/qualityEngine'
import type { QualityInput } from '../quality/rules'
import type { ScanRoom, ScanSurface } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three Stage-1 (Welcome) render branches (Implementation-Spec §Stage-1):
 *
 *   - `ok`            : clean scene → green Quality-Card + "Weiter zu Maße".
 *   - `warnings`      : renderable but the validator flagged issues → yellow
 *     warning banner + "Weiter (du kannst korrigieren)" + "Neuen Scan starten".
 *   - `unrenderable`  : the renderer cannot draw the scene (no floor / <3 walls)
 *     → red block, ONLY "Neuen Scan starten", NO forward path.
 */
export type VerifyValidationPath = 'ok' | 'warnings' | 'unrenderable'

/** One human-readable hint surfaced in the Stage-1 warning banner. */
export interface VerifySummaryHint {
  /** Stable code (mirrors `ValidationCode` / quality warning) for testing. */
  code: string
  /** German one-line hint shown in the banner. */
  message: string
}

/**
 * Element counts shown on the Stage-1 Welcome overview. Derived from the
 * resolved scene-graph — doors / windows are the wall openings split by type.
 */
export interface VerifySceneCounts {
  walls: number
  doors: number
  windows: number
  /** Free-standing + floor/ceiling/wall-mounted objects (e.g. WC, sink). */
  objects: number
}

/**
 * The full Stage-1 sanity-check payload. The single object the VerifySheet's
 * Welcome stage renders.
 */
export interface VerifySceneSummary {
  /** Element counts for the overview list. */
  counts: VerifySceneCounts
  /** Simplified quality (VF-1) — score 0-100 + bucket label. */
  quality: QualityResult
  /** German label for the bucket (e.g. "Gut", "Ausreichend"). */
  qualityLabel: string
  /** Which of the three Stage-1 branches to render. */
  path: VerifyValidationPath
  /** Hints for the warning banner — empty unless `path === 'warnings'`. */
  hints: VerifySummaryHint[]
  /** Whether the customer may proceed to Stage 2 (false on `unrenderable`). */
  canProceed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Quality-engine projection
// ─────────────────────────────────────────────────────────────────────────────

/** German label per quality bucket — drives the Welcome Quality-Card. */
const BUCKET_LABEL: Record<QualityResult['bucket'], string> = {
  excellent: 'Sehr gut',
  good: 'Gut',
  fair: 'Ausreichend',
  poor: 'Niedrig',
}

/**
 * German one-liner per canonical quality-warning code — surfaced in the
 * Stage-1 warning banner. Kept here (not in the quality module) because it is
 * verify-flow-specific copy, not engine output.
 */
const QUALITY_WARNING_HINT: Record<string, string> = {
  too_few_walls: 'Es wurden weniger als vier Wände erkannt.',
  area_implausible: 'Die Raumfläche wirkt unplausibel.',
  ceiling_implausible: 'Die Deckenhöhe wirkt unplausibel.',
  wall_coverage_low: 'Ein Teil der Wände wurde nur lückenhaft erfasst.',
  low_confidence: 'Eine oder mehrere Flächen haben niedrige Erkennungssicherheit.',
  door_dimensions_unusual: 'Eine Tür hat ungewöhnliche Maße.',
  window_dimensions_unusual: 'Ein Fenster hat ungewöhnliche Maße.',
}

/**
 * Project a canonical {@link RoomScene} onto the quality-engine's
 * {@link QualityInput}. The engine was authored for the Block-A scan-capture
 * data shape (`ScanRoom` / `ScanSurface`); the canonical model carries the
 * same physical facts in a different layout, so this is a faithful re-mapping,
 * NOT a re-derivation of the score.
 *
 * `meshSummary` is omitted on purpose — the canonical scene has no mesh-
 * coverage aggregate; the engine's mesh-dependent rules (`wall_coverage_low`)
 * then silently fall through (Plan B), exactly as documented in `rules.ts`.
 * `low_confidence` still fires via the per-surface `confidence` fallback.
 */
export function sceneToQualityInput(scene: RoomScene): QualityInput {
  const room: ScanRoom = {
    id: scene.id,
    scanId: scene.id,
    name: scene.name ?? null,
    areaM2Estimated: scene.computed_area_m2 || null,
    areaM2Verified: null,
    ceilingHEstimated: scene.ceiling?.height_m || null,
    ceilingHVerified: null,
    floorAnchor: null,
    createdAt: 0,
    updatedAt: 0,
  }

  const surfaces: ScanSurface[] = []

  // Walls — one surface row each; confidence carried through so the engine's
  // `low_confidence` fallback rule can still fire without a mesh summary.
  scene.walls.forEach((wall, i) => {
    surfaces.push({
      id: wall.id,
      roomId: scene.id,
      surfaceExternalId: `wall-${i}`,
      kind: 'wall',
      dimWEstimated: wall.length_m || null,
      dimHEstimated: wall.height_m || null,
      dimWVerified: null,
      dimHVerified: null,
      transform: null,
      status: 'estimated_roomplan',
      confidence: wall.confidence,
      createdAt: 0,
      updatedAt: 0,
    })
  })

  // Doors + windows — the wall openings split by type.
  let openingIdx = 0
  for (const wall of scene.walls) {
    for (const opening of wall.openings) {
      if (opening.type === 'opening') continue
      surfaces.push({
        id: opening.id,
        roomId: scene.id,
        surfaceExternalId: `opening-${openingIdx}`,
        kind: opening.type,
        dimWEstimated: opening.width_m || null,
        dimHEstimated: opening.height_m || null,
        dimWVerified: null,
        dimHVerified: null,
        transform: null,
        status: 'estimated_roomplan',
        confidence: opening.confidence,
        createdAt: 0,
        updatedAt: 0,
      })
      openingIdx += 1
    }
  }

  return { rooms: [room], surfaces, measurements: [] }
}

// ─────────────────────────────────────────────────────────────────────────────
// Count derivation
// ─────────────────────────────────────────────────────────────────────────────

/** Count walls / doors / windows / objects on a resolved scene-graph. */
export function deriveSceneCounts(scene: RoomScene): VerifySceneCounts {
  let doors = 0
  let windows = 0
  for (const wall of scene.walls) {
    for (const opening of wall.openings) {
      if (opening.type === 'door') doors += 1
      else if (opening.type === 'window') windows += 1
    }
  }
  const objects =
    scene.free_objects.length +
    scene.floor.floor_mounted.length +
    scene.ceiling.ceiling_mounted.length +
    scene.walls.reduce((acc, w) => acc + w.wall_mounted.length, 0)

  return { walls: scene.walls.length, doors, windows, objects }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the full Stage-1 sanity-check {@link VerifySceneSummary} for a
 * resolved canonical scene.
 *
 * `null` scene ⇒ the scene never resolved → treated as `unrenderable` with a
 * zero score, so the Welcome stage shows the red re-scan block instead of
 * crashing on a missing scene.
 */
export function deriveVerifySceneSummary(scene: RoomScene | null): VerifySceneSummary {
  if (!scene) {
    return {
      counts: { walls: 0, doors: 0, windows: 0, objects: 0 },
      quality: { score: 0, bucket: 'poor', warnings: [], engineVersion: 'v1.0.0' },
      qualityLabel: BUCKET_LABEL.poor,
      path: 'unrenderable',
      hints: [
        {
          code: 'SCENE_MISSING',
          message: 'Der Scan konnte nicht geladen werden.',
        },
      ],
      canProceed: false,
    }
  }

  const counts = deriveSceneCounts(scene)
  const quality = runQualityEngine(sceneToQualityInput(scene))
  const report = runValidator(scene)

  let path: VerifyValidationPath
  if (!report.is_renderable) {
    path = 'unrenderable'
  } else if (report.errors.length > 0 || report.warnings.length > 0) {
    path = 'warnings'
  } else {
    path = 'ok'
  }

  // Hints — only meaningful for the `warnings` / `unrenderable` banner. The
  // validator's authored `message`s are precise; the quality warnings add the
  // verify-flow-specific copy.
  const hints: VerifySummaryHint[] = []
  if (path !== 'ok') {
    for (const issue of report.errors) {
      hints.push({ code: issue.code, message: issue.message })
    }
    for (const issue of report.warnings) {
      hints.push({ code: issue.code, message: issue.message })
    }
    for (const w of quality.warnings) {
      const message = QUALITY_WARNING_HINT[w]
      if (message && !hints.some((h) => h.code === w)) {
        hints.push({ code: w, message })
      }
    }
  }

  return {
    counts,
    quality,
    qualityLabel: BUCKET_LABEL[quality.bucket],
    path,
    hints,
    canProceed: path !== 'unrenderable',
  }
}
