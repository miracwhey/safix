/**
 * Spatial · Canonical · Validator · Per-Move Validation Types (Phase 2 · Block 2.5)
 *
 * The result surface of {@link import('./validate-component-move.ts').validateComponentMove}
 * — the INCREMENTAL pre-apply constraint check. This is distinct from
 * `run-validator.ts`, which validates the WHOLE scene post-apply.
 *
 * Three outcomes per Master-Spec §8:
 *   - Hard-Reject (§8.1) : `ok === false`, an {@link ConstraintError} explains
 *     why; the command MUST NOT be applied. `editHistoryStore.apply()` gates on
 *     this — a rejected command never reaches the undo stack and never writes
 *     an override.
 *   - Soft-Warn  (§8.2) : `ok === true`, the edit is allowed, but `warnings`
 *     carries one {@link ConstraintWarning} per soft-constraint that was
 *     violated. The Confirm-Toast UI (Block 2.9-2.12) consumes these.
 *   - Auto-Snap  (§8.3) : `ok === true` plus a `correctedTransform` /
 *     `correctedPosition` the caller SHOULD adopt before applying the command
 *     (snap-to-wall, snap-to-floor, 15°-rotation snap, ...).
 *
 * Layer: pure L1 — no three.js / React / DOM.
 *
 * Code naming: constraint codes reuse the `run-validator.ts` rule-code style
 * (SCREAMING_SNAKE, domain-prefixed) so the move-validator and the scene-
 * validator stay consistent for any UI that maps a code → localized message.
 * The pre-apply codes are a SEPARATE union ({@link ConstraintCode}) from the
 * post-apply {@link import('../types/validation.ts').ValidationCode} because
 * they describe an *edit* being rejected, not a *scene* being unsound.
 */

import type { Transform, Vector3 } from '../types/primitives.ts'
import type { EditOperationKind } from '../types/commands.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Hard-Reject codes (Master-Spec §8.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable code identifying WHY a {@link validateComponentMove} call hard-rejected
 * an edit. Each maps to one Master-Spec §8.1 hard-constraint.
 */
export type ConstraintErrorCode =
  /** A `move_node` (or any transform edit) was attempted on a Wall. Walls are immovable. */
  | 'WALL_IMMOVABLE'
  /** The edit targets a node id that does not exist in the resolved scene. */
  | 'NODE_NOT_FOUND'
  /** A door / opening would extend past its host wall's length. */
  | 'DOOR_OUTSIDE_WALL'
  /** A door / window references a host wall id that no longer exists. */
  | 'DOOR_HOST_WALL_MISSING'
  /** A window would extend above its host wall's height. */
  | 'WINDOW_ABOVE_WALL'
  /** A window's sill sits below the floor (negative offset). */
  | 'WINDOW_BELOW_FLOOR'
  /** A floor-hosted object was moved off the floor plane (y !== 0). */
  | 'FLOOR_OBJECT_OFF_PLANE'
  /** A wall-hosted object was moved off its host wall's surface plane. */
  | 'WALL_OBJECT_OFF_PLANE'
  /** An object's footprint was moved outside the room bounding box (AABB). */
  | 'OUTSIDE_ROOM_BOUNDS'
  /** An object's footprint geometrically interpenetrates another object's footprint. */
  | 'OBJECT_OVERLAP'
  /** A pin was re-anchored to a surface id that does not exist. */
  | 'PIN_ANCHOR_MISSING'
  /** A pin's UV coordinate is outside the [0,1]² range. */
  | 'PIN_UV_OUT_OF_RANGE'
  /** A resize / room-height edit produced a non-positive or non-finite dimension. */
  | 'INVALID_DIMENSION'

/**
 * A hard-constraint violation. When present on a {@link MoveValidationResult},
 * `ok` is `false` and the edit MUST be rejected.
 */
export interface ConstraintError {
  /** Stable machine-readable reason. */
  code: ConstraintErrorCode
  /** Node ids the violation concerns (for in-renderer highlighting). */
  affected_node_ids: string[]
  /** Authored fallback message — UI may swap for a localized string by `code`. */
  message: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft-Warn codes (Master-Spec §8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable code identifying a soft-constraint that the edit violates. The edit
 * is still ALLOWED — the warning is surfaced to the user via the Confirm-Toast.
 */
export type ConstraintWarningCode =
  /** Two objects sit inside each other's clearance zone. */
  | 'OBJECT_CLEARANCE_VIOLATED'
  /** A wall-mounted object sits too close to a wall corner. */
  | 'WALL_OBJECT_NEAR_CORNER'
  /** Furniture sits in the swing/pass-through path of a door. */
  | 'DOOR_BLOCKED_BY_OBJECT'
  /** A door sits within 0.2 m of a wall corner. */
  | 'DOOR_NEAR_CORNER'
  /** A window sill sits below 0.3 m from the floor. */
  | 'WINDOW_SILL_TOO_LOW'

/**
 * A soft-constraint violation. The edit is allowed; the UI should surface this
 * (Confirm-Toast in Block 2.9-2.12) so the user can knowingly proceed or
 * revert.
 */
export interface ConstraintWarning {
  /** Stable machine-readable reason. */
  code: ConstraintWarningCode
  /** Node ids the warning concerns. */
  affected_node_ids: string[]
  /** Authored fallback message — UI may swap for a localized string by `code`. */
  message: string
}

// ─────────────────────────────────────────────────────────────────────────────
// MoveValidationResult — the validator return shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of {@link validateComponentMove}.
 *
 * Discriminate on `ok`:
 *   - `ok === false` : `error` is always set; `correctedTransform` /
 *     `correctedPosition` are never set; `warnings` may still carry context
 *     warnings but the edit is rejected outright.
 *   - `ok === true`  : `error` is never set. `warnings` may be non-empty
 *     (soft-warns). `correctedTransform` / `correctedPosition` may be set when
 *     auto-snap nudged the edit — the caller SHOULD adopt the corrected value.
 */
export interface MoveValidationResult {
  /** `false` ⇒ hard-reject (do not apply). `true` ⇒ apply (possibly snapped). */
  ok: boolean
  /** The hard-constraint violation — present iff `ok === false`. */
  error?: ConstraintError
  /** A short German hint for the UI (mirrors Edit-Spec §2.5 `hint`). */
  hint?: string
  /**
   * Auto-snap corrected transform. Present only when the operation carries a
   * full transform (`move_node` / `snap_object`) and snap nudged it. The
   * caller replaces the operation's transform with this before applying.
   */
  correctedTransform?: Transform
  /**
   * Auto-snap corrected position — present when only a position (not the full
   * transform) was nudged. For transform-carrying ops `correctedTransform`
   * supersedes this; this field exists for callers that work in raw positions
   * (Edit-Spec §2.5 names the field `position`).
   */
  correctedPosition?: Vector3
  /** Soft-constraint violations — empty when the edit is clean. */
  warnings: ConstraintWarning[]
}

/**
 * Build an `ok: false` hard-reject result. Centralised so every reject path
 * produces the same shape.
 */
export function hardReject(
  code: ConstraintErrorCode,
  affectedNodeIds: string[],
  message: string,
  hint?: string,
): MoveValidationResult {
  return {
    ok: false,
    error: { code, affected_node_ids: affectedNodeIds, message },
    hint,
    warnings: [],
  }
}

/**
 * Build an `ok: true` accept result, optionally carrying soft-warnings + an
 * auto-snap correction.
 */
export function accept(params?: {
  warnings?: ConstraintWarning[]
  correctedTransform?: Transform
  correctedPosition?: Vector3
  hint?: string
}): MoveValidationResult {
  const result: MoveValidationResult = {
    ok: true,
    warnings: params?.warnings ?? [],
  }
  if (params?.correctedTransform) result.correctedTransform = params.correctedTransform
  if (params?.correctedPosition) result.correctedPosition = params.correctedPosition
  if (params?.hint) result.hint = params.hint
  return result
}

/**
 * `true` when any of `warnings` would require an explicit user confirmation
 * before the edit is committed. V1: every soft-warn requires confirmation
 * (Master-Spec §8.2 — "warn but allow"). Exposed as a headless helper so the
 * Confirm-Toast UI (Block 2.9-2.12) does not re-implement the policy.
 */
export function needsConfirm(warnings: ReadonlyArray<ConstraintWarning>): boolean {
  return warnings.length > 0
}

/**
 * The set of {@link EditOperationKind}s the per-move validator inspects. Edits
 * outside this set (e.g. `set_material`) carry no geometric constraint and are
 * accepted unconditionally — but the validator still routes them so the
 * `apply()` gate has one uniform entry point.
 */
export const GEOMETRIC_OPERATION_KINDS: ReadonlySet<EditOperationKind> = new Set<EditOperationKind>([
  'move_node',
  'resize_wall',
  'add_door',
  'add_pin',
  'snap_object',
  'move_pin',
  'set_room_height',
])
