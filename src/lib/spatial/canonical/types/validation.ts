/**
 * Spatial · Canonical · Validation
 *
 * Master-Spec §9. The scene-validator inspects a `RoomScene` and produces a
 * `ValidationReport` of errors, warnings, and hints. Validator is invoked
 * after import, after each edit, and before quote generation.
 *
 * Risk R7 (binding mitigation): the report carries TWO independent flags:
 *
 *   - `is_renderable`               : graceful · true whenever floor + ≥3 walls exist
 *   - `requires_user_confirmation`  : strict · true whenever any error is present
 *
 * Per Master-Spec §19 Decision #5 ("graceful + warning-banner"), rendering is
 * NEVER hard-blocked; the user is warned via a banner overlay instead. Quote
 * / BoM generation, however, gates on `requires_user_confirmation === false`.
 */

import type { ISO8601 } from './scene-graph.ts'

/**
 * Severity tiers. Errors block quote/BoM/export workflows; warnings annotate
 * the rendering; hints are optimisation suggestions surfaced in dev-mode.
 */
export type ValidationSeverity = 'error' | 'warning' | 'hint'

/**
 * Stable error-code identifier — exported as a string-union so consumers
 * can `switch` on it exhaustively without an enum. Keep this list aligned
 * with the actual rules in `validator/rules/*.ts` (Day 4 A14-A15).
 *
 * Mirrors DB CHECK constraint that will live in
 * `supabase/migrations/20260527000001_spatial_canonical_scenes.sql` (Day 6 B1).
 */
export type ValidationCode =
  // ── Wall rules (Day 4 A14) ────────────────────────────────────────────
  | 'WALL_HEIGHT_MISSING'
  | 'WALL_ZERO_LENGTH'
  | 'WALL_HEIGHT_UNUSUAL'
  | 'WALL_THICKNESS_DEFAULT_USED'
  | 'WALL_NEEDS_MATERIAL'
  // ── Wall-join rules (Zwischen-Latte · corners-edges-design §2.7) ───────
  | 'WALL_JOIN_GAP_LARGE'
  | 'WALL_JOIN_AMBIGUOUS'
  | 'WALL_TOO_SHORT_FOR_JOIN'
  | 'WALL_DUPLICATE_SUSPECTED'
  | 'OPENING_TOO_CLOSE_TO_CORNER'
  // ── Opening rules (Day 4 A15) ─────────────────────────────────────────
  | 'DOOR_OUTSIDE_WALL_BOUNDS'
  | 'DOOR_HOST_WALL_NOT_FOUND'
  | 'DOOR_HOST_WALL_AMBIGUOUS'
  | 'WINDOW_OUTSIDE_WALL_BOUNDS'
  | 'WINDOW_BELOW_FLOOR'
  | 'WINDOW_ABOVE_CEILING'
  // ── Object rules (Day 4 A15) ──────────────────────────────────────────
  | 'OBJECT_OUTSIDE_ROOM_BOUNDS'
  | 'OBJECT_HOST_NOT_FOUND'
  | 'OBJECT_FLOATING'
  | 'OBJECT_CLIPPING'
  | 'OBJECT_CLEARANCE_VIOLATED'
  // ── Pin rules (Day 4 A15) ─────────────────────────────────────────────
  | 'PIN_ANCHOR_NOT_FOUND'
  | 'PIN_OFF_SURFACE'
  // ── Room rules (Day 4 A15) ────────────────────────────────────────────
  | 'ROOM_NO_FLOOR'
  | 'ROOM_NO_WALLS'
  | 'ROOM_BOUNDS_TOO_SMALL'
  | 'ROOM_HAS_NO_DOORS'
  | 'ROOM_NO_CEILING'
  | 'ROOM_NO_WINDOWS'
  | 'ROOMS_NOT_CONNECTED'
  // ── Floor topology rules (Day 4 A15) ──────────────────────────────────
  | 'FLOOR_POLYGON_NOT_CLOSED'
  | 'FLOOR_SELF_INTERSECTING'
  // ── Scan provenance (Day 4 A15) ───────────────────────────────────────
  | 'SCAN_CONFIDENCE_LOW'

/**
 * One validation finding. Severity drives the bucket the issue lands in on
 * the report (`errors` / `warnings` / `hints`); `code` is a stable
 * identifier so UI can map it to a localized message; `message` carries the
 * authored fallback string in case localization is missing.
 */
export interface ValidationIssue {
  code: ValidationCode
  severity: ValidationSeverity
  /** Node-ids affected by this issue (used for in-renderer highlighting). */
  affected_node_ids: string[]
  /** Authored fallback message. UI may swap for localised string by `code`. */
  message: string
  /** Optional copy describing the recommended fix. */
  suggested_fix?: string
}

/**
 * Aggregate report produced by `validator/run-validator.ts` (Day 4 A16).
 *
 * `is_renderable` is permissive (true whenever the scene has a floor and
 * ≥3 walls) so the renderer never falls off a cliff; instead the UI shows
 * a warning banner when `requires_user_confirmation === true`.
 *
 * `is_walkable` is a stricter flag: it is true only when the room geometry
 * is sound enough that the walk-mode camera can be placed inside without
 * immediate collision (i.e. no missing height / wall-height-unusual issues).
 *
 * `requires_user_confirmation` blocks quote/BoM generation per Decision #5.
 */
export interface ValidationReport {
  scene_id: string
  validated_at: ISO8601
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  hints: ValidationIssue[]
  /** Permissive flag — drives the renderer banner. */
  is_renderable: boolean
  /** Strict flag — drives walk-mode availability. */
  is_walkable: boolean
  /** Strict flag — drives quote-generation gate per Decision #5. */
  requires_user_confirmation: boolean
}

/**
 * Initial value of a fresh report before any rules have run. Helper for
 * tests and the orchestrator's reduce-initializer.
 */
export function emptyValidationReport(scene_id: string, validated_at: ISO8601): ValidationReport {
  return {
    scene_id,
    validated_at,
    errors: [],
    warnings: [],
    hints: [],
    is_renderable: false,
    is_walkable: false,
    requires_user_confirmation: false,
  }
}
